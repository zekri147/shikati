(function () {
  const { api } = window.Shikati;
  const form = document.getElementById('setup-form');
  const err = document.getElementById('setup-error');
  const btn = document.getElementById('setup-btn');
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    err.textContent = '';
    if (form.password.value !== form.password2.value) { err.textContent = 'الرمزان غير متطابقين.'; return; }
    btn.disabled = true;
    try {
      await api('/api/setup', { method: 'POST', noRedirect: true, body: {
        token: form.token.value,
        display_name: form.display_name.value.trim(),
        username: form.username.value.trim(),
        password: form.password.value,
      } });
      location.href = '/login';
    } catch (ex) {
      err.textContent = ex.message;
    } finally {
      btn.disabled = false;
    }
  });
})();
