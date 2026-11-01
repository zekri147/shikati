// قسم «شيكاتي»: الشاشة الرئيسية للمودِع
(function () {
  const { api, toast, el, ltr, fmtAmount, fmtDate } = window.Shikati;
  const LATE_DAYS = 7;
  const MAX_BATCH = 15;
  const STALE_MS = 60_000;
  const LOC_KEY = 'shikati-location';
  const LOCATIONS = [['', 'الكل'], ['الجزائر', 'الجزائر'], ['العلمة', 'العلمة']];
  const LOCK_LABELS = { pending: 'الإيداع قيد التنفيذ', unknown: 'بانتظار التحقق', done: 'سُجّل إيداعه' };

  // ——— أدوات صغيرة ———

  function daysText(n) {
    if (n === 0) return 'اليوم';
    if (n === 1) return 'منذ يوم';
    if (n === 2) return 'منذ يومين';
    if (n <= 10) return `منذ ${n} أيام`;
    return `منذ ${n} يوماً`;
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

  function storedLoc() {
    try { return localStorage.getItem(LOC_KEY) || ''; } catch { return ''; }
  }
  function saveLoc(v) {
    try { localStorage.setItem(LOC_KEY, v); } catch { /* التخزين غير متاح */ }
  }

  // ——— عرض الشيك ———

  function chequeItem(c, opts) {
    const late = c.days > LATE_DAYS && !opts.noAge;
    const selectable = opts.selectable && !c.lock;
    const selected = selectable && opts.selected.has(c.id);

    const li = el('li', { class: 'item' + (selectable ? ' selectable' : '') + (selected ? ' selected' : '') },
      el('div', { class: 'customer' },
        selectable ? el('span', { class: 'check', 'aria-hidden': 'true' }) : null,
        el('span', { text: c.customer })),
      el('div', { class: 'amount' }, ltr(fmtAmount(c.amount), 'num')),
      el('div', { class: 'details' },
        el('span', {}, 'شيك رقم ', c.cheque_number ? ltr(c.cheque_number, 'num') : el('span', { text: 'غير مسجّل' })),
        el('span', {}, 'استلام ', ltr(fmtDate(c.date), 'num')),
        c.location ? el('span', { text: c.location }) : null,
        opts.showStatus ? el('span', { class: 'badge', text: c.status }) : null,
      ),
      opts.noAge ? el('div') : el('div', { class: 'age' + (late ? ' late' : ''), text: daysText(c.days) + (late ? ' — متأخر' : '') }),
      opts.selectable && c.lock ? el('div', { class: 'item-action' }, el('span', { class: 'badge', text: LOCK_LABELS[c.lock] || c.lock })) : null,
    );

    if (selectable) {
      li.setAttribute('role', 'checkbox');
      li.setAttribute('aria-checked', String(selected));
      li.tabIndex = 0;
      li.addEventListener('click', () => opts.onToggle(c));
      li.addEventListener('keydown', (e) => {
        if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); opts.onToggle(c); }
      });
    }
    return li;
  }

  function meta(items, hideTotal) {
    if (!items.length) return el('span', { class: 'meta', text: 'لا شيء' });
    if (hideTotal) return el('span', { class: 'meta', text: chequeWord(items.length) });
    return el('span', { class: 'meta' }, `${chequeWord(items.length)} · `, ltr(fmtAmount(sum(items)), 'num'));
  }

  // قسم ثابت أو مطوي. القسم المطوي يتذكر حالته أثناء الجلسة.
  function section(id, title, items, opts, st) {
    const list = items.length
      ? el('ul', { class: 'list' }, items.map((c) => chequeItem(c, opts)))
      : el('div', { class: 'empty', text: opts.emptyText || 'لا توجد شيكات هنا.' });
    const note = opts.note ? el('div', { class: 'note ' + (opts.noteClass || ''), text: opts.note }) : null;
    if (!opts.collapsible) {
      return el('section', { class: 'block' },
        el('div', { class: 'block-head' }, el('h2', { text: title }), meta(items, opts.hideTotal)), note, list);
    }
    const open = st.q ? items.length > 0 : !!st.open[id];
    const d = el('details', { class: 'block fold', open },
      el('summary', { class: 'block-head' }, el('h2', { text: title }), meta(items, opts.hideTotal)), note, list);
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

  // ——— بطاقة تأكيد الإيداع (شيك واحد أو عدة شيكات) ———

  function depositDialog(items) {
    return new Promise((resolve) => {
      const total = sum(items);
      const single = items.length === 1;
      const rows = items.map((c) => {
        const status = el('div', { class: 'b-status' });
        const row = el('li', { class: 'b-row' },
          chequeImage(c, single ? 'img-big' : 'img-thumb'),
          el('div', { class: 'b-info' },
            el('div', { class: 'strong', text: c.customer }),
            el('div', { class: 'muted small' }, 'شيك رقم ', c.cheque_number ? ltr(c.cheque_number, 'num') : 'غير مسجّل'),
            el('div', {}, ltr(fmtAmount(c.amount), 'num strong')),
            status));
        return { c, row, status };
      });

      const message = el('div', { role: 'alert' });
      const okBtn = el('button', { type: 'button', class: 'btn-primary', text: single ? 'تأكيد الإيداع' : `تأكيد إيداع ${chequeWord(items.length, true)}` });
      const cancelBtn = el('button', { type: 'button', class: 'btn-plain', text: 'إلغاء' });
      const dlg = el('dialog', { class: 'confirm', 'aria-labelledby': 'dlg-title' },
        el('h2', { id: 'dlg-title', text: single ? 'تأكيد إيداع شيك في بنك AGB' : `تأكيد إيداع ${chequeWord(items.length, true)} في بنك AGB` }),
        el('ul', { class: 'b-list' + (single ? ' single' : '') }, rows.map((r) => r.row)),
        single ? null : el('div', { class: 'b-total' }, el('span', { text: 'المجموع' }), ltr(fmtAmount(total), 'num strong')),
        el('p', { class: 'muted small', text: 'تأكد أن هذه الشيكات سُلِّمت فعلاً للبنك، وطابقها مع صورها. سيُسجَّل الإيداع في زوهو باسمك.' }),
        message,
        el('div', { class: 'dlg-actions' }, okBtn, cancelBtn),
      );

      const result = { done: [], failed: [], attempted: false };
      let busy = false;
      const close = () => { if (busy) return; dlg.close(); dlg.remove(); resolve(result); };
      cancelBtn.addEventListener('click', close);
      dlg.addEventListener('cancel', (e) => { e.preventDefault(); close(); });

      okBtn.addEventListener('click', async () => {
        busy = true;
        result.attempted = true;
        okBtn.disabled = true;
        cancelBtn.disabled = true;
        okBtn.textContent = 'جارٍ التسجيل…';
        let warnings = 0;
        let stopped = false;

        for (const r of rows) {
          if (stopped) {
            r.status.className = 'b-status muted';
            r.status.textContent = 'لم يُحاوَل، فقد توقف الإيداع';
            continue;
          }
          r.status.className = 'b-status muted';
          r.status.textContent = 'جارٍ التسجيل…';
          try {
            const res = await api('/api/m/cheques/deposit', { method: 'POST', body: {
              payment_id: r.c.id, amount: r.c.amount, cheque_number: r.c.cheque_number,
            } });
            result.done.push(r.c);
            if (res.warning) {
              warnings++;
              r.status.className = 'b-status warn';
              r.status.textContent = res.warning;
            } else {
              r.status.className = 'b-status ok';
              r.status.textContent = 'تم الإيداع';
            }
          } catch (e) {
            result.failed.push(r.c);
            r.status.className = 'b-status err';
            r.status.textContent = e.message;
            // انقطاع الرد بعد محاولة الإيداع: لا نكمل أي شيك آخر
            if (e.status === 504 || e.status === 0) stopped = true;
          }
        }

        busy = false;
        cancelBtn.disabled = false;
        okBtn.remove();
        cancelBtn.textContent = 'إغلاق';

        if (!result.failed.length && !warnings) {
          // نجاح كامل: تُغلق البطاقة وحدها
          setTimeout(close, 700);
          return;
        }
        message.className = stopped ? 'form-error' : 'form-warn';
        message.textContent = stopped
          ? 'توقف الإيداع لأن زوهو لم يرد بوضوح. لا تعد المحاولة: أخبر المدير ليتحقق في زوهو.'
          : `أُودع ${result.done.length} من أصل ${items.length}. راجع الرسائل أعلاه.`;
      });

      document.body.append(dlg);
      dlg.showModal();
      okBtn.focus();
    });
  }

  // ——— الشاشة ———

  async function render(root) {
    const st = {
      data: null,
      loadedAt: 0,
      loc: storedLoc(),
      q: '',
      selected: new Map(),
      open: {},
      busy: false,
      dialogOpen: false,
    };

    const kpiBox = el('div');
    const listBox = el('div', { 'aria-live': 'polite' });
    const timeLabel = el('span', { class: 'muted' });
    const refreshBtn = el('button', { type: 'button', class: 'btn-plain', text: 'تحديث' });

    const chips = el('div', { class: 'chips', role: 'group', 'aria-label': 'الموقع' }, LOCATIONS.map(([value, label]) => {
      const b = el('button', { type: 'button', class: 'chip', 'data-loc': value, text: label });
      b.addEventListener('click', () => { st.loc = value; saveLoc(value); updateChips(); draw(); });
      return b;
    }));
    const updateChips = () => chips.querySelectorAll('.chip').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.loc === st.loc)));

    const search = el('input', { type: 'search', class: 'search', placeholder: 'بحث باسم العميل أو رقم الشيك', 'aria-label': 'بحث', enterkeyhint: 'search' });
    search.addEventListener('input', () => { st.q = norm(search.value); draw(); });

    // شريط الإيداع أسفل الشاشة، يظهر عند تحديد شيك أو أكثر
    const barInfo = el('div', { class: 'ab-info' });
    const barGo = el('button', { type: 'button', class: 'btn-primary', text: 'أودعت المحدد' });
    const barClear = el('button', { type: 'button', class: 'btn-plain', text: 'إلغاء التحديد' });
    const bar = el('div', { class: 'actionbar hidden' }, barInfo, el('div', { class: 'ab-buttons' }, barGo, barClear));
    document.body.append(bar);
    barClear.addEventListener('click', () => { st.selected.clear(); draw(); });
    barGo.addEventListener('click', async () => {
      const items = [...st.selected.values()];
      if (!items.length) return;
      st.dialogOpen = true;
      const r = await depositDialog(items);
      st.dialogOpen = false;
      if (!r.attempted) return;
      st.selected.clear();
      if (r.done.length && !r.failed.length) toast(`تم إيداع ${chequeWord(r.done.length, true)} · ${fmtAmount(sum(r.done))}`);
      else if (r.done.length) toast(`أُودع ${chequeWord(r.done.length)}، وبقي ${chequeWord(r.failed.length)} دون إيداع`, 'warn');
      else toast('لم يُسجَّل أي إيداع. راجع الرسائل.', 'err');
      await load(true);
    });

    function toggle(c) {
      if (st.selected.has(c.id)) st.selected.delete(c.id);
      else if (st.selected.size >= MAX_BATCH) { toast(`يمكن تحديد ${MAX_BATCH} شيكاً على الأكثر في المرة الواحدة.`, 'warn'); return; }
      else st.selected.set(c.id, c);
      draw();
    }

    function updateBar() {
      const items = [...st.selected.values()];
      bar.classList.toggle('hidden', !items.length);
      document.body.classList.toggle('has-bar', items.length > 0);
      barInfo.replaceChildren(
        el('span', { class: 'strong', text: `المحدد: ${chequeWord(items.length)}` }),
        el('span', {}, ltr(fmtAmount(sum(items)), 'num')));
    }

    function draw() {
      const d = st.data;
      if (!d) return;
      const pick = (sec) => sec.items.filter((c) =>
        (!st.loc || c.location === st.loc) &&
        (!st.q || norm(c.customer).includes(st.q) || norm(c.cheque_number).includes(st.q)));

      const agb = pick(d.agb_in_hand);
      const rost = pick(d.rostomia_in_hand);
      const noDest = pick(d.no_destination);
      const waiting = [...agb, ...rost, ...noDest];

      // إزالة ما لم يعد قابلاً للإيداع من التحديد
      const available = new Set(d.agb_in_hand.items.filter((c) => !c.lock).map((c) => c.id));
      for (const id of [...st.selected.keys()]) if (!available.has(id)) st.selected.delete(id);

      const locLabel = st.loc ? ` — ${st.loc}` : '';
      kpiBox.replaceChildren(el('div', { class: 'kpi' },
        el('div', { class: 'label', text: 'شيكات تنتظر الإيداع' + locLabel }),
        el('div', { class: 'value display' }, ltr(fmtAmount(sum(waiting)))),
        el('div', { class: 'sub', text: `${chequeWord(waiting.length)} في الحوزة` }),
      ));

      const opts = { selected: st.selected, onToggle: toggle };
      const parts = [
        section('agb', 'للإيداع في بنك AGB', agb, {
          ...opts,
          selectable: d.can_deposit,
          note: d.can_deposit && agb.some((c) => !c.lock) ? 'اضغط الشيكات التي سلّمتها للبنك لتحديدها، ثم «أودعت المحدد».' : null,
          emptyText: st.q || st.loc ? 'لا شيك يطابق البحث أو الموقع.' : 'لا شيكات تنتظر الإيداع في بنك AGB.',
        }, st),
      ];
      const rejected = pick(d.rejected);
      if (rejected.length) parts.push(section('rejected', 'شيكات مرفوضة', rejected, { ...opts, collapsible: true, note: 'تحتاج متابعة مع العميل.', noteClass: 'alert' }, st));
      if (noDest.length) parts.push(section('nodest', 'في الحوزة والوجهة غير محددة', noDest, { ...opts, collapsible: true, note: 'لا تأخذها إلى البنك قبل أن تُحدَّد وجهتها في زوهو.', noteClass: 'warn' }, st));
      parts.push(section('rost', 'للإيداع في بنك روستمية', rost, { ...opts, collapsible: true, note: 'للعرض فقط.' }, st));
      parts.push(section('pending', 'في بنك AGB بانتظار التحصيل', pick(d.agb_pending_collection), { ...opts, collapsible: true }, st));
      parts.push(section('recent', 'آخر 5 شيكات أُودعت في بنك AGB', pick(d.agb_recent), {
        ...opts, collapsible: true, showStatus: true, noAge: true, hideTotal: true, emptyText: 'لا توجد إيداعات بعد.',
      }, st));

      listBox.replaceChildren(...parts);
      updateBar();
      timeLabel.textContent = 'آخر تحديث ' + relTime(st.loadedAt);
    }

    async function load(refresh) {
      if (st.busy) return;
      st.busy = true;
      refreshBtn.disabled = true;
      refreshBtn.textContent = 'جارٍ التحديث…';
      try {
        st.data = await api('/api/m/cheques' + (refresh ? '?refresh=1' : ''));
        st.loadedAt = Date.now();
        draw();
      } catch (e) {
        if (!st.data) listBox.replaceChildren(el('div', { class: 'error-box', text: e.message }));
        else toast(e.message, 'err');
      } finally {
        st.busy = false;
        refreshBtn.disabled = false;
        refreshBtn.textContent = 'تحديث';
      }
    }

    refreshBtn.addEventListener('click', () => load(true));

    // تحديث تلقائي حين يعود الموظف إلى التطبيق، إلا أثناء التأكيد أو التحديد
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState !== 'visible') return;
      if (st.dialogOpen || st.selected.size) return;
      if (Date.now() - st.loadedAt > STALE_MS) load(false);
    });
    setInterval(() => { if (st.loadedAt) timeLabel.textContent = 'آخر تحديث ' + relTime(st.loadedAt); }, 30_000);

    updateChips();
    root.replaceChildren(
      kpiBox,
      el('div', { class: 'toolbar' }, timeLabel, refreshBtn),
      el('div', { class: 'filters' }, chips, search),
      listBox,
    );
    listBox.replaceChildren(el('p', { class: 'muted', text: 'جارٍ التحميل…' }));
    await load(false);
  }

  window.ShikatiModules = window.ShikatiModules || {};
  window.ShikatiModules.cheques = { render };
})();
