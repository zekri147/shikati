// عامل الخدمة: يحفظ ملفات الواجهة الثابتة فقط لتسريع الفتح.
// لا يحفظ أبداً بيانات الشيكات ولا الصفحات المحمية ولا أي طلب إلى /api.
// آخر البيانات للعرض الفوري تحفظها الواجهة نفسها (web/src/lib/cache.ts)، وتُحدَّث من الخادم عند كل فتح.
const VERSION = 'shikati-v54';
const STATIC = /^\/(assets|fonts|img|icons)\//;

self.addEventListener('install', () => self.skipWaiting());

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    for (const key of await caches.keys()) if (key !== VERSION) await caches.delete(key);
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== location.origin) return;

  // الملفات الثابتة: من الذاكرة فوراً، مع تحديثها في الخلفية
  if (STATIC.test(url.pathname)) {
    event.respondWith((async () => {
      const cache = await caches.open(VERSION);
      const cached = await cache.match(req);
      const network = fetch(req).then((res) => {
        if (res.ok) cache.put(req, res.clone());
        return res;
      }).catch(() => cached);
      return cached || network;
    })());
    return;
  }

  // الصفحات: من الشبكة دائماً، ورسالة واضحة عند انقطاع الاتصال
  if (req.mode === 'navigate') {
    event.respondWith(fetch(req).catch(() => new Response(
      '<!doctype html><html lang="ar" dir="rtl"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">' +
      '<title>ميداني</title><body style="margin:0;background:#1a1a1a;color:#f2f2f2;font-family:Tahoma,sans-serif;display:flex;min-height:100vh;align-items:center;justify-content:center;text-align:center;padding:16px">' +
      '<div><h1 style="font-size:20px">لا يوجد اتصال بالإنترنت</h1><p>ميداني يحتاج الإنترنت ليعرض الأرقام الحقيقية من زوهو. تحقق من الشبكة ثم أعد المحاولة.</p></div></body></html>',
      { headers: { 'Content-Type': 'text/html; charset=utf-8' } },
    )));
  }
});

// إشعارات الهاتف (src/push.ts): الخادم يرسل النص مشفّراً لهذا الهاتف وحده، والمتصفح يفك تشفيره قبل هذا الحدث.
self.addEventListener('push', (event) => {
  let d = {};
  try { d = event.data ? event.data.json() : {}; } catch { d = { body: event.data ? event.data.text() : '' }; }
  event.waitUntil(self.registration.showNotification(d.title || 'ميداني', {
    body: d.body || '',
    tag: d.tag || undefined,
    renotify: !!d.tag,
    icon: '/icons/icon-192.png',
    badge: '/icons/badge-96.png',
    lang: 'ar',
    dir: 'rtl',
    data: { url: d.url || '/' },
  }));
});

// لمس الإشعار: يفتح التطبيق على الشيك أو الشاشة المقصودة، في النافذة المفتوحة إن وُجدت
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target = new URL((event.notification.data && event.notification.data.url) || '/', self.location.origin);
  if (target.origin !== self.location.origin) return;
  event.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const win = wins.find((w) => new URL(w.url).pathname === target.pathname) || wins.find((w) => new URL(w.url).origin === target.origin);
    if (win) {
      await win.focus();
      // الصفحة نفسها: تغيير العنوان بعد # يكفي، دون إعادة تحميل (page.tsx يستقبل الرسالة)
      if (new URL(win.url).pathname === target.pathname) win.postMessage({ type: 'open', hash: target.hash });
      else if ('navigate' in win) await win.navigate(target.href);
      return;
    }
    await self.clients.openWindow(target.href);
  })());
});
