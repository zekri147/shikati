import type { Env, User } from './env';
import { HttpError, json, readJson } from './http';

// إشعارات الهاتف (Web Push) دون مكتبات خارجية:
//   - التوقيع بمعيار VAPID (رمز JWT بخوارزمية ES256)
//   - تشفير المحتوى بمعيار RFC 8291 (aes128gcm)
// مفتاحا VAPID يُنشئهما الخادم بنفسه عند أول استعمال ويحفظهما في جدول app_meta،
// فلا يمر أي سر في المحادثة ولا في المستودع. المفتاح لا يفيد إلا في إرسال إشعارات لأجهزتنا المسجّلة.

export interface PushPayload {
  title: string;
  body: string;
  url: string;
  tag?: string;
}

interface SubRow {
  endpoint: string;
  user_id: number;
  p256dh: string;
  auth: string;
}

const enc = new TextEncoder();

function b64uEncode(buf: ArrayBuffer | Uint8Array): string {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function b64uDecode(s: string): Uint8Array {
  const pad = s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4);
  const bin = atob(pad);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

interface Vapid { pub: string; d: string }
let vapidCache: Vapid | null = null;

async function getVapid(env: Env): Promise<Vapid> {
  if (vapidCache) return vapidCache;
  const row = await env.DB.prepare("SELECT value FROM app_meta WHERE key = 'vapid'").first<{ value: string }>();
  if (row) return (vapidCache = JSON.parse(row.value) as Vapid);
  const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']) as CryptoKeyPair;
  const jwk = await crypto.subtle.exportKey('jwk', pair.privateKey) as JsonWebKey;
  const pub = b64uEncode(await crypto.subtle.exportKey('raw', pair.publicKey) as ArrayBuffer);
  // إن أنشأ طلبان المفتاح معاً، يبقى الأول فقط ويقرأ الثاني ما حُفظ
  await env.DB.prepare("INSERT OR IGNORE INTO app_meta (key, value) VALUES ('vapid', ?)").bind(JSON.stringify({ pub, d: jwk.d })).run();
  const saved = await env.DB.prepare("SELECT value FROM app_meta WHERE key = 'vapid'").first<{ value: string }>();
  return (vapidCache = JSON.parse(saved!.value) as Vapid);
}

async function signingKey(v: Vapid): Promise<CryptoKey> {
  const pub = b64uDecode(v.pub);
  return crypto.subtle.importKey('jwk', {
    kty: 'EC', crv: 'P-256',
    x: b64uEncode(pub.slice(1, 33)), y: b64uEncode(pub.slice(33, 65)),
    d: v.d, ext: false,
  }, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
}

async function vapidHeader(env: Env, endpoint: string): Promise<string> {
  const v = await getVapid(env);
  const aud = new URL(endpoint).origin;
  const head = b64uEncode(enc.encode(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const claims = b64uEncode(enc.encode(JSON.stringify({
    aud, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: env.VAPID_SUBJECT || 'https://shikati.zekri3047.workers.dev',
  })));
  const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, await signingKey(v), enc.encode(`${head}.${claims}`));
  return `vapid t=${head}.${claims}.${b64uEncode(sig)}, k=${v.pub}`;
}

async function hkdf(salt: Uint8Array, ikm: Uint8Array, info: Uint8Array, length: number): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info }, key, length * 8));
}

// تشفير المحتوى لجهاز واحد (RFC 8291 و RFC 8188)
export async function encryptPayload(p256dh: string, auth: string, plaintext: Uint8Array): Promise<Uint8Array> {
  const uaPublic = b64uDecode(p256dh);
  const authSecret = b64uDecode(auth);
  const local = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']) as CryptoKeyPair;
  const asPublic = new Uint8Array(await crypto.subtle.exportKey('raw', local.publicKey) as ArrayBuffer);
  const uaKey = await crypto.subtle.importKey('raw', uaPublic, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  // الاسم المعياري للحقل «public»، وأنواع كلاود فلير تسميه $public لأن الكلمة محجوزة
  const ecdh = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: uaKey } as unknown as SubtleCryptoDeriveKeyAlgorithm, local.privateKey, 256));

  const ikm = await hkdf(authSecret, ecdh, concat(enc.encode('WebPush: info\0'), uaPublic, asPublic), 32);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const cek = await hkdf(salt, ikm, enc.encode('Content-Encoding: aes128gcm\0'), 16);
  const nonce = await hkdf(salt, ikm, enc.encode('Content-Encoding: nonce\0'), 12);

  const aes = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['encrypt']);
  // سجل واحد أخير: المحتوى ثم البايت 2
  const cipher = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, aes, concat(plaintext, new Uint8Array([2]))));
  const rs = new Uint8Array([0, 0, 16, 0]); // 4096
  return concat(salt, rs, new Uint8Array([asPublic.length]), asPublic, cipher);
}

// يرسل إلى جهاز واحد. يعيد false إن انتهى الاشتراك (404 أو 410) فيُحذف.
async function sendOne(env: Env, sub: SubRow, payload: PushPayload): Promise<boolean> {
  const body = await encryptPayload(sub.p256dh, sub.auth, enc.encode(JSON.stringify(payload)));
  const res = await fetch(sub.endpoint, {
    method: 'POST',
    headers: {
      Authorization: await vapidHeader(env, sub.endpoint),
      'Content-Encoding': 'aes128gcm',
      'Content-Type': 'application/octet-stream',
      TTL: String(3 * 86400),
      Urgency: 'high',
    },
    body,
  });
  if (res.status === 404 || res.status === 410) return false;
  if (!res.ok) console.error('push failed', res.status, (await res.text()).slice(0, 200));
  else await env.DB.prepare("UPDATE push_subscriptions SET last_ok = datetime('now') WHERE endpoint = ?").bind(sub.endpoint).run();
  return true;
}

// يرسل الإشعار إلى كل أجهزة هؤلاء المستخدمين النشطين. يعيد عدد الأجهزة التي وصلها.
export async function notifyUsers(env: Env, userIds: number[], payload: PushPayload): Promise<number> {
  if (!userIds.length) return 0;
  const ids = [...new Set(userIds)];
  const { results } = await env.DB.prepare(
    `SELECT s.endpoint, s.user_id, s.p256dh, s.auth FROM push_subscriptions s JOIN users u ON u.id = s.user_id
     WHERE u.active = 1 AND s.user_id IN (${ids.map(() => '?').join(',')})`,
  ).bind(...ids).all<SubRow>();
  let sent = 0;
  for (const sub of results) {
    try {
      if (await sendOne(env, sub, payload)) sent++;
      else await env.DB.prepare('DELETE FROM push_subscriptions WHERE endpoint = ?').bind(sub.endpoint).run();
    } catch (e) {
      console.error('push error', e instanceof Error ? e.message : e);
    }
  }
  return sent;
}

export async function activeAdminIds(env: Env): Promise<number[]> {
  const { results } = await env.DB.prepare("SELECT id FROM users WHERE role = 'admin' AND active = 1").all<{ id: number }>();
  return results.map((r) => r.id);
}

const ENDPOINT_RE = /^https:\/\/[a-z0-9.-]+(:\d+)?\/\S{8,2000}$/i;
const KEY_RE = /^[A-Za-z0-9_-]{16,200}$/;

// /api/push/...
export async function handlePush(req: Request, env: Env, user: User, sub: string): Promise<Response> {
  if (req.method === 'GET' && sub === '/key') {
    return json({ key: (await getVapid(env)).pub });
  }
  if (req.method === 'POST' && sub === '/subscribe') {
    const b = await readJson<{ endpoint?: string; keys?: { p256dh?: string; auth?: string } }>(req);
    const endpoint = String(b.endpoint || '');
    const p256dh = String(b.keys?.p256dh || '');
    const auth = String(b.keys?.auth || '');
    // للتجربة المحلية فقط يُقبل عنوان http على الجهاز نفسه
    const local = /^http:\/\/127\.0\.0\.1:\d+\//.test(endpoint) && /^http:\/\/(localhost|127\.0\.0\.1)/.test(req.url);
    if ((!ENDPOINT_RE.test(endpoint) && !local) || !KEY_RE.test(p256dh) || !KEY_RE.test(auth)) {
      throw new HttpError(400, 'بيانات الاشتراك غير صالحة.');
    }
    await env.DB.prepare(
      'INSERT INTO push_subscriptions (endpoint, user_id, p256dh, auth) VALUES (?, ?, ?, ?) ' +
      'ON CONFLICT(endpoint) DO UPDATE SET user_id = excluded.user_id, p256dh = excluded.p256dh, auth = excluded.auth',
    ).bind(endpoint, user.id, p256dh, auth).run();
    return json({ ok: true });
  }
  if (req.method === 'POST' && sub === '/unsubscribe') {
    const b = await readJson<{ endpoint?: string }>(req);
    await env.DB.prepare('DELETE FROM push_subscriptions WHERE endpoint = ? AND user_id = ?').bind(String(b.endpoint || ''), user.id).run();
    return json({ ok: true });
  }
  if (req.method === 'POST' && sub === '/test') {
    const n = await notifyUsers(env, [user.id], {
      title: 'شيكاتي', body: 'الإشعارات تعمل على هذا الهاتف.', url: '/#cheques', tag: 'test',
    });
    return json({ ok: true, sent: n });
  }
  throw new HttpError(404, 'غير موجود.');
}
