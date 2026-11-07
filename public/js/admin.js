(function () {
  const { api, el, ltr, toast, fmtDateTime, fmtAmount } = window.Shikati;
  const ROLE = { admin: 'مدير', depositor: 'مودِع', rep: 'مندوب' };
  const ACTION = {
    login: 'دخول', 'user.create': 'إنشاء مستخدم', 'user.disable': 'إيقاف مستخدم',
    'user.enable': 'تفعيل مستخدم', 'user.password': 'تغيير رمز سري', 'user.rep': 'تغيير رمز المندوب', setup: 'الإعداد الأولي',
    deposit: 'إيداع شيك', 'deposit.release': 'تحرير إيداع', 'deposit.reverted': 'إيداع أُلغي في زوهو',
  };
  const RESULT = { ok: 'تمّ', denied: 'مرفوض', error: 'خطأ' };

  // بطاقة تأكيد بشكل التطبيق بدل نوافذ المتصفح. مع password يطلب رمزاً سرياً في حقل مخفي.
  // مع field يطلب نصاً قصيراً (رمز المندوب). run تنفّذ العملية، وخطؤها يظهر داخل البطاقة دون إغلاقها.
  function ask({ title, text, okText, danger, password, field, run }) {
    const input = password ? el('input', { type: 'password', dir: 'ltr', autocomplete: 'new-password', minlength: '8' })
      : field ? el('input', { type: 'text', dir: 'ltr', autocapitalize: 'characters', spellcheck: 'false', value: field.value || '', placeholder: field.placeholder || '' }) : null;
    const message = el('div', { role: 'alert' });
    const okBtn = el('button', { type: 'button', class: danger ? 'btn-danger' : 'btn-primary', text: okText });
    const cancelBtn = el('button', { type: 'button', class: 'btn-plain', text: 'إلغاء' });
    const dlg = el('dialog', { class: 'confirm', 'aria-labelledby': 'ask-title' },
      el('h2', { id: 'ask-title', text: title }),
      el('p', { text }),
      input ? el('div', { class: 'field' }, el('label', {}, el('span', { text: field ? field.label : 'الرمز السري الجديد (8 أحرف على الأقل)' }), input)) : null,
      message,
      el('div', { class: 'dlg-actions' }, okBtn, cancelBtn));
    let busy = false;
    const close = () => { if (busy) return; dlg.close(); dlg.remove(); };
    cancelBtn.addEventListener('click', close);
    dlg.addEventListener('cancel', (e) => { e.preventDefault(); close(); });
    okBtn.addEventListener('click', async () => {
      if (password && input.value.length < 8) { message.className = 'form-error'; message.textContent = 'الرمز السري 8 أحرف على الأقل.'; return; }
      busy = true; okBtn.disabled = true; cancelBtn.disabled = true;
      try {
        await run(input ? input.value : undefined);
        busy = false; close();
      } catch (e) {
        busy = false; okBtn.disabled = false; cancelBtn.disabled = false;
        message.className = 'form-error'; message.textContent = e.message;
      }
    });
    document.body.append(dlg);
    dlg.showModal();
    (input || cancelBtn).focus();
  }

  // المستخدمون في بطاقات: الاسم والدور، ثم اسم الدخول والحالة، ثم الأزرار
  async function loadUsers() {
    const { users } = await api('/api/admin/users');
    const list = document.getElementById('users');
    list.replaceChildren(...users.map((u) => {
      const post = (path, body) => api(`/api/admin/users/${u.id}/${path}`, { method: 'POST', body: body || {} });
      const toggle = u.active
        ? el('button', { type: 'button', class: 'btn-danger', text: 'إيقاف', onclick: () => ask({
          title: 'إيقاف ' + u.display_name, text: 'سيُخرج من التطبيق فوراً، ولن يستطيع الدخول حتى تعيد تفعيله.',
          okText: 'إيقاف', danger: true, run: async () => { await post('disable'); toast('أُوقف ' + u.display_name); await refresh(); },
        }) })
        : el('button', { type: 'button', class: 'btn-plain', text: 'تفعيل', onclick: async () => {
          try { await post('enable'); toast('فُعّل ' + u.display_name); await refresh(); } catch (e) { toast(e.message, 'err'); }
        } });
      const pw = el('button', { type: 'button', class: 'btn-plain', text: 'رمز سري جديد', onclick: () => ask({
        title: 'رمز سري جديد لـ ' + u.display_name, text: 'أعطه الرمز الجديد بنفسك، لا في رسالة مكتوبة.',
        okText: 'حفظ الرمز', password: true, run: async (p) => { await post('password', { password: p }); toast('حُفظ الرمز السري الجديد'); await refresh(); },
      }) });
      // رمز المندوب: يربط المستخدم بعملائه في زوهو (حقل «Owner») فيرى تحصيلهم
      const rep = el('button', { type: 'button', class: 'btn-plain', text: 'رمز المندوب', onclick: () => ask({
        title: 'رمز المندوب لـ ' + u.display_name,
        text: u.role === 'rep'
          ? 'اكتبه كما في حقل «Owner» على العميل في زوهو. يرى المندوب عملاء هذا الرمز فقط.'
          : 'اكتبه كما في حقل «Owner» في زوهو ليرى قسم التحصيل لعملائه. اتركه فارغاً لإزالته.',
        okText: 'حفظ الرمز', field: { label: 'رمز المندوب', value: u.rep_code || '', placeholder: 'AMINE' },
        run: async (code) => { await post('rep', { rep_code: code }); toast('حُفظ رمز المندوب'); await refresh(); },
      }) });
      const facts = [ltr(u.username), el('span', { class: 'dot', 'aria-hidden': 'true', text: '·' }), el('span', { text: u.active ? 'نشط' : 'موقوف' })];
      if (u.rep_code) facts.push(el('span', { class: 'dot', 'aria-hidden': 'true', text: '·' }), el('span', {}, 'مندوب ', ltr(u.rep_code)));
      return el('li', { class: 'item user' + (u.active ? '' : ' off') },
        el('div', { class: 'item-body' },
          el('div', { class: 'item-main' }, el('div', { class: 'customer', text: u.display_name }), el('span', { class: 'badge', text: ROLE[u.role] || u.role })),
          el('div', { class: 'item-sub' }, el('div', { class: 'facts' }, facts)),
          el('div', { class: 'user-actions' }, toggle, pw, rep)));
    }));
  }

  // صف فارغ بجملة واضحة بدل جدول بلا صفوف
  const emptyRow = (cols, text) => el('tr', {}, el('td', { colspan: String(cols), class: 'muted empty-cell', text }));

  async function loadAudit() {
    const { entries } = await api('/api/admin/audit');
    if (!entries.length) { document.getElementById('audit').replaceChildren(emptyRow(5, 'لا عمليات مسجّلة بعد.')); return; }
    document.getElementById('audit').replaceChildren(...entries.map((a) => el('tr', {},
      el('td', { class: 'nowrap' }, ltr(fmtDateTime(a.at), 'num')),
      el('td', {}, a.username ? ltr(a.username) : el('span', { class: 'muted', text: '—' })),
      el('td', { text: ACTION[a.action] || a.action }),
      el('td', {}, a.target ? ltr(a.target) : ''),
      el('td', { text: RESULT[a.result] || a.result }),
    )));
  }

  const DEP_STATE = { pending: 'قيد التنفيذ', done: 'تم', failed: 'لم يتم', unknown: 'بانتظار التحقق' };

  async function loadDeposits() {
    const { deposits } = await api('/api/admin/deposits');
    let attention = false;
    if (!deposits.length) {
      document.getElementById('deposits').replaceChildren(emptyRow(8, 'لا محاولات إيداع بعد.'));
      document.getElementById('dep-attention').hidden = true;
      return;
    }
    document.getElementById('deposits').replaceChildren(...deposits.map((d) => {
      const state = d.stale ? 'unknown' : d.state;
      if (state === 'unknown') attention = true;
      return el('tr', {},
        el('td', { class: 'nowrap' }, ltr(fmtDateTime(d.started_at), 'num')),
        el('td', { text: d.display_name || '—' }),
        el('td', { text: d.customer || '—' }),
        el('td', {}, d.cheque_number ? ltr(d.cheque_number, 'num') : '—'),
        el('td', { class: 'nowrap' }, d.amount != null ? ltr(fmtAmount(d.amount), 'num') : '—'),
        el('td', { class: 'nowrap', text: DEP_STATE[state] || state }),
        el('td', { text: d.message || '' }),
        el('td', {}, state === 'unknown'
          ? el('button', { type: 'button', class: 'btn-danger', text: 'تحرير', onclick: () => ask({
              title: 'تحرير قفل الإيداع', text: 'هل تحققت في زوهو أن الإيداع لم يُنشأ، أو صحّحته يدوياً؟ التحرير يسمح بمحاولة إيداع جديدة لهذا الشيك.',
              okText: 'تحرير القفل', danger: true,
              run: async () => { await api(`/api/admin/deposits/${d.payment_id}/release`, { method: 'POST', body: {} }); toast('حُرّر القفل'); await refresh(); },
            }) })
          : ''),
      );
    }));
    document.getElementById('dep-attention').hidden = !attention;
  }

  async function refresh() {
    try { await Promise.all([loadUsers(), loadDeposits(), loadAudit()]); }
    catch (e) { toast(e.message, 'err'); }
  }

  async function runReconcile() {
    const btn = document.getElementById('rec-run');
    const out = document.getElementById('rec-out');
    btn.disabled = true; btn.textContent = 'جارٍ المطابقة…';
    try {
      const r = await api('/api/admin/reconcile');
      const table = (head, rows) => el('div', { class: 'table-wrap' }, el('table', {},
        el('thead', {}, el('tr', {}, head.map((h) => el('th', { text: h })))),
        el('tbody', {}, rows)));
      const appRows = r.app.items.map((d) => el('tr', {},
        el('td', { class: d.ok ? '' : 'strong', text: d.ok ? 'سليم' : 'للمراجعة: ' + d.problem }),
        el('td', { text: d.customer || '—' }),
        el('td', {}, d.cheque_number ? ltr(d.cheque_number, 'num') : '—'),
        el('td', { class: 'nowrap' }, d.amount != null ? ltr(fmtAmount(d.amount), 'num') : '—'),
        el('td', { text: d.display_name || '—' }),
        el('td', { class: 'nowrap' }, ltr(fmtDateTime(d.finished_at || ''), 'num')),
      ));
      const fmtIso = (iso) => {
        const t = new Date(String(iso || '').replace(/([+-]\d{2})(\d{2})$/, '$1:$2'));
        return Number.isNaN(t.getTime()) ? '—' : fmtDateTime(t.toISOString().slice(0, 19).replace('T', ' '));
      };
      const outRows = r.outside.items.map((d) => el('tr', {},
        el('td', { text: d.customer }),
        el('td', {}, d.cheque_number ? ltr(d.cheque_number, 'num') : '—'),
        el('td', { class: 'nowrap' }, ltr(fmtAmount(d.amount), 'num')),
        el('td', { text: d.status }),
        el('td', { class: 'nowrap' }, ltr(fmtIso(d.modified), 'num')),
      ));
      out.replaceChildren(
        el('h3', { text: `إيداعات سجّلها التطبيق: ${r.app.count}، منها للمراجعة: ${r.app.problems}` }),
        r.app.count ? table(['النتيجة', 'العميل', 'الشيك', 'المبلغ', 'الموظف', 'الوقت'], appRows)
          : el('p', { class: 'muted', text: 'لا إيداعات من التطبيق في آخر 7 أيام.' }),
        el('h3', { text: `شيكات AGB مودعة من خارج التطبيق: ${r.outside.count}` }),
        el('p', { class: 'muted small', text: 'من القسم القديم أو يدوياً في زوهو. التاريخ هو آخر تعديل للدفعة، وهو تقريبي.' }),
        r.outside.count ? table(['العميل', 'الشيك', 'المبلغ', 'الحالة', 'آخر تعديل'], outRows)
          : el('p', { class: 'muted', text: 'لا شيء.' }),
      );
    } catch (e) {
      out.replaceChildren(el('div', { class: 'error-box', text: e.message }));
    } finally {
      btn.disabled = false; btn.textContent = 'تشغيل المطابقة';
    }
  }

  document.addEventListener('DOMContentLoaded', () => {
    document.getElementById('rec-run').addEventListener('click', runReconcile);
    const form = document.getElementById('new-user');
    const err = document.getElementById('nu-error');
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      err.textContent = '';
      try {
        await api('/api/admin/users', { method: 'POST', body: {
          display_name: form.display_name.value.trim(),
          username: form.username.value.trim(),
          role: form.role.value,
          rep_code: form.rep_code.value.trim(),
          password: form.password.value,
        } });
        form.reset();
        toast('أُضيف المستخدم');
        await refresh();
      } catch (ex) { err.textContent = ex.message; }
    });
    refresh();
  });
})();
