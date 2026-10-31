(function () {
  const { api, el, ltr, logout, fmtDateTime } = window.Shikati;
  const ROLE = { admin: 'مدير', depositor: 'مودِع' };
  const ACTION = {
    login: 'دخول', 'user.create': 'إنشاء مستخدم', 'user.disable': 'إيقاف مستخدم',
    'user.enable': 'تفعيل مستخدم', 'user.password': 'تغيير رمز سري', setup: 'الإعداد الأولي',
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

  async function refresh() {
    try { await Promise.all([loadUsers(), loadAudit()]); }
    catch (e) { alert(e.message); }
  }

  document.addEventListener('DOMContentLoaded', () => {
    document.getElementById('logout').addEventListener('click', logout);
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
