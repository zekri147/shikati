// لقطات شاشات «شيكاتي» على مقاس الهاتف 390×844، في الوضعين الداكن والفاتح.
//
// يحتاج الخادم الوهمي وخادم التطوير يعملان (انظر «الاختبار قبل كل دفع» في CLAUDE.md)،
// ومستخدماً محلياً: zekri برمز TestPass123 (أو SHOTS_USER و SHOTS_PASS).
//
// الاستعمال:
//   node .claude/skills/shikati-ui/scripts/shots.cjs <مجلد-اللقطات> [اسم-شاشة ...]
// بلا أسماء تُلتقط كل الشاشات. الأسماء من المصفوفة SCREENS أدناه.
// العنوان الافتراضي http://localhost:8787 ويُغيَّر بـ SHOTS_BASE.

const { chromium } = require('playwright');
const fs = require('node:fs');

const BASE = process.env.SHOTS_BASE || 'http://localhost:8787';
const USER = process.env.SHOTS_USER || 'zekri';
const PASS = process.env.SHOTS_PASS || 'TestPass123';
const OUT = process.argv[2];
const ONLY = process.argv.slice(3);
if (!OUT) { console.error('حدد مجلد اللقطات'); process.exit(1); }
fs.mkdirSync(OUT, { recursive: true });

// معرّفات الشيكات من الخادم الوهمي scripts/dev/mock-zoho.mjs
const SCREENS = [
  { name: 'deposit', path: '/#cheques' },
  { name: 'deposit-selected', path: '/#cheques', act: async (p) => {
    await p.locator('.item.selectable').nth(0).click();
    await p.locator('.item.selectable').nth(1).click();
  }, full: false },
  { name: 'deposit-confirm', path: '/#cheques', act: async (p) => {
    await p.locator('.item.selectable').nth(0).click();
    await p.locator('.item.selectable').nth(1).click();
    await p.locator('.actionbar .btn-primary').click();
  }, full: false },
  { name: 'all', path: '/#cheques/all' },
  { name: 'alerts', path: '/#cheques/alerts' },
  { name: 'register', path: '/#cheques/new' },
  { name: 'detail', path: '/#cheques/c/7418400000000001' },
  { name: 'detail-endorsed', path: '/#cheques/c/7418400000000029' },
  { name: 'menu', path: '/#cheques', act: async (p) => { await p.locator('#menu-btn').click(); }, full: false },
  { name: 'admin', path: '/admin' },
  { name: 'help', path: '/help' },
];

(async () => {
  const browser = await chromium.launch();
  for (const theme of ['dark', 'light']) {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
    // بطاقة الترحيب تظهر مرة واحدة عند أول دخول، فتُعلَّم كأنها شوهدت حتى لا تغطي الشاشات
    await ctx.addInitScript((t) => { try { localStorage.setItem('shikati-theme', t); localStorage.setItem('shikati-welcome-seen', '1'); } catch {} }, theme);
    const p = await ctx.newPage();
    await p.goto(BASE + '/login');
    if (!ONLY.length || ONLY.includes('login')) await p.screenshot({ path: `${OUT}/login-${theme}.png` });
    await p.fill('#username', USER);
    await p.fill('#password', PASS);
    await p.click('#login-btn');
    await p.waitForURL(BASE + '/');
    for (const s of SCREENS) {
      if (ONLY.length && !ONLY.includes(s.name)) continue;
      await p.goto('about:blank'); // تحميل جديد، حتى لا تبقى نافذة مفتوحة من اللقطة السابقة
      await p.goto(BASE + s.path);
      await p.waitForLoadState('networkidle');
      await p.waitForTimeout(600);
      if (s.act) { await s.act(p); await p.waitForTimeout(600); }
      const file = `${OUT}/${s.name}-${theme}.png`;
      await p.screenshot({ path: file, fullPage: s.full !== false });
      // فحص سريع لنص غريب ظاهر
      const bad = await p.evaluate(() => (document.body.innerText.match(/\b(null|undefined|NaN)\b/g) || []).length);
      console.log(file + (bad ? `  ← تنبيه: ${bad} نص غريب (null أو undefined أو NaN)` : ''));
    }
    await ctx.close();
  }
  await browser.close();
})().catch((e) => { console.error(e); process.exit(1); });
