// الدخول بالبصمة من جهة الهاتف: مفاتيح المرور (WebAuthn). الهاتف يطلب البصمة أو الوجه،
// ويوقّع التحدي بمفتاح لا يخرج منه. الخادم يتحقق في src/passkey.ts.
import { api, ApiError } from './api';
import { load, save } from './storage';

// علامة على هذا الهاتف: البصمة مفعّلة، فيظهر زرها في صفحة الدخول
const ON_KEY = 'shikati-passkey';
export const passkeyOnDevice = () => load(ON_KEY) === '1';

const b64u = (b: ArrayBuffer) => {
  let s = '';
  for (const c of new Uint8Array(b)) s += String.fromCharCode(c);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};
const unb64u = (s: string) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4)), (c) => c.charCodeAt(0));

// الهاتف فيه قفل بالبصمة أو الوجه، والمتصفح يدعم مفاتيح المرور
export async function passkeySupported(): Promise<boolean> {
  try {
    const P = window.PublicKeyCredential as any;
    return !!P && typeof P.isUserVerifyingPlatformAuthenticatorAvailable === 'function' && await P.isUserVerifyingPlatformAuthenticatorAvailable();
  } catch { return false; }
}

// الإلغاء من نافذة الهاتف ليس خطأً يُعرض
const cancelled = (e: unknown) => e instanceof DOMException && (e.name === 'NotAllowedError' || e.name === 'AbortError');
const failText = (e: unknown) => (e instanceof ApiError ? e.message : 'لم يكتمل طلب البصمة على هذا الهاتف.');

function deviceLabel(): string {
  const ua = navigator.userAgent;
  const m = ua.match(/Android [\d.]+; ([^;)]+)/);
  if (m) return m[1].replace(/Build.*$/, '').trim();
  if (/iPhone/.test(ua)) return 'آيفون';
  if (/iPad/.test(ua)) return 'آيباد';
  return 'هاتف';
}

// التفعيل: ok عند النجاح، وبلا خطأ عند إلغاء الموظف نافذة الهاتف، ومع نص الخطأ إن رُفض
export async function enablePasskey(): Promise<{ ok: boolean; error?: string }> {
  try {
    const o = await api('/api/passkey/register/options', { method: 'POST', body: {} });
    const cred = await navigator.credentials.create({ publicKey: {
      ...o,
      challenge: unb64u(o.challenge),
      user: { ...o.user, id: unb64u(o.user.id) },
      excludeCredentials: (o.excludeCredentials || []).map((c: any) => ({ ...c, id: unb64u(c.id) })),
    } }) as PublicKeyCredential | null;
    if (!cred) return { ok: false };
    const r = cred.response as any;
    const pk = typeof r.getPublicKey === 'function' ? r.getPublicKey() : null;
    if (!pk || typeof r.getAuthenticatorData !== 'function') return { ok: false, error: 'متصفح هذا الهاتف لا يدعم الدخول بالبصمة. حدّثه ثم حاول.' };
    await api('/api/passkey/register', { method: 'POST', body: {
      id: b64u(cred.rawId), clientDataJSON: b64u(r.clientDataJSON), authenticatorData: b64u(r.getAuthenticatorData()),
      publicKey: b64u(pk), alg: r.getPublicKeyAlgorithm(), label: deviceLabel(),
    } });
    save(ON_KEY, '1');
    return { ok: true };
  } catch (e) {
    if (e instanceof DOMException && e.name === 'InvalidStateError') { save(ON_KEY, '1'); return { ok: true }; }
    if (cancelled(e)) return { ok: false };
    return { ok: false, error: failText(e) };
  }
}

// الدخول: الهاتف يعرض مفاتيح هذا الموقع، والبصمة تفتح أحدها
export async function loginWithPasskey(): Promise<{ ok: boolean; error?: string }> {
  try {
    const o = await api('/api/passkey/login/options', { method: 'POST', body: {}, noRedirect: true });
    const cred = await navigator.credentials.get({ publicKey: { challenge: unb64u(o.challenge), rpId: o.rpId, timeout: o.timeout, userVerification: 'required' } }) as PublicKeyCredential | null;
    if (!cred) return { ok: false };
    const r = cred.response as AuthenticatorAssertionResponse;
    await api('/api/passkey/login', { method: 'POST', noRedirect: true, body: {
      id: b64u(cred.rawId), clientDataJSON: b64u(r.clientDataJSON), authenticatorData: b64u(r.authenticatorData), signature: b64u(r.signature),
    } });
    return { ok: true };
  } catch (e) {
    if (cancelled(e)) return { ok: false };
    // البصمة حُذفت من الإدارة: لا يظهر زرها بعد الآن حتى يُعاد تفعيلها
    if (e instanceof ApiError && e.status === 401) save(ON_KEY, '');
    return { ok: false, error: failText(e) };
  }
}
