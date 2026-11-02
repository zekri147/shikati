// قسم «شيكاتي»: ثلاث شاشات (الإيداع، كل الشيكات، التنبيهات) وصفحة تفاصيل لكل شيك.
// العنوان بعد # يحدد الشاشة: #cheques و#cheques/all و#cheques/alerts و#cheques/c/<معرّف الدفعة>
(function () {
  const { api, toast, el, ltr, fmtAmount } = window.Shikati;
  const { relTime, norm, sum, chequeWord, chequeItem, section, chequeImage } = window.ShikatiChequesUI;
  const MAX_BATCH = 15;
  const STALE_MS = 60_000;
  const PAGE = 60;
  const LOC_KEY = 'shikati-location';
  const LOCATIONS = [['', 'الكل'], ['الجزائر', 'الجزائر'], ['العلمة', 'العلمة']];
  const MAIN_STATUSES = ['في الحوزة', 'مودع في البنك', 'محصّل', 'مظهّر لمورد', 'مرفوض'];
  const STATUS_FILTERS = [['', 'الكل'], ['في الحوزة', 'في الحوزة'], ['مودع في البنك', 'في البنك'], ['محصّل', 'محصّل'],
    ['مظهّر لمورد', 'مظهّر'], ['مرفوض', 'مرفوض'], ['other', 'أخرى']];
  // ترتيب التنبيهات وعناوينها. fold=false يعني أن القسم مطوي في البداية.
  const ALERTS = [
    { kind: 'unknown_lock', title: 'بانتظار التحقق', cls: 'alert', note: 'انقطع الرد بعد محاولة الإيداع. تحقق في زوهو، ثم حرّر القفل من صفحة الإدارة.' },
    { kind: 'rejected', title: 'شيكات مرفوضة', cls: 'alert', note: 'تحتاج متابعة مع العميل.' },
    { kind: 'endorse_incomplete', title: 'تظهير غير مكتمل', cls: 'alert', note: 'مسجّل لمورد في حساب الشيكات المظهّرة دون دفعة مورد. افتح الشيك وأتمّ التظهير.' },
    { kind: 'collect_late', title: 'تحصيل متأخر في AGB: مودع منذ أكثر من 7 أيام', cls: 'warn', note: 'أودعت في البنك ولم تُحصَّل بعد. تابعها مع البنك.' },
    { kind: 'late', title: 'لم يودع: في الحوزة منذ أكثر من 7 أيام من الاستلام', cls: 'warn', note: 'أعطها الأولوية في الإيداع.' },
    { kind: 'wrong_account', title: 'حساب غير صحيح في زوهو', cls: 'warn', withText: true },
    { kind: 'box', title: 'صندوق غير مطابق', cls: 'warn', withText: true },
    { kind: 'fiscal', title: 'الملف الجبائي للعميل ناقص', cls: '', withText: true, closed: true, quiet: true },
  ];

  function storedLoc() {
    try { return localStorage.getItem(LOC_KEY) || ''; } catch { return ''; }
  }
  function saveLoc(v) {
    try { localStorage.setItem(LOC_KEY, v); } catch { /* التخزين غير متاح */ }
  }

  function parseRoute() {
    const h = decodeURIComponent(location.hash.replace(/^#/, ''));
    const m = h.match(/^cheques\/c\/(\d{10,25})$/);
    if (m) return { view: 'detail', id: m[1] };
    if (h === 'cheques/all') return { view: 'all' };
    if (h === 'cheques/alerts') return { view: 'alerts' };
    if (h === 'cheques/new') return { view: 'new' };
    return { view: 'deposit' };
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

  // ——— الشاشات ———

  async function render(root) {
    const st = {
      data: null,
      loadedAt: 0,
      loc: storedLoc(),
      q: '',
      status: '',
      limit: PAGE,
      selected: new Map(),
      open: Object.fromEntries(ALERTS.map((a) => ['al-' + a.kind, !a.closed])),
      busy: false,
      dialogOpen: false,
      route: parseRoute(),
      fromList: false,
      scroll: {},
    };

    // الأشرطة العلوية: تنقّل بين الشاشات
    const tabDefs = [['deposit', 'الإيداع', '#cheques'], ['all', 'كل الشيكات', '#cheques/all'], ['alerts', 'التنبيهات', '#cheques/alerts'], ['new', 'تسجيل', '#cheques/new']];
    const alertCount = el('span', { class: 'count hidden' });
    const tabs = el('nav', { class: 'tabs', 'aria-label': 'شاشات الشيكات' }, tabDefs.map(([id, label, href]) =>
      el('a', { class: 'tab', href, 'data-view': id }, el('span', { text: label }), id === 'alerts' ? alertCount : null)));

    const kpiBox = el('div');
    const listBox = el('div', { 'aria-live': 'polite' });
    const detailBox = el('div');
    const timeLabel = el('span', { class: 'muted' });
    const refreshBtn = el('button', { type: 'button', class: 'btn-plain', text: 'تحديث' });
    const toolbar = el('div', { class: 'toolbar' }, timeLabel, refreshBtn);

    const chipRow = (defs, key, label, onPick) => {
      const row = el('div', { class: 'chips', role: 'group', 'aria-label': label }, defs.map(([value, text]) => {
        const b = el('button', { type: 'button', class: 'chip', 'data-v': value, text });
        b.addEventListener('click', () => { st[key] = value; onPick(value); update(); draw(); });
        return b;
      }));
      const update = () => row.querySelectorAll('.chip').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.v === st[key])));
      update();
      return row;
    };
    const locChips = chipRow(LOCATIONS, 'loc', 'الموقع', (v) => { saveLoc(v); st.limit = PAGE; });
    const statusChips = chipRow(STATUS_FILTERS, 'status', 'الحالة', () => { st.limit = PAGE; });
    statusChips.classList.add('scroll');

    const search = el('input', { type: 'search', class: 'search', placeholder: 'بحث باسم العميل أو رقم الشيك أو الفاتورة', 'aria-label': 'بحث', enterkeyhint: 'search' });
    search.addEventListener('input', () => { st.q = norm(search.value); st.limit = PAGE; draw(); });
    const filters = el('div', { class: 'filters' }, locChips, statusChips, search);

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
      const items = st.route.view === 'deposit' ? [...st.selected.values()] : [];
      bar.classList.toggle('hidden', !items.length);
      document.body.classList.toggle('has-bar', items.length > 0);
      barInfo.replaceChildren(
        el('span', { class: 'strong', text: `المحدد: ${chequeWord(items.length)}` }),
        el('span', {}, ltr(fmtAmount(sum(items)), 'num')));
    }

    const matches = (c) =>
      (!st.loc || c.location === st.loc) &&
      (!st.q || norm(c.customer).includes(st.q) || norm(c.cheque_number).includes(st.q) || norm(c.invoices).includes(st.q) || norm(c.number) === st.q);
    const pick = (items) => items.filter(matches);

    function drawDeposit(d) {
      const agb = pick(d.agb_in_hand.items);
      const rost = pick(d.rostomia_in_hand.items);
      const noDest = pick(d.no_destination.items);
      const waiting = [...agb, ...rost, ...noDest];

      // إزالة ما لم يعد قابلاً للإيداع من التحديد
      const available = new Set(d.agb_in_hand.items.filter((c) => !c.lock).map((c) => c.id));
      for (const id of [...st.selected.keys()]) if (!available.has(id)) st.selected.delete(id);

      const locLabel = st.loc ? ` — ${st.loc}` : '';
      const inBank = pick(d.agb_pending_collection.items);
      kpiBox.replaceChildren(el('div', { class: 'kpis' },
        el('div', { class: 'kpi' },
          el('div', { class: 'label', text: 'تنتظر الإيداع' + locLabel }),
          el('div', { class: 'value display' }, ltr(fmtAmount(sum(waiting)))),
          el('div', { class: 'sub', text: `${chequeWord(waiting.length)} في الحوزة` })),
        el('div', { class: 'kpi dark' },
          el('div', { class: 'label' }, 'في بنك AGB بانتظار التحصيل', el('span', { class: 'sub', text: chequeWord(inBank.length) })),
          el('div', { class: 'value display' }, ltr(fmtAmount(sum(inBank))))),
      ));

      const opts = { selected: st.selected, onToggle: toggle, link: true };
      const parts = [
        section('agb', 'للإيداع في بنك AGB', agb, {
          ...opts,
          selectable: d.can_deposit,
          link: !d.can_deposit,
          note: d.can_deposit && agb.some((c) => !c.lock) ? 'اضغط الشيكات التي سلّمتها للبنك لتحديدها، ثم «أودعت المحدد».' : null,
          emptyText: st.q || st.loc ? 'لا شيك يطابق البحث أو الموقع.' : 'لا شيكات تنتظر الإيداع في بنك AGB.',
        }, st),
      ];
      const rejected = pick(d.rejected.items);
      if (rejected.length) parts.push(section('rejected', 'شيكات مرفوضة', rejected, { ...opts, collapsible: true, note: 'تحتاج متابعة مع العميل.', noteClass: 'alert' }, st));
      if (noDest.length) parts.push(section('nodest', 'في الحوزة والوجهة غير محددة', noDest, { ...opts, collapsible: true, note: 'لا تأخذها إلى البنك قبل أن تُحدَّد وجهتها في زوهو.', noteClass: 'warn' }, st));
      parts.push(section('rost', 'للإيداع في بنك روستمية', rost, { ...opts, collapsible: true, note: 'للعرض فقط.' }, st));
      parts.push(section('pending', 'في بنك AGB بانتظار التحصيل', inBank, { ...opts, collapsible: true }, st));
      parts.push(section('recent', 'آخر 5 شيكات أُودعت في بنك AGB', pick(d.agb_recent.items), {
        ...opts, collapsible: true, showStatus: true, noAge: true, hideTotal: true, emptyText: 'لا توجد إيداعات بعد.',
      }, st));
      listBox.replaceChildren(...parts);
    }

    function drawAll(d) {
      const byStatus = (c) => !st.status || (st.status === 'other' ? !MAIN_STATUSES.includes(c.status) : c.status === st.status);
      const items = d.all.filter((c) => byStatus(c) && matches(c));
      const shown = items.slice(0, st.limit);
      const more = items.length - shown.length;
      const moreBtn = more > 0 ? el('button', { type: 'button', class: 'btn-plain more', text: `عرض المزيد (${more})` }) : null;
      if (moreBtn) moreBtn.addEventListener('click', () => { st.limit += PAGE; draw(); });
      kpiBox.replaceChildren();
      listBox.replaceChildren(
        el('div', { class: 'result-head' },
          el('span', { class: 'strong', text: items.length ? chequeWord(items.length) : 'لا نتائج' }),
          items.length ? ltr(fmtAmount(sum(items)), 'num muted') : null),
        items.length
          ? el('ul', { class: 'list' }, shown.map((c) => chequeItem(c, { link: true, showStatus: true, ageInHandOnly: true })))
          : el('div', { class: 'empty', text: 'لا شيك يطابق البحث أو التصفية.' }),
        moreBtn);
    }

    function drawAlerts(d) {
      const byId = new Map(d.all.map((c) => [c.id, c]));
      kpiBox.replaceChildren();
      const parts = [];
      for (const a of ALERTS) {
        const rows = d.alerts.filter((x) => x.kind === a.kind);
        const texts = new Map(rows.map((x) => [x.id, x.text]));
        const items = pick(rows.map((x) => byId.get(x.id)).filter(Boolean));
        if (!items.length) continue;
        parts.push(section('al-' + a.kind, a.title, items, {
          link: true, collapsible: true, ageInHandOnly: true, noteClass: a.cls, note: a.note,
          showStatus: a.kind === 'wrong_account' || a.kind === 'box' || a.kind === 'fiscal',
          noteFor: a.withText ? (c) => texts.get(c.id) || null : null,
        }, st));
      }
      listBox.replaceChildren(...(parts.length ? parts : [el('div', { class: 'empty', text: st.q || st.loc ? 'لا تنبيه يطابق البحث أو الموقع.' : 'لا توجد تنبيهات. كل الشيكات في وضع سليم.' })]));
    }

    function updateTabs() {
      tabs.querySelectorAll('.tab').forEach((t) => {
        const on = t.dataset.view === st.route.view;
        t.classList.toggle('on', on);
        if (on) t.setAttribute('aria-current', 'page'); else t.removeAttribute('aria-current');
      });
      if (st.data) {
        const loud = new Set(ALERTS.filter((a) => !a.quiet).map((a) => a.kind));
        const n = new Set(st.data.alerts.filter((x) => loud.has(x.kind)).map((x) => x.id)).size;
        alertCount.textContent = String(n);
        alertCount.classList.toggle('hidden', !n);
      }
    }

    function draw() {
      const v = st.route.view;
      updateTabs();
      const isList = v !== 'detail' && v !== 'new';
      [kpiBox, toolbar, filters, listBox].forEach((x) => x.classList.toggle('hidden', !isList));
      detailBox.classList.toggle('hidden', isList);
      statusChips.classList.toggle('hidden', v !== 'all');
      updateBar();
      const d = st.data;
      if (!isList || !d) return;
      if (v === 'all') drawAll(d);
      else if (v === 'alerts') drawAlerts(d);
      else drawDeposit(d);
      updateBar();
      timeLabel.textContent = 'آخر تحديث ' + relTime(st.loadedAt);
    }

    function route() {
      const prev = st.route;
      const next = parseRoute();
      if (prev.view !== 'detail' && prev.view !== 'new') st.scroll[prev.view] = window.scrollY;
      st.fromList = next.view === 'detail' && prev.view !== 'detail' ? true : (next.view === 'detail' ? st.fromList : false);
      st.route = next;
      document.title = 'شيكاتي';
      draw();
      if (next.view === 'detail') {
        window.scrollTo(0, 0);
        window.ShikatiChequeDetail.render(detailBox, next.id, {
          onBack: () => { if (st.fromList) history.back(); else location.hash = '#cheques'; },
        });
      } else if (next.view === 'new') {
        window.scrollTo(0, 0);
        window.ShikatiChequeRegister.render(detailBox, {
          // بعد التسجيل: تحديث القوائم ثم فتح صفحة الشيك الجديد
          onDone: (pid) => { load(true); location.hash = '#cheques/c/' + pid; },
        });
      } else {
        detailBox.replaceChildren();
        window.scrollTo(0, st.scroll[next.view] || 0);
      }
    }
    window.addEventListener('hashchange', route);

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

    root.replaceChildren(tabs, kpiBox, toolbar, filters, listBox, detailBox);
    listBox.replaceChildren(el('p', { class: 'muted', text: 'جارٍ التحميل…' }));
    route();
    await load(false);
  }

  window.ShikatiModules = window.ShikatiModules || {};
  window.ShikatiModules.cheques = { render };
})();
