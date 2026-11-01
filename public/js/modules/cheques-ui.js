// أدوات عرض مشتركة بين شاشات الشيكات: البطاقة، الأقسام، الصورة، والنصوص العربية
(function () {
  const { el, ltr, fmtAmount, fmtDate } = window.Shikati;
  const LATE_DAYS = 7;
  const LOCK_LABELS = { pending: 'الإيداع قيد التنفيذ', unknown: 'بانتظار التحقق', done: 'سُجّل إيداعه' };
  const STATUS_CLASS = {
    'في الحوزة': 'st-hand', 'مودع في البنك': 'st-bank', 'محصّل': 'st-done',
    'مظهّر لمورد': 'st-end', 'مرفوض': 'st-rej', 'مُعاد للعميل': 'st-other', 'شيك ضمان': 'st-other',
  };

  function daysText(n) {
    if (n === 0) return 'اليوم';
    if (n === 1) return 'منذ يوم';
    if (n === 2) return 'منذ يومين';
    if (n <= 10) return `منذ ${n} أيام`;
    return `منذ ${n} يوماً`;
  }

  // المدة حتى تاريخ الاستحقاق أو منذ حلوله
  function dueText(iso, today) {
    if (!iso || !today) return '';
    const n = Math.round((Date.parse(iso + 'T00:00:00Z') - Date.parse(today + 'T00:00:00Z')) / 86_400_000);
    if (Number.isNaN(n)) return '';
    if (n === 0) return 'يستحق اليوم';
    if (n < 0) return 'حلّ استحقاقه ' + daysText(-n);
    if (n === 1) return 'يستحق غداً';
    if (n === 2) return 'يستحق بعد يومين';
    if (n <= 10) return `يستحق بعد ${n} أيام`;
    return `يستحق بعد ${n} يوماً`;
  }

  function relTime(ts) {
    const m = Math.floor((Date.now() - ts) / 60_000);
    if (m < 1) return 'الآن';
    if (m === 1) return 'منذ دقيقة';
    if (m === 2) return 'منذ دقيقتين';
    if (m <= 10) return `منذ ${m} دقائق`;
    if (m < 60) return `منذ ${m} دقيقة`;
    return 'منذ أكثر من ساعة';
  }

  const norm = (s) => String(s || '').toLowerCase().replace(/\s+/g, ' ').trim();
  const sum = (items) => Math.round(items.reduce((s, c) => s + c.amount, 0) * 100) / 100;
  // عدد الشيكات بصيغة عربية سليمة: رفعاً (شيكان) أو جرّاً بعد «إيداع» (شيكين)
  const chequeWord = (n, gen = false) => {
    if (n === 1) return 'شيك واحد';
    if (n === 2) return gen ? 'شيكين' : 'شيكان';
    if (n <= 10) return `${n} شيكات`;
    return `${n} شيكاً`;
  };

  const statusBadge = (s) => el('span', { class: 'badge ' + (STATUS_CLASS[s] || 'st-other'), text: s || 'بلا حالة' });
  const detailHash = (id) => '#cheques/c/' + encodeURIComponent(id);
  const openDetail = (id) => { location.hash = detailHash(id); };

  // ——— بطاقة الشيك ———
  // opts: selectable وselected وonToggle للتحديد، أو link لفتح التفاصيل بالضغط،
  // وshowStatus وnoAge وageInHandOnly وshowDue وtoday وnote لنص تنبيه تحت البطاقة.
  function chequeItem(c, opts) {
    // ageInHandOnly: عمر الشيك يهم ما دام في الحوزة فقط
    const noAge = opts.noAge || (opts.ageInHandOnly && c.status !== 'في الحوزة');
    const late = c.days > LATE_DAYS && !noAge;
    const selectable = opts.selectable && !c.lock;
    const selected = selectable && opts.selected.has(c.id);
    const tag = (k, v) => el('span', { class: 'tag' }, el('span', { class: 'k', text: k }), v);

    const detailBtn = opts.selectable
      ? el('a', { class: 'detail-link', href: detailHash(c.id), text: 'التفاصيل', onclick: (e) => e.stopPropagation() })
      : null;
    const li = el('li', { class: 'item' + (selectable ? ' selectable' : '') + (selected ? ' selected' : '') + (opts.link ? ' linkable' : '') },
      el('div', { class: 'item-main' },
        el('div', { class: 'customer' },
          selectable ? el('span', { class: 'check', 'aria-hidden': 'true' }) : null,
          el('span', { text: c.customer })),
        el('div', { class: 'amount' }, ltr(fmtAmount(c.amount), 'num'))),
      el('div', { class: 'item-sub' },
        el('div', { class: 'tags' },
          tag('شيك', c.cheque_number ? ltr(c.cheque_number, 'num') : el('span', { text: 'غير مسجّل' })),
          tag('استلام', ltr(fmtDate(c.date), 'num')),
          opts.showDue && c.due_date ? tag('استحقاق', ltr(fmtDate(c.due_date), 'num')) : null,
          c.location ? el('span', { class: 'tag', text: c.location }) : null,
          opts.showStatus ? statusBadge(c.status) : null),
        noAge ? null : el('span', { class: 'age' + (late ? ' late' : ''), text: daysText(c.days) + (late ? ' · متأخر' : '') })),
      opts.note ? el('div', { class: 'item-note', text: opts.note }) : null,
      opts.selectable
        ? el('div', { class: 'item-action' },
          c.lock ? el('span', { class: 'badge lock-' + c.lock, text: LOCK_LABELS[c.lock] || c.lock }) : el('span'),
          detailBtn)
        : null,
    );

    if (selectable || opts.link) {
      const act = selectable ? () => opts.onToggle(c) : () => openDetail(c.id);
      if (selectable) {
        li.setAttribute('role', 'checkbox');
        li.setAttribute('aria-checked', String(selected));
      } else {
        li.setAttribute('role', 'link');
        li.setAttribute('aria-label', `تفاصيل شيك ${c.customer}`);
      }
      li.tabIndex = 0;
      li.addEventListener('click', act);
      li.addEventListener('keydown', (e) => {
        if (e.target !== li) return;
        if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); act(); }
      });
    }
    return li;
  }

  function meta(items, hideTotal) {
    if (!items.length || hideTotal) return null;
    return el('span', { class: 'meta' }, ltr(fmtAmount(sum(items)), 'num'));
  }

  function head(tag, title, items, hideTotal) {
    return el(tag, { class: 'block-head' },
      el('h2', {}, el('span', { text: title }), el('span', { class: 'count', text: String(items.length) })),
      meta(items, hideTotal));
  }

  // قسم ثابت أو مطوي. القسم المطوي يتذكر حالته أثناء الجلسة.
  // opts.noteFor(c) يعطي نصاً خاصاً بكل شيك، مثل سبب التنبيه.
  function section(id, title, items, opts, st) {
    const list = items.length
      ? el('ul', { class: 'list' }, items.map((c) => chequeItem(c, { ...opts, note: opts.noteFor ? opts.noteFor(c) : null })))
      : el('div', { class: 'empty', text: opts.emptyText || 'لا توجد شيكات هنا.' });
    const note = opts.note ? el('div', { class: 'note ' + (opts.noteClass || ''), text: opts.note }) : null;
    if (!opts.collapsible) {
      return el('section', { class: 'block primary' }, head('div', title, items, opts.hideTotal), note, list);
    }
    const open = st.q ? items.length > 0 : !!st.open[id];
    const d = el('details', { class: 'block fold ' + (opts.noteClass || ''), open }, head('summary', title, items, opts.hideTotal), note, list);
    d.addEventListener('toggle', () => { if (!st.q) st.open[id] = d.open; });
    return d;
  }

  // ——— صورة الشيك ———

  function chequeImage(c, cls) {
    if (!c.has_image) return el('div', { class: 'img-empty ' + cls, text: 'لا صورة' });
    const src = `/api/m/cheques/image/${encodeURIComponent(c.id)}`;
    const img = el('img', { class: 'cheque-img', alt: 'صورة الشيك', src, loading: 'lazy', decoding: 'async' });
    const link = el('a', { href: src, target: '_blank', rel: 'noopener', class: 'img-link ' + cls, title: 'فتح الصورة بحجمها الكامل' }, img);
    img.addEventListener('error', () => link.replaceWith(el('div', { class: 'img-empty warn ' + cls, text: 'تعذّر تحميل الصورة' })));
    return link;
  }

  window.ShikatiChequesUI = {
    daysText, dueText, relTime, norm, sum, chequeWord, statusBadge, chequeItem, section, chequeImage, openDetail, detailHash,
  };
})();
