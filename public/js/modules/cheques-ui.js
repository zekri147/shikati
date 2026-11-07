// أدوات عرض مشتركة بين شاشات الشيكات: البطاقة، الأقسام، الصورة، والنصوص العربية
(function () {
  const { el, ltr, fmtAmount, fmtDate } = window.Shikati;
  const LATE_DAYS = 7;
  // بعد 14 يوماً يصير التأخير عاجلاً: شارة حمراء. قبلها نص بلون التحذير
  const URGENT_DAYS = 14;
  const lateClass = (n) => 'age late' + (n > URGENT_DAYS ? ' urgent' : '');
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

  // مدة بالأيام دون «منذ»: يوم واحد، يومان، 9 أيام، 17 يوماً
  function daysCount(n) {
    if (n === 1) return 'يوم واحد';
    if (n === 2) return 'يومان';
    if (n <= 10) return `${n} أيام`;
    return `${n} يوماً`;
  }

  // تاريخ مختصر في البطاقة: دون السنة إن كانت السنة الحالية
  function shortDate(iso) {
    if (!iso) return '—';
    const full = fmtDate(iso);
    return iso.slice(0, 4) === String(new Date().getFullYear()) ? full.slice(0, 5) : full;
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
  // وshowStatus وnoAge وageInHandOnly وnote لنص تنبيه تحت البطاقة.
  // lateOnly: لا يُعرض العمر إلا إن تأخر الشيك، فتبقى البطاقة في سطرين مع شارة الحالة.
  function chequeItem(c, opts) {
    // ageInHandOnly: عمر الشيك يهم ما دام في الحوزة فقط
    const noAge = opts.noAge || (opts.ageInHandOnly && c.status !== 'في الحوزة');
    const late = c.days > LATE_DAYS && !noAge;
    const selectable = opts.selectable && !c.lock;
    const selected = selectable && opts.selected.has(c.id);

    // السطر الثاني: رقم الشيك والتاريخ والموقع نصاً واحداً، ثم شارة الحالة أو التأخير
    const facts = [
      c.cheque_number ? el('span', {}, 'شيك ', ltr(c.cheque_number, 'num')) : el('span', { text: 'رقم غير مسجّل' }),
      c.deposit_date && c.status !== 'في الحوزة'
        ? el('span', {}, 'إيداع ', ltr(shortDate(c.deposit_date), 'num'))
        : el('span', {}, ltr(shortDate(c.date), 'num')),
      c.location ? el('span', { text: c.location }) : null,
    ].filter(Boolean);
    const factsLine = el('div', { class: 'facts' }, facts.flatMap((f, i) => (i ? [el('span', { class: 'dot', 'aria-hidden': 'true', text: '·' }), f] : [f])));

    let age = null;
    if (c.status === 'مودع في البنك' && c.deposit_days !== undefined) {
      // التحصيل المتأخر لبنك AGB وحده: الرستمية لا تتحوّل إلى «محصّل» في زوهو
      const slow = c.destination === 'ELONAC' && c.deposit_days > LATE_DAYS;
      age = el('span', { class: slow ? lateClass(c.deposit_days) : 'age', text: slow ? 'تحصيل متأخر ' + daysCount(c.deposit_days) : 'في البنك ' + daysText(c.deposit_days) });
    } else if (!noAge && (late || !opts.lateOnly)) {
      age = el('span', { class: late ? lateClass(c.days) : 'age', text: late ? 'متأخر ' + daysCount(c.days) : daysText(c.days) });
    }
    const marks = el('div', { class: 'marks' },
      opts.selectable && c.lock ? el('span', { class: 'badge lock-' + c.lock, text: LOCK_LABELS[c.lock] || c.lock }) : null,
      opts.showStatus ? statusBadge(c.status) : null,
      age);

    // في شاشة الإيداع: لمس البطاقة يحددها، والسهم وحده يفتح التفاصيل
    const chevron = opts.selectable
      ? el('a', { class: 'go', href: detailHash(c.id), 'aria-label': `تفاصيل شيك ${c.customer}`, onclick: (e) => e.stopPropagation() },
        el('span', { class: 'ico ico-chevron', 'aria-hidden': 'true' }))
      : opts.link ? el('span', { class: 'go', 'aria-hidden': 'true' }, el('span', { class: 'ico ico-chevron' })) : null;

    const li = el('li', { class: 'item' + (selectable ? ' selectable' : '') + (selected ? ' selected' : '') + (opts.link ? ' linkable' : '') },
      el('div', { class: 'item-body' },
        el('div', { class: 'item-main' },
          el('div', { class: 'customer' },
            selectable ? el('span', { class: 'check', 'aria-hidden': 'true' }) : null,
            el('span', { text: c.customer })),
          el('div', { class: 'amount' }, ltr(fmtAmount(c.amount), 'num'))),
        el('div', { class: 'item-sub' }, factsLine, marks),
        opts.note ? el('div', { class: 'item-note', text: opts.note }) : null),
      chevron,
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
    // في القسم المطوي يكفي الشريط الملوّن على طرفه، فتبقى الملاحظة داخله بلا لون
    const note = opts.note ? el('div', { class: 'note ' + (opts.collapsible ? '' : (opts.noteClass || '')), text: opts.note }) : null;
    if (!opts.collapsible) {
      return el('section', { class: 'block primary' }, head('div', title, items, opts.hideTotal), note, list);
    }
    const open = st.q ? items.length > 0 : !!st.open[id];
    const d = el('details', { class: 'block fold ' + (opts.noteClass || ''), open }, head('summary', title, items, opts.hideTotal), note, list);
    d.addEventListener('toggle', () => { if (!st.q) st.open[id] = d.open; });
    return d;
  }

  // ——— صورة الشيك ———

  // تدوير صورة باتجاه عقارب الساعة على لوح رسم، فيظهر الشيك أفقياً ومعتدلاً
  function rotateImage(img, deg, type = 'image/jpeg') {
    const turn = deg === 90 || deg === 270;
    const canvas = document.createElement('canvas');
    canvas.width = turn ? img.naturalHeight : img.naturalWidth;
    canvas.height = turn ? img.naturalWidth : img.naturalHeight;
    const ctx = canvas.getContext('2d');
    ctx.translate(canvas.width / 2, canvas.height / 2);
    ctx.rotate((deg * Math.PI) / 180);
    ctx.drawImage(img, -img.naturalWidth / 2, -img.naturalHeight / 2);
    return canvas.toDataURL(type, 0.88);
  }

  // تدوير صورة بصيغة data URL (قبل رفعها إلى زوهو)
  function rotateDataUrl(src, deg) {
    if (!deg) return Promise.resolve(src);
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(rotateImage(img, deg));
      img.onerror = () => reject(new Error('تعذّر تدوير الصورة.'));
      img.src = src;
    });
  }

  // عارض الصورة داخل التطبيق: زر «إغلاق» وزر الرجوع في الهاتف يعيدانك إلى الصفحة،
  // والضغط على الصورة يكبّرها أو يعيدها إلى حجم الشاشة.
  function openViewer(src) {
    const img = el('img', { class: 'viewer-img', src, alt: 'صورة الشيك' });
    const wrap = el('div', { class: 'viewer-body' }, img);
    const closeBtn = el('button', { type: 'button', class: 'btn-primary viewer-close', text: 'إغلاق' });
    const zoomBtn = el('button', { type: 'button', class: 'btn-plain viewer-zoom', text: 'تكبير' });
    const dlg = el('dialog', { class: 'viewer', 'aria-label': 'صورة الشيك' },
      el('div', { class: 'viewer-bar' }, closeBtn, zoomBtn), wrap);
    const toggle = () => {
      const on = wrap.classList.toggle('zoomed');
      zoomBtn.textContent = on ? 'تصغير' : 'تكبير';
    };
    img.addEventListener('click', toggle);
    zoomBtn.addEventListener('click', toggle);
    let closed = false;
    const finish = () => {
      if (closed) return;
      closed = true;
      window.removeEventListener('popstate', onPop);
      dlg.close();
      dlg.remove();
    };
    const onPop = () => finish();
    // زر الرجوع في الهاتف يغلق العارض بدل مغادرة الصفحة
    history.pushState({ viewer: true }, '');
    window.addEventListener('popstate', onPop);
    const close = () => { if (!closed) history.back(); };
    closeBtn.addEventListener('click', close);
    dlg.addEventListener('cancel', (e) => { e.preventDefault(); close(); });
    document.body.append(dlg);
    dlg.showModal();
    closeBtn.focus();
  }

  // الصورة المرفقة بالدفعة، معتدلة دائماً: الخادم يعرف اتجاهها (يحدّده كلود مرة واحدة)
  function chequeImage(c, cls) {
    if (!c.has_image) return el('div', { class: 'img-empty ' + cls, text: 'لا صورة' });
    const base = `/api/m/cheques/image/${encodeURIComponent(c.id)}`;
    const src = base + (c.v ? `?v=${encodeURIComponent(c.v)}` : '');
    const img = el('img', { class: 'cheque-img', alt: 'صورة الشيك', src, decoding: 'async' });
    const link = el('a', { href: src, class: 'img-link ' + cls, title: 'تكبير الصورة' }, img);
    link.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      openViewer(img.src);
    });
    let failed = false;
    img.addEventListener('error', () => {
      if (failed) return;
      failed = true;
      link.replaceWith(el('div', { class: 'img-empty warn ' + cls, text: 'تعذّر تحميل الصورة' }));
    });
    const rotation = fetch(base + '/rotation', { credentials: 'same-origin' })
      .then((r) => (r.ok ? r.json() : { rotation: 0 })).then((j) => Number(j.rotation) || 0).catch(() => 0);
    let done = false;
    img.addEventListener('load', async () => {
      if (done) return;
      done = true;
      const deg = await rotation;
      if (!deg || !img.isConnected) return;
      try {
        img.src = rotateImage(img, deg);
      } catch { /* تبقى الصورة كما هي */ }
    });
    return link;
  }

  window.ShikatiChequesUI = {
    daysText, daysCount, relTime, norm, sum, chequeWord, statusBadge, chequeItem, section, chequeImage, rotateDataUrl, openDetail, detailHash,
  };
})();
