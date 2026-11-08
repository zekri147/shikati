import type { Env, User } from './env';
import { HttpError, json, readJson } from './http';
import { audit } from './audit';

// إشعارات الهاتف (8/11/2026، بطلب ZEKRI): الإشعارات الفورية للويب (Web Push) دون مكتبة.
// - الهاتف يشترك من خدمة الإشعارات في نظامه (غوغل لأندرويد، وآبل لآيفون المثبَّت عليه التطبيق)،
//   ويرسل إلينا عنوان الاشتراك ومفتاحيه، فنحفظها في الجدول push_subs.
// - الخادم يوقّع كل طلب بمفتاح VAPID (‏ES256)، ويشفّر نص الإشعار لهاتف واحد (RFC 8291، ‏aes128gcm)،
//   فلا تقرأ خدمة غوغل أو آبل النص.
// - مفتاح VAPID يُولَّد مرة واحدة ويُحفظ في الجدول app_keys. لا يسمح إلا بإرسال إشعار إلى هواتف
//   اشتركت في التطبيق، ولا علاقة له بزوهو. إن حُذف، تتوقف الاشتراكات القديمة ويشترك كل هاتف من جديد.
// - قراءة فقط: لا شيء هنا يكتب في زوهو.

const enc = new TextEncoder();
const VAPID_SUB = 'https://shikati.zekri3047.workers.dev';
// خدمات الإشعارات المعروفة وحدها، حتى لا يصير الخادم وسيطاً لطلبات إلى عناوين أخرى
const PUSH_HOSTS = /^(fcm\.googleapis\.com|android\.googleapis\.com|updates\.push\.services\.mozilla\.com|push\.services\.mozilla\.com|[a-z0-9.-]+\.push\.apple\.com|[a-z0-9.-]+\.notify\.windows\.com)$/;
const B64U_RE = /^[A-Za-z0-9_-]+$/;
const MAX_SUBS_PER_USER = 5;
const SEND_TIMEOUT_MS = 8000;

export interface PushMessage {
  title: string;
  body: string;
  url?: string;   // ما يفتحه لمس الإشعار، مثل ‎/#cheques/c/<معرّف>
  tag?: string;   // إشعار بنفس الوسم يحل محل السابق بدل أن يتكدّس
}

const b64u = (b: ArrayBuffer | Uint8Array) => {
  const u = b instanceof Uint8Array ? b : new Uint8Array(b);
  let s = '';
  for (const c of u) s += String.fromCharCode(c);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};
const unb64u = (s: string) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4)), (c) => c.charCodeAt(0));
const concat = (...parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let i = 0;
  for (const p of parts) { out.set(p, i); i += p.length; }
  return out;
};

// ——— مفتاح VAPID ———

interface Vapid { publicKey: string; privateJwk: JsonWebKey }
let vapidMemo: Vapid | null = null;

export async function vapidKeys(env: Env): Promise<Vapid> {
  if (vapidMemo) return vapidMemo;
  const read = async () => {
    const row = await env.DB.prepare("SELECT value FROM app_keys WHERE name = 'vapid'").first<{ value: string }>();
    return row ? (JSON.parse(row.value) as Vapid) : null;
  };
  let v = await read();
  if (!v) {
    const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']) as CryptoKeyPair;
    const raw = await crypto.subtle.exportKey('raw', pair.publicKey) as ArrayBuffer;
    const jwk = await crypto.subtle.exportKey('jwk', pair.privateKey) as JsonWebKey;
    // طلبان متزامنان: يبقى المفتاح الأول وحده
    await env.DB.prepare("INSERT OR IGNORE INTO app_keys (name, value) VALUES ('vapid', ?)")
      .bind(JSON.stringify({ publicKey: b64u(raw), privateJwk: jwk })).run();
    v = await read();
    if (!v) throw new Error('vapid key not stored');
  }
  vapidMemo = v;
  return v;
}

async function vapidHeader(env: Env, endpoint: string): Promise<string> {
  const v = await vapidKeys(env);
  const key = await crypto.subtle.importKey('jwk', v.privateJwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  const head = b64u(enc.encode(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const claims = b64u(enc.encode(JSON.stringify({ aud: new URL(endpoint).origin, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: VAPID_SUB })));
  // توقيع WebCrypto بصيغة r||s، وهي صيغة JWS نفسها
  const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, enc.encode(`${head}.${claims}`));
  return `vapid t=${head}.${claims}.${b64u(sig)}, k=${v.publicKey}`;
}

// ——— التشفير لهاتف واحد (RFC 8291 وRFC 8188) ———

async function hkdf(salt: Uint8Array, ikm: Uint8Array, info: Uint8Array, bytes: number): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info }, key, bytes * 8));
}

export async function encryptPayload(payload: Uint8Array, p256dh: string, authSecret: string): Promise<Uint8Array> {
  const uaPublic = unb64u(p256dh);
  const auth = unb64u(authSecret);
  const eph = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']) as CryptoKeyPair;
  const asPublic = new Uint8Array(await crypto.subtle.exportKey('raw', eph.publicKey) as ArrayBuffer);
  const uaKey = await crypto.subtle.importKey('raw', uaPublic, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: uaKey } as any, eph.privateKey, 256));

  const ikm = await hkdf(auth, shared, concat(enc.encode('WebPush: info\0'), uaPublic, asPublic), 32);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const cek = await hkdf(salt, ikm, enc.encode('Content-Encoding: aes128gcm\0'), 16);
  const nonce = await hkdf(salt, ikm, enc.encode('Content-Encoding: nonce\0'), 12);

  const key = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['encrypt']);
  // سجل واحد أخير: النص ثم 0x02
  const cipher = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, key, concat(payload, new Uint8Array([2]))));
  const rs = new Uint8Array([0, 0, 16, 0]); // 4096
  return concat(salt, rs, new Uint8Array([asPublic.length]), asPublic, cipher);
}

// ——— الإرسال ———

interface SubRow { endpoint: string; user_id: number; p256dh: string; auth: string }

function allowedEndpoint(env: Env, endpoint: string): boolean {
  let u: URL;
  try { u = new URL(endpoint); } catch { return false; }
  if (u.protocol === 'https:' && PUSH_HOSTS.test(u.hostname)) return true;
  // التجربة المحلية فقط: خدمة إشعارات وهمية على هذا الجهاز (PUSH_ALLOW_LOCAL في .dev.vars)
  return env.PUSH_ALLOW_LOCAL === '1' && u.protocol === 'http:' && (u.hostname === '127.0.0.1' || u.hostname === 'localhost');
}

// يرسل إلى اشتراك واحد. الاشتراك المنتهي (404 أو 410) يُحذف. لا إعادة: الإشعار تنبيه لا عملية
async function sendOne(env: Env, s: SubRow, msg: PushMessage): Promise<boolean> {
  if (!allowedEndpoint(env, s.endpoint)) return false;
  try {
    const body = await encryptPayload(enc.encode(JSON.stringify(msg)), s.p256dh, s.auth);
    const res = await fetch(s.endpoint, {
      method: 'POST',
      headers: {
        Authorization: await vapidHeader(env, s.endpoint),
        'Content-Encoding': 'aes128gcm',
        'Content-Type': 'application/octet-stream',
        TTL: '86400',
        Urgency: 'high',
      },
      body,
      signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
    });
    if (res.status === 404 || res.status === 410) {
      await env.DB.prepare('DELETE FROM push_subs WHERE endpoint = ?').bind(s.endpoint).run();
      return false;
    }
    if (!res.ok) {
      console.error('push', res.status, new URL(s.endpoint).hostname, (await res.text()).slice(0, 200));
      await env.DB.prepare('UPDATE push_subs SET fails = fails + 1 WHERE endpoint = ?').bind(s.endpoint).run();
      return false;
    }
    await env.DB.prepare("UPDATE push_subs SET fails = 0, last_ok_at = datetime('now') WHERE endpoint = ?").bind(s.endpoint).run();
    return true;
  } catch (e) {
    console.error('push send', e instanceof Error ? e.message : e);
    return false;
  }
}

// يرسل الإشعار إلى كل أجهزة هؤلاء المستخدمين النشطين. يعيد عدد الأجهزة التي وصلها
export async function notifyUsers(env: Env, userIds: Iterable<number>, msg: PushMessage): Promise<number> {
  const ids = [...new Set(userIds)].filter((n) => Number.isInteger(n) && n > 0);
  if (!ids.length) return 0;
  const { results } = await env.DB.prepare(
    `SELECT s.endpoint, s.user_id, s.p256dh, s.auth FROM push_subs s JOIN users u ON u.id = s.user_id
     WHERE u.active = 1 AND s.user_id IN (${ids.map(() => '?').join(',')})`,
  ).bind(...ids).all<SubRow>();
  const sent = await Promise.all(results.map((s) => sendOne(env, s, msg)));
  return sent.filter(Boolean).length;
}

// لا يُفشل العملية الأصلية أبداً: الإشعار إضافة، والعهدة أو الإيداع أهم منه
export async function notifySafe(env: Env, userIds: Iterable<number>, msg: PushMessage): Promise<void> {
  try { await notifyUsers(env, userIds, msg); } catch (e) { console.error('notify', e instanceof Error ? e.message : e); }
}

export async function hasSubscribers(env: Env): Promise<boolean> {
  return !!(await env.DB.prepare('SELECT 1 FROM push_subs LIMIT 1').first());
}

// ——— واجهة الهاتف: ‎/api/push/… ———

export async function handlePush(req: Request, env: Env, user: User, path: string): Promise<Response> {
  if (path === '/key' && req.method === 'GET') {
    return json({ key: (await vapidKeys(env)).publicKey });
  }

  if (path === '/subscribe' && req.method === 'POST') {
    const b = await readJson<{ endpoint?: string; keys?: { p256dh?: string; auth?: string }; label?: string }>(req);
    const endpoint = String(b.endpoint || '');
    const p256dh = String(b.keys?.p256dh || '');
    const auth = String(b.keys?.auth || '');
    if (endpoint.length > 1000 || !allowedEndpoint(env, endpoint)) throw new HttpError(400, 'خدمة الإشعارات في هذا الهاتف غير معروفة.');
    if (!B64U_RE.test(p256dh) || unb64u(p256dh).length !== 65 || !B64U_RE.test(auth) || unb64u(auth).length !== 16) {
      throw new HttpError(400, 'اشتراك الإشعارات غير صالح.');
    }
    const label = String(b.label || '').slice(0, 60) || null;
    // التأكيد عند كل فتح (syncPush في الواجهة): لا كتابة ولا سجل إن لم يتغيّر شيء
    const same = await env.DB.prepare('SELECT 1 FROM push_subs WHERE endpoint = ? AND user_id = ? AND p256dh = ? AND auth = ?')
      .bind(endpoint, user.id, p256dh, auth).first();
    if (same) return json({ ok: true });
    // الهاتف نفسه لمستخدم واحد: من دخل أخيراً تصله إشعاراته
    await env.DB.prepare(
      "INSERT INTO push_subs (endpoint, user_id, p256dh, auth, label) VALUES (?, ?, ?, ?, ?) " +
      "ON CONFLICT(endpoint) DO UPDATE SET user_id = excluded.user_id, p256dh = excluded.p256dh, auth = excluded.auth, label = excluded.label, fails = 0, created_at = datetime('now')",
    ).bind(endpoint, user.id, p256dh, auth, label).run();
    // أقدم الأجهزة تُحذف بعد الخامس
    await env.DB.prepare(
      'DELETE FROM push_subs WHERE user_id = ? AND endpoint NOT IN (SELECT endpoint FROM push_subs WHERE user_id = ? ORDER BY created_at DESC LIMIT ?)',
    ).bind(user.id, user.id, MAX_SUBS_PER_USER).run();
    await audit(env, user, 'push.subscribe', 'ok', label);
    return json({ ok: true });
  }

  if (path === '/unsubscribe' && req.method === 'POST') {
    const b = await readJson<{ endpoint?: string }>(req);
    await env.DB.prepare('DELETE FROM push_subs WHERE endpoint = ? AND user_id = ?').bind(String(b.endpoint || ''), user.id).run();
    await audit(env, user, 'push.unsubscribe', 'ok');
    return json({ ok: true });
  }

  // إشعار تجريبي لأجهزة المستخدم نفسه، ليتأكد أنها تصل
  if (path === '/test' && req.method === 'POST') {
    const n = await notifyUsers(env, [user.id], {
      title: 'ميداني',
      body: 'الإشعارات تعمل على هذا الهاتف. ستصلك هنا تنبيهات الشيكات والمراجعة.',
      url: '/#cheques/alerts',
      tag: 'test',
    });
    if (!n) throw new HttpError(502, 'لم يصل الإشعار التجريبي. أوقف الإشعارات ثم فعّلها من جديد.');
    return json({ ok: true, devices: n });
  }

  throw new HttpError(404, 'غير موجود.');
}
