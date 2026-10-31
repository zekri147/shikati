(function () {
  const { api } = window.Shikati;
  const form = document.getElementById('login-form');
  const err = document.getElementById('login-error');
  const btn = document.getElementById('login-btn');

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    err.textContent = '';
    const username = form.username.value.trim();
    const password = form.password.value;
    if (!username || !password) { err.textContent = 'أدخل اسم المستخدم والرمز السري.'; return; }
    btn.disabled = true;
    btn.textContent = 'جارٍ الدخول…';
    try {
      await api('/api/login', { method: 'POST', body: { username, password }, noRedirect: true });
      location.href = '/';
    } catch (ex) {
      err.textContent = ex.message;
      form.password.value = '';
      form.password.focus();
    } finally {
      btn.disabled = false;
      btn.textContent = 'دخول';
    }
  });
})();
