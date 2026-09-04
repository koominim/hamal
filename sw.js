// sw.js — Service Worker לחמ"ל משפחתי
// תפקיד יחיד: לקבל push מהבוט ולהציג התראה. שום caching של הדף עצמו —
// הלוח מציג נתונים חיים מסופאבייס, וקאש היה מסוכן יותר משהוא מועיל.

self.addEventListener("install", (e) => {
  self.skipWaiting();
});

self.addEventListener("activate", (e) => {
  e.waitUntil(self.clients.claim());
});

self.addEventListener("push", (e) => {
  let data = {};
  try {
    data = e.data ? e.data.json() : {};
  } catch (err) {
    data = { title: "חמ\"ל משפחתי", body: e.data ? e.data.text() : "" };
  }
  const title = data.title || "חמ\"ל משפחתי";
  const options = {
    body: data.body || "",
    icon: "./icon-192.png",
    badge: "./icon-192.png",
    dir: "rtl",
    lang: "he",
    // תגית משותפת = שתי הודעות רצופות מתמזגות לאחת במקום להערים על המסך
    tag: data.tag || "hamal",
    data: { url: data.url || "./" },
  };
  e.waitUntil(self.registration.showNotification(title, options));
});

// לחיצה על ההתראה מביאה טאב קיים לחזית במקום לפתוח כפול
self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  const url = (e.notification.data && e.notification.data.url) || "./";
  e.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((list) => {
      for (const c of list) {
        if ("focus" in c) return c.focus();
      }
      if (self.clients.openWindow) return self.clients.openWindow(url);
    }),
  );
});
