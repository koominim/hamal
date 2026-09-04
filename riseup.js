// ============================================================================
//  riseup.js — קריאת התמונה הפיננסית מרייזאפ
//
//  רייזאפ פרסמו MCP רשמי (github.com/riseup-oss/mcp). MCP הוא תקע שמאפשר
//  לאפליקציית AI לדבר עם שירות חיצוני — אבל לבוט שלנו כבר יש מוח והוא כבר
//  שרת, ולכן הוא קורא לאותו API ישירות. אותו מפתח, אותה הרשאה, בלי חלק
//  נוסף שיכול ליפול בשלוש בלילה.
//
//  ⚠️ ההרשאה היא budget:read בלבד — קריאה. אין כאן, ולא תהיה, שום פעולה
//     שמזיזה כסף. זה גם הכלל הראשון של הבוט וגם מה שרייזאפ מאפשרים.
//
//  ⚠️ המפתח נשמר ב-bot_config, שיש עליו RLS בלי מדיניות — כלומר האפליקציה
//     בדפדפן לא יכולה לקרוא אותו, רק הבוט (service role). זה בכוונה.
// ============================================================================

const db = require("./db");

const API_BASE = (process.env.RISEUP_API_BASE || "https://input.riseup.co.il").replace(/\/+$/, "");
const TOKENS_URL = "https://input.riseup.co.il/developer/tokens";

// הפורמט לפי התיעוד: riseup_pat_ ואחריו 32 בתים ב-base64url (43 תווים).
// הטווח רחב בכוונה — עדיף לזהות מפתח תקין מהעתיד מאשר לפסול אותו.
const PAT_RE = /riseup_pat_[A-Za-z0-9_-]{20,120}/;

// רייזאפ קוצבים את המפתח ל-30 יום, בלי אפשרות להאריך ובלי רענון אוטומטי.
const TTL_DAYS = 30;
const WARN_AT_DAYS_LEFT = 5;

const TIMEOUT_MS = 20000;
// המכסה היא 1,000 ליום, ואנחנו רחוקים ממנה — אבל דשבורד שנפתח חמש פעמים
// ברצף לא צריך לשאול את רייזאפ חמש פעמים. חמש דקות זה טרי מספיק לכסף.
const CACHE_MS = 5 * 60 * 1000;

// --- שגיאה עם ניסוח מוכן לוואטסאפ -------------------------------------------
// kind מאפשר לקוד שקורא להחליט מה לעשות; human הוא מה שהמשפחה תראה.
class RiseupError extends Error {
  constructor(kind, human, detail) {
    super(detail || human);
    this.kind = kind;
    this.human = human;
  }
}

const errNoToken = () =>
  new RiseupError(
    "no_token",
    "עוד לא חיברנו את רייזאפ 🔌\nצרו מפתח כאן:\n" + TOKENS_URL +
      "\n(הרשאה: budget:read)\nושלחו לי אותו כאן בפרטי.",
  );

// תשובות אחרונות מרייזאפ, לפי הנתיב. מוצהר כאן כי saveToken מרוקן אותו.
const cache = new Map(); // path -> { at, data }

// --- המפתח ------------------------------------------------------------------
// נטען פעם אחת ונשמר בזיכרון. null = עוד לא נטען, false = נטען ואין מפתח.
let tokenCache = null;

async function loadToken() {
  if (tokenCache !== null) return tokenCache;
  const raw = await db.getConfig("riseup_pat");
  let rec = null;
  if (typeof raw === "string" && raw.trim()) {
    try {
      const p = JSON.parse(raw);
      if (p && p.pat) rec = { pat: p.pat, savedAt: p.savedAt || "" };
    } catch (e) {
      // ערך ישן שנשמר כמחרוזת חשופה — עדיין שמיש
      if (PAT_RE.test(raw)) rec = { pat: raw.trim(), savedAt: "" };
    }
  }
  tokenCache = rec || false;
  return tokenCache;
}

async function saveToken(pat) {
  const rec = { pat, savedAt: new Date().toISOString() };
  await db.setConfig("riseup_pat", JSON.stringify(rec));
  tokenCache = rec;
  cache.clear();
  // התראת התפוגה מתאפסת יחד עם המפתח, אחרת לא נזהיר על הבא בתור
  await db.setConfig("riseup_warned", "");
  return rec;
}

async function forgetToken() {
  await db.setConfig("riseup_pat", "");
  await db.setConfig("riseup_warned", "");
  tokenCache = false;
  cache.clear();
}

// מוצא מפתח בתוך הודעה. המשתמש עשוי להדביק אותו לבד או עם טקסט סביבו.
function extractPat(text) {
  const m = String(text || "").match(PAT_RE);
  return m ? m[0] : "";
}

// כמה ימים נשארו למפתח. null אם אין מפתח או שלא ידוע מתי נשמר.
function daysLeft(rec) {
  if (!rec || !rec.savedAt) return null;
  const born = Date.parse(rec.savedAt);
  if (isNaN(born)) return null;
  const used = (Date.now() - born) / 86400000;
  return Math.ceil(TTL_DAYS - used);
}

async function status() {
  const rec = await loadToken();
  if (!rec) return { connected: false, daysLeft: null, savedAt: "" };
  return { connected: true, daysLeft: daysLeft(rec), savedAt: rec.savedAt };
}

// --- הקריאה עצמה ------------------------------------------------------------
async function call(path, { fresh } = {}) {
  const rec = await loadToken();
  if (!rec) throw errNoToken();

  if (!fresh) {
    const hit = cache.get(path);
    if (hit && Date.now() - hit.at < CACHE_MS) return hit.data;
  }
  const data = await callWith(rec.pat, path);
  cache.set(path, { at: Date.now(), data });
  return data;
}

// הקריאה הגולמית, עם מפתח מפורש. אין כאן מטמון — הוא שייך ל-call.
async function callWith(pat, path) {
  const stop = new AbortController();
  const bell = setTimeout(() => stop.abort(), TIMEOUT_MS);
  let res;
  try {
    res = await fetch(API_BASE + path, {
      signal: stop.signal,
      method: "GET",
      headers: { Authorization: "Bearer " + pat, Accept: "application/json" },
    });
  } catch (e) {
    throw new RiseupError(
      "net",
      e.name === "AbortError"
        ? "רייזאפ לא ענו בזמן 🐌 ננסה שוב עוד רגע."
        : "לא הצלחתי להגיע לרייזאפ כרגע 😕",
      e.message,
    );
  } finally {
    clearTimeout(bell);
  }

  if (res.status === 401) {
    throw new RiseupError(
      "expired",
      "המפתח של רייזאפ כבר לא תקף 🔑\nהם מגבילים אותו ל-30 יום.\nצרו חדש כאן:\n" +
        TOKENS_URL + "\nושלחו לי אותו בפרטי.",
    );
  }
  if (res.status === 403) {
    throw new RiseupError(
      "forbidden",
      "למפתח חסרה ההרשאה budget:read 🔒\nצרו מפתח חדש עם ההרשאה הזו:\n" + TOKENS_URL,
    );
  }
  if (res.status === 429) {
    // התיעוד מזהיר במפורש מלולאת ניסיונות חוזרים — עוצרים ואומרים.
    const wait = parseInt(res.headers.get("retry-after") || "60", 10);
    throw new RiseupError(
      "rate",
      `שאלנו את רייזאפ יותר מדי פעמים ברצף ⏳ ננסה שוב בעוד ${Math.ceil(wait / 60) || 1} דקות.`,
    );
  }
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new RiseupError("http", "רייזאפ החזירו שגיאה 😕", `${res.status}: ${body.slice(0, 200)}`);
  }

  let data;
  try {
    data = await res.json();
  } catch (e) {
    throw new RiseupError("parse", "התשובה מרייזאפ לא הייתה קריאה 🤔", e.message);
  }

  return data;
}

// --- שתי הדלתות -------------------------------------------------------------

// date: "current" | "previous" | "YYYY-MM"
async function budget(date = "current", opts) {
  const d = String(date || "current");
  if (!/^(\d{4}-\d{2}|current|previous)$/.test(d)) {
    throw new RiseupError("input", `לא הבנתי לאיזה חודש (${d}).`);
  }
  return call(`/api/external/budget/${encodeURIComponent(d)}`, opts);
}

// חייבים לפחות cashflowMonth או transactionDate — businessName לבדו לא מספיק
async function transactions({ cashflowMonth, transactionDate, businessName } = {}, opts) {
  const q = new URLSearchParams();
  if (cashflowMonth) q.set("cashflowMonth", cashflowMonth);
  if (transactionDate) q.set("transactionDate", transactionDate);
  if (businessName) q.set("businessName", String(businessName).slice(0, 100));
  if (!cashflowMonth && !transactionDate) {
    throw new RiseupError("input", "צריך לפחות חודש או תאריך כדי לשלוף עסקאות.");
  }
  return call(`/api/external/transactions?${q.toString()}`, opts);
}

// בדיקת חיבור: קריאה אמיתית אחת, כדי לדעת שהמפתח באמת עובד ולא רק נראה תקין.
// pat אופציונלי — כך אפשר לבדוק מפתח *מועמד* לפני ששומרים אותו, ולא להחליף
// מפתח עובד במפתח שגוי רק כדי לגלות שהוא שגוי.
async function verify(pat) {
  const path = "/api/external/budget/current";
  const b = pat ? await callWith(pat, path) : await budget("current", { fresh: true });
  return {
    ok: true,
    month: (b && b.budgetDate) || "",
    envelopes: Array.isArray(b && b.envelopes) ? b.envelopes.length : 0,
  };
}

// ============================================================================
//  קריאת התמונה — כאן יושב הידע על *הצורה* של הנתונים אצל רייזאפ
//
//  ⚠️ התיעוד שלהם מפרט רק חלק מהשדות ואומר במפורש שהמבנה עוד עשוי להשתנות.
//     לכן כל שליפה כאן היא "קח את הראשון שקיים", וסכום שלא הצלחנו לחשב חוזר
//     כ-null ולא כאפס — אפס הוא מספר, ומספר שגוי גרוע מ"לא יודע".
// ============================================================================

const num = (v) => (typeof v === "number" && isFinite(v) ? v : null);
const first = (o, keys) => {
  for (const k of keys) {
    const v = o && o[k];
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return "";
};

const ils = (n) =>
  n === null ? "—" : "₪" + Math.round(Math.abs(n)).toLocaleString("he-IL");

// שם המעטפה. התיעוד מבטיח רק id, אבל בפועל יש שם קריא באחד מהשדות האלה.
function envName(e) {
  return first(e, ["name", "label", "title", "envelopeName", "categoryLabel",
                   "sequenceCustomerComment", "id"]) || "ללא שם";
}

const INCOME_TYPES = { variableIncome: 1, fixedIncome: 1 };
function isIncome(e) {
  if (INCOME_TYPES[e && e.type]) return true;
  const a = num(e && e.originalAmount);
  return a !== null && a > 0;
}

// כמה תוכנן וכמה באמת יצא במעטפה אחת
function envAmounts(e) {
  const planned = num(e.originalAmount);
  let spent = null;
  const txns = Array.isArray(e.transactions) ? e.transactions
             : Array.isArray(e.actuals) ? e.actuals : null;
  if (txns) {
    spent = txns.reduce((s, t) => {
      const v = num(t.billingAmount) ?? num(t.incomeAmount) ?? num(t.amount) ?? num(t.originalAmount);
      return v === null ? s : s + Math.abs(v);
    }, 0);
  } else {
    const b = num(e.balancedAmount);
    if (b !== null) spent = Math.abs(b);
  }
  return { planned: planned === null ? null : Math.abs(planned), spent };
}

// התמונה כולה, מוכנה להצגה. המספרים מחושבים כאן בקוד — לא במודל.
function summarize(b) {
  const envs = Array.isArray(b && b.envelopes) ? b.envelopes : [];
  const out = { month: (b && b.budgetDate) || "", income: 0, planned: 0, spent: 0, rows: [], partial: false };

  for (const e of envs) {
    const { planned, spent } = envAmounts(e);
    if (planned === null && spent === null) { out.partial = true; continue; }
    if (isIncome(e)) { out.income += planned ?? spent ?? 0; continue; }
    out.planned += planned ?? 0;
    out.spent += spent ?? 0;
    if (planned === null || spent === null) out.partial = true;
    out.rows.push({
      name: envName(e),
      planned,
      spent,
      // כמה מהמעטפה כבר נגמר. null כשאין תקציב להשוות אליו.
      used: planned && spent !== null ? spent / planned : null,
    });
  }

  out.left = out.planned - out.spent;
  out.rows.sort((a, b2) => (b2.spent ?? 0) - (a.spent ?? 0));
  return out;
}

// כלי אבחון: אילו שדות באמת מגיעים מרייזאפ — **שמות בלבד, בלי ערכים**.
// זה מה שמאפשר להתאים את התצוגה לנתונים האמיתיים בלי לצטט מספרים בצ'אט.
function shape(b) {
  const envs = Array.isArray(b && b.envelopes) ? b.envelopes : [];
  const e = envs[0] || {};
  // מעטפה ריקה מעסקאות לא מלמדת כלום — מחפשים אחת עם תוכן, ובודקים גם
  // actuals וגם transactions כי לא ברור מראש איזה שם רייזאפ משתמשים בו.
  const withTxns =
    envs.find((x) => Array.isArray(x && x.actuals) && x.actuals.length) ||
    envs.find((x) => Array.isArray(x && x.transactions) && x.transactions.length);
  const txns = withTxns ? withTxns.actuals || withTxns.transactions : [];
  const t = txns[0] || null;

  const meta = b && b._meta;
  let metaShape = "—";
  if (Array.isArray(meta)) {
    metaShape = `מערך (${meta.length})` + (meta[0] ? ": " + Object.keys(meta[0]).join(", ") : "");
  } else if (meta && typeof meta === "object") {
    metaShape = Object.keys(meta).join(", ") || "אובייקט ריק";
  }

  return {
    top: Object.keys(b || {}),
    envelopes: envs.length,
    envelope: Object.keys(e),
    types: [...new Set(envs.map((x) => x && x.type).filter(Boolean))],
    transaction: t ? Object.keys(t) : [],
    meta: metaShape,
  };
}

module.exports = {
  summarize, shape, ils, envName,
  budget, transactions, verify, status,
  loadToken, saveToken, forgetToken, extractPat, daysLeft,
  RiseupError, TOKENS_URL, TTL_DAYS, WARN_AT_DAYS_LEFT,
};
