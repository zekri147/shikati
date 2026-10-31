// الهيكل العام: يقرأ المستخدم والأقسام المتاحة له، ويعرض القسم المطلوب.
// كل قسم يسجّل نفسه في window.ShikatiModules بنفس معرّفه في الخادم.
(function () {
  const { api, el, logout } = window.Shikati;

  async function start() {
    document.getElementById('logout').addEventListener('click', logout);
    const view = document.getElementById('view');
    let me;
    try {
      me = await api('/api/me');
    } catch (e) {
      view.replaceChildren(el('div', { class: 'error-box', text: e.message }));
      return;
    }
    document.getElementById('who').textContent = me.user.display_name;
    if (me.user.role === 'admin') document.getElementById('admin-link').classList.remove('hidden');

    const available = me.modules.filter((m) => window.ShikatiModules && window.ShikatiModules[m.id]);
    if (!available.length) {
      view.replaceChildren(el('p', { class: 'muted', text: 'لا توجد أقسام متاحة لحسابك.' }));
      return;
    }
    const wanted = location.hash.slice(1);
    const mod = available.find((m) => m.id === wanted) || available[0];
    document.title = mod.title;
    window.ShikatiModules[mod.id].render(view, me);
  }

  document.addEventListener('DOMContentLoaded', start);
})();
