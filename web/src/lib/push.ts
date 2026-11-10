// إشعارات الهاتف من جهة الواجهة: الاشتراك من خدمة الإشعارات في الهاتف، وإرساله إلى الخادم (src/push.ts).
// في آيفون تعمل فقط بعد تثبيت التطبيق على الشاشة الرئيسية (iOS 16.4 وما بعده).
import { api, ApiError } from './api';

export type PushState = 'unsupported' | 'install' | 'denied' | 'off' | 'on';

const unb64u = (s: string) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4)), (c) => c.charCodeAt(0));
const isIos = () => /iPhone|iPad|iPod/.test(navigator.userAgent);
const standalone = () => window.matchMedia?.('(display-mode: standalone)').matches || (navigator as any).standalone === true;

function supported(): boolean {
  return 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
}

async function registration(): Promise<ServiceWorkerRegistration> {
  return (await navigator.serviceWorker.getRegistration('/')) || navigator.serviceWorker.register('/sw.js');
}

async function current(): Promise<PushSubscription | null> {
  if (!supported()) return null;
  try { return await (await registration()).pushManager.getSubscription(); } catch { return null; }
}

// حالة الإشعارات على هذا الهاتف
export async function pushState(): Promise<PushState> {
  if (!supported()) return isIos() && !standalone() ? 'install' : 'unsupported';
  if (Notification.permission === 'denied') return 'denied';
  return (await current()) && Notification.permission === 'granted' ? 'on' : 'off';
}

function deviceLabel(): string {
  const ua = navigator.userAgent;
  const m = ua.match(/Android [\d.]+; ([^;)]+)/);
  if (m) return m[1].replace(/Build.*$/, '').trim();
  if (/iPhone/.test(ua)) return 'آيفون';
  if (/iPad/.test(ua)) return 'آيباد';
  return 'هاتف';
}

// التفعيل: يطلب إذن الهاتف (يجب أن يكون من لمسة الموظف)، ثم يشترك ويرسل الاشتراك إلى الخادم
export async function enablePush(): Promise<{ ok: boolean; error?: string }> {
  try {
    const perm = await Notification.requestPermission();
    if (perm !== 'granted') return { ok: false, error: perm === 'denied' ? 'منعت الإشعارات في الهاتف. اسمح بها من إعدادات الهاتف لتطبيق ميداني، ثم حاول.' : undefined };
    const { key } = await api<{ key: string }>('/api/push/key');
    const reg = await registration();
    let sub = await reg.pushManager.getSubscription();
    // اشتراك قديم بمفتاح آخر لا يصلح: نلغيه ونشترك من جديد
    const old = sub?.options?.applicationServerKey;
    if (sub && old && btoa(String.fromCharCode(...new Uint8Array(old))) !== btoa(String.fromCharCode(...unb64u(key)))) {
      await sub.unsubscribe();
      sub = null;
    }
    if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: unb64u(key) });
    const j = sub.toJSON();
    await api('/api/push/subscribe', { method: 'POST', body: { endpoint: j.endpoint, keys: j.keys, label: deviceLabel() } });
    return { ok: true };
  } catch (e) {
    if (e instanceof ApiError) return { ok: false, error: e.message };
    return { ok: false, error: 'لم يكتمل تفعيل الإشعارات على هذا الهاتف. حاول بعد قليل.' };
  }
}

// الإيقاف: يُحذف الاشتراك من الخادم ومن الهاتف
export async function disablePush(): Promise<void> {
  const sub = await current();
  if (!sub) return;
  try { await api('/api/push/unsubscribe', { method: 'POST', body: { endpoint: sub.endpoint }, noRedirect: true }); } catch { /* نكمل */ }
  try { await sub.unsubscribe(); } catch { /* نكمل */ }
}

// عند كل فتح: إن كانت الإشعارات مفعّلة على الهاتف، نؤكد الاشتراك للخادم (لمن دخل أخيراً).
// إن حذفها المدير من الإدارة يرد الخادم revoked، فيلغي الهاتف اشتراكه، ويفعّلها الموظف من جديد إن شاء
export async function syncPush(): Promise<void> {
  if (!supported() || Notification.permission !== 'granted') return;
  const sub = await current();
  if (!sub) return;
  const j = sub.toJSON();
  try {
    const r = await api<{ revoked?: boolean }>('/api/push/subscribe', { method: 'POST', body: { endpoint: j.endpoint, keys: j.keys, label: deviceLabel(), sync: true }, noRedirect: true });
    if (r?.revoked) await sub.unsubscribe();
  } catch { /* ثانوي */ }
}

export async function testPush(): Promise<void> {
  await api('/api/push/test', { method: 'POST', body: {} });
}
