// الهيكل العام: يقرأ المستخدم والأقسام المتاحة له، ويعرض القسم المطلوب.
// كل قسم يسجّل نفسه في window.ShikatiModules بنفس معرّفه في الخادم.
(function () {
  const { api, el } = window.Shikati;

  async function start() {
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
    const wanted = location.hash.slice(1).split('/')[0];
    const mod = available.find((m) => m.id === wanted) || available[0];
    document.title = mod.title;
    // روابط الأقسام الأخرى في القائمة (للمدير، ولمن يرى الشيكات والتحصيل معاً)
    const who = document.getElementById('who');
    const LABEL = { cheques: 'الشيكات', coll: 'التحصيل' };
    who.after(...available.filter((m) => m.id !== mod.id).map((m) =>
      el('a', { class: 'menu-item', href: '/#' + m.id, role: 'menuitem', text: LABEL[m.id] || m.title })));
    // الانتقال إلى قسم آخر يعيد تحميل الصفحة، لأن كل قسم يبني أشرطته بنفسه
    window.addEventListener('hashchange', () => {
      const next = location.hash.slice(1).split('/')[0];
      if (next && next !== mod.id && available.some((m) => m.id === next)) location.reload();
    });
    window.ShikatiModules[mod.id].render(view, me);
    if (mod.id === 'cheques') welcome(me);
  }

  // بطاقة ترحيب تظهر مرة واحدة على كل جهاز عند أول دخول: ثلاث خطوات، ومكان المساعدة
  const WELCOME_KEY = 'shikati-welcome-seen';
  function welcome(me) {
    try { if (localStorage.getItem(WELCOME_KEY) === '1') return; } catch { return; }
    const okBtn = el('button', { type: 'button', class: 'btn-primary', text: 'فهمت، ابدأ' });
    const helpBtn = el('a', { class: 'btn btn-plain', href: '/help', text: 'اقرأ المساعدة' });
    const dlg = el('dialog', { class: 'confirm welcome', 'aria-labelledby': 'welcome-title' },
      el('h2', { id: 'welcome-title', text: 'مرحباً ' + me.user.display_name }),
      el('p', { text: 'شيكاتي مكانك الوحيد لشيكات العملاء. عملك اليومي في ثلاث خطوات:' }),
      el('ol', { class: 'welcome-steps' },
        el('li', { text: 'سلّم الشيكات للبنك، ثم المس في شاشة «الإيداع» كل شيك سلّمته.' }),
        el('li', { text: 'اضغط «أودعت المحدد» في أسفل الشاشة، ثم «تأكيد الإيداع».' }),
        el('li', { text: 'لتسجيل شيك استلمته: تبويب «تسجيل» في الأسفل، ثم «تصوير الشيك».' })),
      el('p', { class: 'note', text: 'المساعدة في زر «القائمة» أعلى الشاشة، متى احتجتها.' }),
      el('div', { class: 'dlg-actions' }, okBtn, helpBtn));
    const seen = () => { try { localStorage.setItem(WELCOME_KEY, '1'); } catch { /* التخزين غير متاح */ } };
    const close = () => { seen(); dlg.close(); dlg.remove(); };
    okBtn.addEventListener('click', close);
    helpBtn.addEventListener('click', seen);
    dlg.addEventListener('cancel', (e) => { e.preventDefault(); close(); });
    document.body.append(dlg);
    dlg.showModal();
    okBtn.focus();
  }

  document.addEventListener('DOMContentLoaded', start);
})();
