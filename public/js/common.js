// أدوات مشتركة لكل الصفحات
(function () {
  const THEME_KEY = 'shikati-theme';

  function applyTheme(t) {
    document.documentElement.setAttribute('data-theme', t);
    // لون شريط المتصفح يطابق الشريط العلوي: أسود في الداكن، وأبيض في الفاتح
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', t === 'dark' ? '#1a1a1a' : '#ffffff');
    document.querySelectorAll('[data-theme-toggle]').forEach((b) => {
      const long = b.dataset.themeToggle === 'long';
      b.textContent = t === 'dark' ? (long ? 'الوضع الفاتح' : 'فاتح') : (long ? 'الوضع الداكن' : 'داكن');
      b.setAttribute('aria-label', t === 'dark' ? 'التبديل إلى الوضع الفاتح' : 'التبديل إلى الوضع الداكن');
    });
  }
  function storedTheme() {
    try { return localStorage.getItem(THEME_KEY) === 'light' ? 'light' : 'dark'; } catch { return 'dark'; }
  }
  function toggleTheme() {
    const next = document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
    try { localStorage.setItem(THEME_KEY, next); } catch { /* التخزين غير متاح */ }
    applyTheme(next);
  }
  applyTheme(storedTheme());
  document.addEventListener('DOMContentLoaded', () => {
    applyTheme(storedTheme());
    document.querySelectorAll('[data-theme-toggle]').forEach((b) => b.addEventListener('click', toggleTheme));
    setupMenu();
  });

  // قائمة الشريط العلوي: تُفتح بزر «القائمة»، وتُغلق بالضغط خارجها أو بزر الرجوع في الهاتف أو بمفتاح الهروب
  function setupMenu() {
    const btn = document.getElementById('menu-btn');
    const menu = document.getElementById('menu');
    if (!btn || !menu) return;
    const out = document.getElementById('logout');
    if (out) out.addEventListener('click', logout);
    // صفحتا الإدارة والمساعدة تقرآن المستخدم بنفسهما. صفحة المساعدة تُفتح قبل الدخول أيضاً،
    // فيختفي الاسم والخروج إن لم يكن هناك دخول.
    if (menu.hasAttribute('data-me')) {
      api('/api/me', { noRedirect: true }).then((me) => {
        const who = document.getElementById('who');
        if (who) who.textContent = me.user.display_name;
        const adm = document.getElementById('admin-link');
        if (adm && me.user.role === 'admin') adm.classList.remove('hidden');
      }).catch(() => { if (out) out.classList.add('hidden'); });
    }
    let open = false;
    const set = (v) => {
      open = v;
      menu.classList.toggle('hidden', !v);
      btn.setAttribute('aria-expanded', String(v));
    };
    const onPop = () => { if (open) set(false); };
    const close = () => {
      if (!open) return;
      if (history.state && history.state.menu) history.back(); else set(false);
    };
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (open) { close(); return; }
      set(true);
      history.pushState({ menu: true }, '');
      const first = menu.querySelector('.menu-item:not(.hidden)');
      if (first) first.focus();
    });
    window.addEventListener('popstate', onPop);
    document.addEventListener('click', (e) => { if (open && !menu.contains(e.target)) close(); });
    document.addEventListener('keydown', (e) => { if (open && e.key === 'Escape') { close(); btn.focus(); } });
    // تغيير الوضع يُبقي القائمة مفتوحة ليرى المستعمل النتيجة، وغيره يغلقها
    menu.addEventListener('click', (e) => {
      if (e.target.closest('[data-theme-toggle]')) return;
      if (e.target.closest('a')) { set(false); return; } // الرابط ينتقل بنفسه
      if (e.target.closest('.menu-item')) close();
    });
  }

  async function api(path, opts = {}) {
    const init = { method: opts.method || 'GET', credentials: 'same-origin', headers: {} };
    if (opts.body !== undefined) {
      init.headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(opts.body);
    }
    let res;
    try {
      res = await fetch(path, init);
    } catch {
      throw Object.assign(new Error('لا يوجد اتصال بالإنترنت. تحقق من الشبكة ثم حاول مجدداً.'), { status: 0 });
    }
    const data = await res.json().catch(() => ({}));
    if (res.status === 401 && !opts.noRedirect) {
      location.href = '/login';
      throw new Error(data.error || 'انتهت الجلسة.');
    }
    if (!res.ok) throw Object.assign(new Error(data.error || 'حدث خطأ غير متوقع.'), { status: res.status });
    return data;
  }

  // المبالغ بفاصل مسافة للآلاف: 1 287 520.50 DA
  function fmtAmount(n) {
    if (n === null || n === undefined || Number.isNaN(Number(n))) return '—';
    const v = Number(n);
    const [whole, frac] = Math.abs(v).toFixed(2).split('.');
    const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
    return (v < 0 ? '-' : '') + grouped + (frac === '00' ? '' : '.' + frac) + ' DA';
  }
  function fmtDate(iso) {
    if (!iso) return '—';
    const [y, m, d] = iso.slice(0, 10).split('-');
    return `${d}/${m}/${y}`;
  }
  // وقت السجل مخزّن بتوقيت غرينتش؛ نعرضه بتوقيت الجزائر: DD/MM/YYYY HH:MM
  function fmtDateTime(utc) {
    const d = new Date(utc.replace(' ', 'T') + 'Z');
    if (Number.isNaN(d.getTime())) return utc;
    const parts = Object.fromEntries(new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Africa/Algiers', year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    }).formatToParts(d).map((x) => [x.type, x.value]));
    return `${parts.day}/${parts.month}/${parts.year} ${parts.hour}:${parts.minute}`;
  }
  function fmtTime(iso) {
    try {
      return new Intl.DateTimeFormat('fr-FR', { timeZone: 'Africa/Algiers', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(iso));
    } catch { return ''; }
  }

  // إنشاء عناصر بلا innerHTML حتى لا يُحقن أي نص قادم من زوهو كشيفرة
  function el(tag, attrs = {}, ...children) {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (v === undefined || v === null || v === false) continue;
      if (k === 'class') e.className = v;
      else if (k === 'text') e.textContent = v;
      else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
      else e.setAttribute(k, v === true ? '' : v);
    }
    for (const c of children.flat()) if (c !== null && c !== undefined && c !== false) e.append(c);
    return e;
  }
  const ltr = (text, cls = '') => el('bdi', { dir: 'ltr', class: ('ltr ' + cls).trim(), text });

  // رسالة قصيرة أسفل الشاشة تختفي وحدها
  function toast(message, kind = 'ok') {
    let host = document.getElementById('toast-host');
    if (!host) {
      host = el('div', { id: 'toast-host', class: 'toast-host', 'aria-live': 'polite' });
      document.body.append(host);
    }
    const t = el('div', { class: 'toast ' + kind, role: 'status', text: message });
    host.append(t);
    setTimeout(() => { t.classList.add('out'); setTimeout(() => t.remove(), 300); }, kind === 'ok' ? 3500 : 6000);
  }

  async function logout() {
    try { await api('/api/logout', { method: 'POST', body: {}, noRedirect: true }); } catch { /* نكمل */ }
    location.href = '/login';
  }

  // تسجيل عامل الخدمة لتثبيت التطبيق على الهاتف
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('/sw.js').catch(() => { /* التطبيق يعمل بدونه */ });
    });
  }

  window.Shikati = { api, toast, fmtAmount, fmtDate, fmtTime, fmtDateTime, el, ltr, logout };
})();
