// زر «تفعيل الإشعارات» في القائمة: يشترك هذا الهاتف في إشعارات التحصيل، أو يلغي اشتراكه
(function () {
  const { api, toast } = window.Shikati;

  function keyBytes(b64u) {
    const s = atob(b64u.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((b64u.length + 3) % 4));
    return Uint8Array.from(s, (c) => c.charCodeAt(0));
  }

  async function registration() {
    return navigator.serviceWorker.register('/sw.js').then(() => navigator.serviceWorker.ready);
  }

  async function currentSub() {
    const reg = await registration();
    return reg.pushManager.getSubscription();
  }

  function label(btn, on) {
    btn.textContent = on ? 'إيقاف الإشعارات' : 'تفعيل الإشعارات';
    btn.dataset.on = on ? '1' : '';
  }

  async function enable(btn) {
    const perm = await Notification.requestPermission();
    if (perm !== 'granted') {
      toast('رُفض إذن الإشعارات. فعّله من إعدادات الهاتف لهذا التطبيق، ثم أعد المحاولة.', 'err');
      return;
    }
    const { key } = await api('/api/push/key');
    const reg = await registration();
    const sub = (await reg.pushManager.getSubscription()) ||
      (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(key) }));
    await api('/api/push/subscribe', { method: 'POST', body: sub.toJSON() });
    label(btn, true);
    const r = await api('/api/push/test', { method: 'POST', body: {} });
    toast(r.sent ? 'تم تفعيل الإشعارات. وصلك إشعار تجربة الآن.' : 'تم تفعيل الإشعارات، لكن إشعار التجربة لم يُرسل. أخبر المدير.', r.sent ? 'ok' : 'warn');
  }

  async function disable(btn) {
    const sub = await currentSub();
    if (sub) {
      await api('/api/push/unsubscribe', { method: 'POST', body: { endpoint: sub.endpoint } }).catch(() => {});
      await sub.unsubscribe().catch(() => {});
    }
    label(btn, false);
    toast('أُوقفت الإشعارات على هذا الهاتف.');
  }

  document.addEventListener('DOMContentLoaded', async () => {
    const btn = document.getElementById('push-toggle');
    if (!btn || !('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) return;
    btn.classList.remove('hidden');
    try {
      const sub = await currentSub();
      label(btn, !!sub && Notification.permission === 'granted');
      // الاشتراك موجود في الهاتف: نذكّر الخادم به، فلا يضيع إن حُذف من القاعدة
      if (sub && Notification.permission === 'granted') api('/api/push/subscribe', { method: 'POST', body: sub.toJSON() }).catch(() => {});
    } catch { label(btn, false); }
    btn.addEventListener('click', async () => {
      btn.disabled = true;
      const on = btn.dataset.on === '1';
      btn.textContent = on ? 'جارٍ الإيقاف…' : 'جارٍ التفعيل…';
      try {
        if (on) await disable(btn); else await enable(btn);
      } catch (e) {
        label(btn, on);
        toast(e && e.message ? e.message : 'تعذّر تفعيل الإشعارات على هذا الهاتف.', 'err');
      } finally {
        btn.disabled = false;
      }
    });
  });
})();
