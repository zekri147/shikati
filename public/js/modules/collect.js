// قسم «التحصيل»: أرصدة العملاء المدينين لكل مندوب، قراءة فقط من زوهو (7/11/2026، بطلب ZEKRI).
// نُقل من تبويب «التحصيل» في قائمة الاتصال. المندوب يرى عملاءه فقط، والمدير يختار المندوب.
// العنوان بعد #: ‎#coll للقائمة، و‎#coll/c/<معرّف العميل> لبطاقة العميل.
(function () {
  const { api, toast, el, ltr, fmtAmount, fmtDate } = window.Shikati;
  const { relTime, norm } = window.ShikatiChequesUI;
  const STALE_MS = 5 * 60_000;
  const PAGE = 40;
  const REP_KEY = 'shikati-coll-rep';

  // الفئات حسب تأخر أقدم فاتورة غير مسدّدة، كما في قائمة الاتصال
  const CATS = [
    ['', 'الكل'],
    ['old', 'أكثر من 90 يوماً'],
    ['d90', 'من 31 إلى 90'],
    ['d30', 'حتى 30 يوماً'],
    ['due', 'لم يحن موعدها'],
    ['open', 'أرصدة افتتاحية'],
  ];
  const CAT_NOTE = {
    old: 'أقدم فاتورة غير مسدّدة تأخرت أكثر من ثلاثة أشهر. ابدأ بهم.',
    d90: 'أقدم فاتورة غير مسدّدة تأخرت بين شهر وثلاثة أشهر.',
    d30: 'أقدم فاتورة غير مسدّدة تأخرت شهراً على الأكثر.',
    due: 'فواتيرهم لم يحن موعد دفعها بعد.',
    open: 'أرصدة نُقلت عند بداية زوهو بوكس، بلا تاريخ استحقاق. تابعها مع الإدارة.',
  };
  const catOf = (c) => (c.late === null ? 'open' : c.late > 90 ? 'old' : c.late > 30 ? 'd90' : c.late > 0 ? 'd30' : 'due');
  const isOld = (c) => c.late === null || c.late > 90;
  const total = (list) => Math.round(list.reduce((t, c) => t + c.balance, 0) * 100) / 100;

  // صيغ العدد بالعربية
  const word = (n, one, two, few, many) => (n === 1 ? one : n === 2 ? two : n <= 10 ? `${n} ${few}` : `${n} ${many}`);
  const customersWord = (n) => word(n, 'عميل واحد', 'عميلان', 'عملاء', 'عميلاً');
  const daysWord = (n) => word(n, 'يوماً واحداً', 'يومين', 'أيام', 'يوماً');
  const invoicesWord = (n) => word(n, 'فاتورة واحدة', 'فاتورتان', 'فواتير', 'فاتورة');

  const lateText = (c) => (c.late === null ? 'رصيد افتتاحي' : c.late > 0 ? `متأخر ${daysWord(c.late)}` : 'لم يحن موعدها');
  // الرقم بالصيغة المحلية للعرض: 213561765718 يصبح 0561 76 57 18
  const localPhone = (p) => (p.startsWith('213') && p.length === 12 ? ('0' + p.slice(3)).replace(/^(\d{4})(\d{2})(\d{2})(\d{2})$/, '$1 $2 $3 $4') : '+' + p);
  const repLabel = (code) => (code === '-' || code === '' ? 'بلا مندوب' : code);

  function storedRep() { try { return localStorage.getItem(REP_KEY) || ''; } catch { return ''; } }
  function saveRep(v) { try { localStorage.setItem(REP_KEY, v); } catch { /* التخزين غير متاح */ } }

  function parseRoute() {
    const h = decodeURIComponent(location.hash.replace(/^#/, ''));
    const m = h.match(/^coll\/c\/(\d{10,25})$/);
    return m ? { view: 'customer', id: m[1] } : { view: 'list' };
  }

  async function render(root, me) {
    const isAdmin = me.user.role === 'admin';
    const st = { data: null, loadedAt: 0, busy: false, cat: '', q: '', limit: PAGE, rep: isAdmin ? storedRep() : '', route: parseRoute(), scroll: 0, fromList: false };

    const kpiBox = el('div');
    const repBox = el('div', { class: 'coll-reps' });
    const listBox = el('div', { 'aria-live': 'polite' });
    const detailBox = el('div');

    const timeLabel = el('span', { class: 'refresh-time' });
    const refreshBtn = el('button', { type: 'button', class: 'btn-plain refresh' }, el('span', { class: 'ico ico-refresh', 'aria-hidden': 'true' }), timeLabel);
    const setTime = (text) => {
      timeLabel.textContent = text;
      refreshBtn.setAttribute('aria-label', text === 'جارٍ التحديث…' ? text : 'تحديث. آخر تحديث ' + text);
    };
    const updatedLine = el('div', { class: 'coll-updated' }, el('span', { class: 'muted small', text: 'الأرصدة من زوهو بوكس' }), refreshBtn);

    const catRow = el('div', { class: 'chips scroll', role: 'group', 'aria-label': 'الفئة حسب التأخر' });
    const catNote = el('p', { class: 'muted small coll-hint' });
    const search = el('input', { type: 'search', class: 'search', placeholder: 'بحث باسم العميل أو رقم الفاتورة', 'aria-label': 'بحث', enterkeyhint: 'search' });
    search.addEventListener('input', () => { st.q = norm(search.value); st.limit = PAGE; draw(); });
    const filters = el('div', { class: 'filters' }, updatedLine, catRow, search);

    function setCat(v) { st.cat = v; st.limit = PAGE; draw(); }

    // ——— القائمة ———

    function drawReps(d) {
      if (!d.is_admin) { repBox.replaceChildren(); return; }
      const codes = (d.reps || []).map((r) => (r.rep ? r.rep : '-'));
      const defs = [['', 'الكل'], ...codes.map((c) => [c, repLabel(c)])];
      const row = el('div', { class: 'chips scroll', role: 'group', 'aria-label': 'المندوب' }, defs.map(([v, t]) => {
        const b = el('button', { type: 'button', class: 'chip', 'aria-pressed': String(st.rep === v) }, v && v !== '-' ? ltr(t) : t);
        b.addEventListener('click', () => { if (st.rep === v) return; st.rep = v; saveRep(v); st.cat = ''; load(false); });
        return b;
      }));
      repBox.replaceChildren(row);
    }

    function drawKpis(d, list) {
      const all = total(list);
      const old = list.filter(isOld);
      const opening = list.reduce((t, c) => t + (c.late === null ? c.balance : 0), 0);
      const who = d.is_admin ? (st.rep ? (st.rep === '-' ? 'العملاء بلا مندوب' : null) : 'كل العملاء') : 'عملائك';
      const label = who ? `مجموع ديون ${who}` : null;
      const head = label ? el('div', { class: 'label', text: label }) : el('div', { class: 'label' }, 'مجموع ديون عملاء ', ltr(st.rep));
      const oldBtn = el('button', { type: 'button', class: 'kpi dark kpi-btn', 'aria-pressed': String(st.cat === 'old') },
        el('span', { class: 'label' }, 'متأخرة أكثر من 90 يوماً',
          el('span', { class: 'sub' }, old.length ? customersWord(old.length) : 'لا ديون قديمة',
            opening > 0 ? ' · منها افتتاحية ' : null, opening > 0 ? ltr(fmtAmount(opening)) : null)),
        el('span', { class: 'value display' }, ltr(fmtAmount(total(old)))));
      oldBtn.addEventListener('click', () => setCat(st.cat === 'old' ? '' : 'old'));
      kpiBox.replaceChildren(el('div', { class: 'kpis' },
        el('div', { class: 'kpi' }, head,
          el('div', { class: 'value display' }, ltr(fmtAmount(all))),
          el('div', { class: 'sub', text: list.length ? `على ${customersWord(list.length)}` : 'لا رصيد مفتوح' })),
        oldBtn));
    }

    function drawCats(list) {
      const counts = {};
      for (const c of list) { const k = catOf(c); counts[k] = (counts[k] || 0) + 1; }
      // الفئة القديمة تشمل الافتتاحية في المربع، لكن الفئات تفصل بينهما
      catRow.replaceChildren(...CATS.filter(([v]) => !v || counts[v] || (v === 'old' && st.cat === 'old')).map(([v, t]) => {
        const n = v ? (v === 'old' ? (counts.old || 0) + (counts.open || 0) : counts[v] || 0) : list.length;
        const b = el('button', { type: 'button', class: 'chip', 'aria-pressed': String(st.cat === v) }, t + ' ', el('span', { class: 'num', text: String(n) }));
        b.addEventListener('click', () => setCat(st.cat === v ? '' : v));
        return b;
      }));
      catNote.textContent = st.cat ? CAT_NOTE[st.cat] : '';
      catNote.classList.toggle('hidden', !st.cat);
    }

    function customerItem(c, d) {
      const facts = [el('span', { text: lateText(c) })];
      if (c.invoices.length > 1) facts.push(el('span', { class: 'dot', 'aria-hidden': 'true', text: '·' }), el('span', { text: invoicesWord(c.invoices.length) }));
      if (d.is_admin && !st.rep) facts.push(el('span', { class: 'dot', 'aria-hidden': 'true', text: '·' }), c.owner ? ltr(c.owner) : el('span', { text: 'بلا مندوب' }));
      const mark = isOld(c) ? el('span', { class: 'age late', text: c.late === null ? 'افتتاحي' : '+90 يوماً' }) : null;
      const li = el('li', { class: 'item linkable', tabindex: '0', role: 'link', 'aria-label': `${c.name}، ${fmtAmount(c.balance)}، ${lateText(c)}` },
        el('div', { class: 'item-body' },
          el('div', { class: 'item-main' }, el('div', { class: 'customer' }, ltr(c.name)), ltr(fmtAmount(c.balance), 'amount')),
          el('div', { class: 'item-sub' }, el('div', { class: 'facts' }, facts), mark)),
        el('span', { class: 'go', 'aria-hidden': 'true' }, el('span', { class: 'ico ico-chevron' })));
      const open = () => { location.hash = '#coll/c/' + c.id; };
      li.addEventListener('click', open);
      li.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); } });
      return li;
    }

    // ملخص المندوبين للمدير حين يختار «الكل»
    function repSummary(d) {
      const rows = (d.reps || []).map((r) => {
        const code = r.rep || '-';
        const li = el('li', { class: 'item linkable', tabindex: '0', role: 'button' },
          el('div', { class: 'item-body' },
            el('div', { class: 'item-main' }, el('div', { class: 'customer' }, r.rep ? ltr(r.rep) : el('span', { text: 'بلا مندوب' })), ltr(fmtAmount(r.total), 'amount')),
            el('div', { class: 'item-sub' }, el('div', { class: 'facts' },
              el('span', { text: customersWord(r.count) }), el('span', { class: 'dot', 'aria-hidden': 'true', text: '·' }),
              el('span', {}, 'أكثر من 90 يوماً ', ltr(fmtAmount(r.old)))))),
          el('span', { class: 'go', 'aria-hidden': 'true' }, el('span', { class: 'ico ico-chevron' })));
        const pick = () => { st.rep = code; saveRep(code); st.cat = ''; window.scrollTo(0, 0); load(false); };
        li.addEventListener('click', pick);
        li.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pick(); } });
        return li;
      });
      const det = el('details', { class: 'fold' },
        el('summary', {}, el('div', { class: 'block-head' }, el('h2', { text: 'حسب المندوب' }), el('span', { class: 'meta', text: `${rows.length} مندوبين` }))),
        el('ul', { class: 'list' }, rows));
      return det;
    }

    function drawList(d) {
      const list = d.customers;
      drawReps(d);
      drawKpis(d, list);
      drawCats(list);
      const inCat = (c) => !st.cat || (st.cat === 'old' ? isOld(c) : catOf(c) === st.cat);
      const match = (c) => !st.q || norm(c.name).includes(st.q) || c.invoices.some((i) => norm(i.number).includes(st.q));
      const items = list.filter((c) => inCat(c) && match(c));
      const shown = items.slice(0, st.limit);
      const more = items.length - shown.length;
      const moreBtn = more > 0 ? el('button', { type: 'button', class: 'btn-plain more', text: `عرض ${customersWord(more)} آخرين` }) : null;
      if (moreBtn) moreBtn.addEventListener('click', () => { st.limit += PAGE; draw(); });
      const title = st.cat ? CATS.find(([v]) => v === st.cat)[1] : 'كل المدينين';
      const parts = [];
      if (d.is_admin && !st.rep && d.reps && d.reps.length) parts.push(repSummary(d));
      parts.push(el('section', { class: 'block primary' },
        el('div', { class: 'block-head' }, el('h2', { text: title }), el('span', { class: 'meta' }, ltr(fmtAmount(total(items)), 'num'))),
        catNote,
        items.length
          ? el('ul', { class: 'list' }, shown.map((c) => customerItem(c, d)))
          : el('div', { class: 'empty', text: st.q ? 'لا عميل يطابق البحث.' : list.length ? 'لا عملاء في هذه الفئة.'
            : (d.is_admin ? 'لا أرصدة مفتوحة لهذا الاختيار.' : 'لا رصيد مفتوح على عملائك. إن كان هذا غير صحيح، تأكد مع الإدارة أن حقل «Owner» على عملائك في زوهو يحمل رمزك.') }),
        moreBtn));
      parts.push(el('p', { class: 'muted small coll-foot', text: 'أيام التأخر تُعدّ من تاريخ استحقاق أقدم فاتورة غير مسدّدة. الرصيد الافتتاحي هو ما نُقل عند بداية زوهو بوكس.' }));
      listBox.replaceChildren(...parts);
    }

    // ——— بطاقة العميل ———

    function drawCustomer(id) {
      const back = el('button', { type: 'button', class: 'btn-plain back' }, el('span', { class: 'ico ico-back', 'aria-hidden': 'true' }), el('span', { text: 'رجوع' }));
      back.addEventListener('click', () => { if (st.fromList) history.back(); else location.hash = '#coll'; });
      const top = el('div', { class: 'd-top' }, back, el('h1', { class: 'd-title', text: 'رصيد العميل' }));
      const c = st.data && st.data.customers.find((x) => x.id === id);
      if (!st.data) { detailBox.replaceChildren(top, el('p', { class: 'muted', text: 'جارٍ التحميل…' })); return; }
      if (!c) { detailBox.replaceChildren(top, el('div', { class: 'empty', text: 'لم يعد لهذا العميل رصيد مفتوح، أو ليس من عملائك.' })); return; }

      const repName = me.user.display_name;
      const msg = `السلام عليكم، معك ${repName} من ELONAC. نتصل بخصوص رصيدك عندنا، ${fmtAmount(c.balance).replace(' DA', '')} دج. متى يناسبك أن نسوّيه؟`;
      const head = el('div', { class: 'd-head' },
        el('div', { class: 'd-customer' }, ltr(c.name)),
        el('div', { class: 'd-amount display' }, ltr(fmtAmount(c.balance))),
        el('div', { class: 'd-badges' },
          el('span', { class: 'badge' + (isOld(c) ? ' warn' : ''), text: lateText(c) }),
          c.invoices.length ? el('span', { class: 'badge', text: invoicesWord(c.invoices.length) }) : null,
          st.data.is_admin ? el('span', { class: 'badge' }, c.owner ? ltr(c.owner) : 'بلا مندوب') : null));

      const kv = (label, ...v) => el('div', { class: 'kv' }, el('dt', { text: label }), el('dd', {}, ...v));
      const facts = el('section', { class: 'd-block' }, el('h2', { text: 'الرصيد' }), el('dl', { class: 'kvs' },
        kv('الرصيد في زوهو', ltr(fmtAmount(c.balance), 'num')),
        c.invoices.length ? kv('في الفواتير', ltr(fmtAmount(Math.round((c.balance - c.opening) * 100) / 100), 'num')) : null,
        c.opening > 0 ? kv('رصيد افتتاحي', ltr(fmtAmount(c.opening), 'num')) : null,
        c.invoices.length ? kv('أقدم استحقاق', ltr(fmtDate(c.invoices[0].due), 'num'), c.invoices[0].late ? el('span', { class: 'muted small', text: ` · متأخرة ${daysWord(c.invoices[0].late)}` }) : null) : null,
        kv('الهاتف', c.phone ? ltr(localPhone(c.phone), 'num') : el('span', { class: 'muted', text: 'لا رقم في زوهو' }))));

      const invs = c.invoices.length ? el('section', { class: 'd-block' }, el('h2', { text: 'الفواتير غير المسدّدة' }),
        el('ul', { class: 'd-list' }, c.invoices.map((i) => el('li', {},
          el('div', { class: 'd-line' }, ltr(i.number, 'strong'), ltr(fmtAmount(i.balance), 'num strong')),
          el('div', { class: 'muted small' }, 'بتاريخ ', ltr(fmtDate(i.date), 'num'), ' · الاستحقاق ', ltr(fmtDate(i.due), 'num'),
            i.late ? el('span', { class: i.late > 90 ? 'coll-late' : '', text: ` · متأخرة ${daysWord(i.late)}` }) : el('span', { text: ' · لم يحن موعدها' })))))) : null;

      const bar = el('div', { class: 'detailbar' },
        c.phone
          ? el('a', { class: 'btn btn-primary', href: 'tel:+' + c.phone, text: 'اتصال' })
          : el('button', { type: 'button', class: 'btn-primary is-blocked', text: 'اتصال', onclick: () => toast('لا رقم هاتف لهذا العميل في زوهو.', 'warn') }),
        c.phone
          ? el('a', { class: 'btn btn-plain', href: `https://wa.me/${c.phone}?text=${encodeURIComponent(msg)}`, target: '_blank', rel: 'noopener', text: 'واتساب' })
          : el('button', { type: 'button', class: 'btn-plain is-blocked', text: 'واتساب', onclick: () => toast('لا رقم هاتف لهذا العميل في زوهو.', 'warn') }));
      detailBox.replaceChildren(top, el('div', { class: 'detail' }, head, facts, invs, bar));
    }

    // ——— التوجيه والتحميل ———

    function draw() {
      const v = st.route.view;
      const isList = v === 'list';
      [repBox, kpiBox, filters, listBox].forEach((x) => x.classList.toggle('hidden', !isList));
      detailBox.classList.toggle('hidden', isList);
      if (!isList) { drawCustomer(st.route.id); return; }
      if (st.data) drawList(st.data);
      if (!st.busy) setTime(st.loadedAt ? relTime(st.loadedAt) : 'تحديث');
    }

    function route() {
      const prev = st.route;
      const next = parseRoute();
      if (prev.view === 'list') st.scroll = window.scrollY;
      st.fromList = next.view === 'customer' && prev.view === 'list';
      st.route = next;
      draw();
      window.scrollTo(0, next.view === 'list' ? st.scroll : 0);
    }
    window.addEventListener('hashchange', route);

    async function load(refresh) {
      if (st.busy) return;
      st.busy = true;
      refreshBtn.disabled = true;
      setTime('جارٍ التحديث…');
      try {
        const qs = new URLSearchParams();
        if (refresh) qs.set('refresh', '1');
        if (isAdmin && st.rep) qs.set('rep', st.rep);
        st.data = await api('/api/m/coll' + (qs.toString() ? '?' + qs : ''));
        st.loadedAt = Number(st.data.at) || Date.now();
        st.busy = false;
        draw();
      } catch (e) {
        if (!st.data) listBox.replaceChildren(el('div', { class: 'error-box', text: e.message }));
        else toast(e.message, 'err');
      } finally {
        st.busy = false;
        refreshBtn.disabled = false;
        setTime(st.loadedAt ? relTime(st.loadedAt) : 'تحديث');
      }
    }
    refreshBtn.addEventListener('click', () => load(true));
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible' && Date.now() - st.loadedAt > STALE_MS) load(false);
    });
    setInterval(() => { if (st.loadedAt && !st.busy) setTime(relTime(st.loadedAt)); }, 30_000);

    document.title = 'التحصيل';
    root.replaceChildren(repBox, kpiBox, filters, listBox, detailBox);
    listBox.replaceChildren(el('p', { class: 'muted', text: 'جارٍ تحميل أرصدة العملاء…' }));
    draw();
    await load(false);
  }

  window.ShikatiModules = window.ShikatiModules || {};
  window.ShikatiModules.coll = { render };
})();
