// أدوات مشتركة لكل الصفحات
(function () {
  const THEME_KEY = 'shikati-theme';

  function applyTheme(t) {
    document.documentElement.setAttribute('data-theme', t);
    document.querySelectorAll('[data-theme-toggle]').forEach((b) => {
      b.textContent = t === 'dark' ? 'فاتح' : 'داكن';
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
  });

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
      throw new Error('لا يوجد اتصال بالإنترنت. تحقق من الشبكة ثم حاول مجدداً.');
    }
    const data = await res.json().catch(() => ({}));
    if (res.status === 401 && !opts.noRedirect) {
      location.href = '/login';
      throw new Error(data.error || 'انتهت الجلسة.');
    }
    if (!res.ok) throw new Error(data.error || 'حدث خطأ غير متوقع.');
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

  async function logout() {
    try { await api('/api/logout', { method: 'POST', body: {}, noRedirect: true }); } catch { /* نكمل */ }
    location.href = '/login';
  }

  window.Shikati = { api, fmtAmount, fmtDate, fmtTime, fmtDateTime, el, ltr, logout };
})();
