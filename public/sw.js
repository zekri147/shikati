// عامل الخدمة: يحفظ ملفات الواجهة الثابتة فقط لتسريع الفتح.
// لا يحفظ أبداً بيانات الشيكات ولا الصفحات المحمية ولا أي طلب إلى /api،
// فكل رقم يظهر يأتي من الخادم مباشرة.
const VERSION = 'shikati-v5';
const STATIC = /^\/(css|js|fonts|img|icons)\//;

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
      '<title>شيكاتي</title><body style="margin:0;background:#1a1a1a;color:#f2f2f2;font-family:Tahoma,sans-serif;display:flex;min-height:100vh;align-items:center;justify-content:center;text-align:center;padding:16px">' +
      '<div><h1 style="font-size:20px">لا يوجد اتصال بالإنترنت</h1><p>شيكاتي يحتاج الإنترنت ليعرض الأرقام الحقيقية من زوهو. تحقق من الشبكة ثم أعد المحاولة.</p></div></body></html>',
      { headers: { 'Content-Type': 'text/html; charset=utf-8' } },
    )));
  }
});
