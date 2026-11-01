(function () {
  const { api, el, ltr, logout, fmtDateTime, fmtAmount } = window.Shikati;
  const ROLE = { admin: 'مدير', depositor: 'مودِع' };
  const ACTION = {
    login: 'دخول', 'user.create': 'إنشاء مستخدم', 'user.disable': 'إيقاف مستخدم',
    'user.enable': 'تفعيل مستخدم', 'user.password': 'تغيير رمز سري', setup: 'الإعداد الأولي',
    deposit: 'إيداع شيك', 'deposit.release': 'تحرير إيداع',
  };
  const RESULT = { ok: 'تمّ', denied: 'مرفوض', error: 'خطأ' };

  async function loadUsers() {
    const { users } = await api('/api/admin/users');
    const tbody = document.getElementById('users');
    tbody.replaceChildren(...users.map((u) => {
      const act = async (path, body, confirmText) => {
        if (confirmText && !confirm(confirmText)) return;
        try { await api(`/api/admin/users/${u.id}/${path}`, { method: 'POST', body: body || {} }); await refresh(); }
        catch (e) { alert(e.message); }
      };
      return el('tr', {},
        el('td', { text: u.display_name }),
        el('td', {}, ltr(u.username)),
        el('td', { text: ROLE[u.role] || u.role }),
        el('td', { text: u.active ? 'نشط' : 'موقوف' }),
        el('td', {}, el('div', { class: 'row-actions' },
          u.active
            ? el('button', { type: 'button', class: 'btn-plain', text: 'إيقاف', onclick: () => act('disable', null, `إيقاف ${u.display_name} الآن؟ سيُخرج من التطبيق فوراً.`) })
            : el('button', { type: 'button', class: 'btn-plain', text: 'تفعيل', onclick: () => act('enable') }),
          el('button', { type: 'button', class: 'btn-plain', text: 'رمز جديد', onclick: () => {
            const pw = prompt(`الرمز السري الجديد لـ ${u.display_name} (8 أحرف على الأقل):`);
            if (pw) act('password', { password: pw });
          } }),
        )),
      );
    }));
  }

  async function loadAudit() {
    const { entries } = await api('/api/admin/audit');
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
          ? el('button', { type: 'button', class: 'btn-plain', text: 'تحرير', onclick: async () => {
              if (!confirm('هل تحققت في زوهو؟ التحرير يسمح بمحاولة إيداع جديدة لهذا الشيك.')) return;
              try { await api(`/api/admin/deposits/${d.payment_id}/release`, { method: 'POST', body: {} }); await refresh(); }
              catch (e) { alert(e.message); }
            } })
          : ''),
      );
    }));
    document.getElementById('dep-attention').hidden = !attention;
  }

  async function refresh() {
    try { await Promise.all([loadUsers(), loadDeposits(), loadAudit()]); }
    catch (e) { alert(e.message); }
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
    document.getElementById('logout').addEventListener('click', logout);
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
          password: form.password.value,
        } });
        form.reset();
        await refresh();
      } catch (ex) { err.textContent = ex.message; }
    });
    refresh();
  });
})();
