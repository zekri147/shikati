// الدخول بالبصمة: مفاتيح المرور (WebAuthn)، بموافقة ZEKRI يوم 7/11/2026.
// الهاتف يحفظ المفتاح الخاص ولا يُخرجه، ويطلب البصمة أو الوجه قبل كل توقيع (userVerification: required).
// الخادم يحفظ المفتاح العام، ويتحقق عند كل دخول من: نوع العملية، والتحدي (مرة واحدة)، والأصل،
// وبصمة اسم الموقع، وعلامتي حضور المستخدم والتحقق منه، والتوقيع، وعدّاد التوقيع.
// لا مكتبة خارجية: التحقق بأدوات التشفير في كلاود فلير (crypto.subtle).
import type { Env, Role, User } from './env';
import { HttpError, json, nowSec, readJson } from './http';
import { randomToken } from './crypto';
import { audit } from './audit';
import { isLocked, recordFailure, startSession } from './auth';

const TTL = 5 * 60;
const ES256 = -7;
const RS256 = -257;
const MAX_PER_IP = 20;

const enc = new TextEncoder();
const dec = new TextDecoder();

function fromB64url(s: string): Uint8Array {
  const t = String(s || '').replace(/-/g, '+').replace(/_/g, '/');
  const pad = t.length % 4 ? '='.repeat(4 - (t.length % 4)) : '';
  try {
    return Uint8Array.from(atob(t + pad), (c) => c.charCodeAt(0));
  } catch {
    throw new HttpError(400, 'طلب غير صالح.');
  }
}
function toB64url(u: Uint8Array): string {
  let s = '';
  for (const c of u) s += String.fromCharCode(c);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
const sha256 = async (b: Uint8Array) => new Uint8Array(await crypto.subtle.digest('SHA-256', b));
const equal = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((x, i) => x === b[i]);

// اسم الموقع (rpId) والأصل من عنوان الطلب نفسه: يعمل على النطاق المنشور وعلى localhost في التجربة
function site(req: Request) {
  const u = new URL(req.url);
  return { rpId: u.hostname, origin: u.origin };
}

async function newChallenge(env: Env, kind: 'reg' | 'auth', userId: number | null): Promise<string> {
  const challenge = randomToken(32);
  const now = nowSec();
  await env.DB.prepare('DELETE FROM passkey_challenges WHERE expires_at < ?').bind(now).run();
  await env.DB.prepare('INSERT INTO passkey_challenges (challenge, kind, user_id, expires_at) VALUES (?, ?, ?, ?)')
    .bind(challenge, kind, userId, now + TTL).run();
  return challenge;
}

// التحدي يُحذف عند أول استعمال، فلا يُعاد توقيع قديم
async function consumeChallenge(env: Env, challenge: string, kind: 'reg' | 'auth', userId: number | null): Promise<boolean> {
  const row = await env.DB.prepare('DELETE FROM passkey_challenges WHERE challenge = ? AND kind = ? RETURNING user_id, expires_at')
    .bind(challenge, kind).first<{ user_id: number | null; expires_at: number }>();
  return !!row && row.expires_at >= nowSec() && (userId === null || row.user_id === userId);
}

// clientDataJSON: نوع العملية، والتحدي، والأصل
async function checkClientData(env: Env, req: Request, raw: Uint8Array, type: string, kind: 'reg' | 'auth', userId: number | null) {
  let cd: { type?: string; challenge?: string; origin?: string; crossOrigin?: boolean };
  try { cd = JSON.parse(dec.decode(raw)); } catch { throw new HttpError(400, 'طلب غير صالح.'); }
  if (cd.type !== type || cd.origin !== site(req).origin || cd.crossOrigin) throw new HttpError(400, 'طلب البصمة لا يطابق هذا الموقع.');
  if (!cd.challenge || !(await consumeChallenge(env, cd.challenge, kind, userId))) {
    throw new HttpError(400, 'انتهت مهلة طلب البصمة. حاول مرة أخرى.');
  }
}

// authenticatorData: بصمة اسم الموقع (32)، والعلامات (1)، والعدّاد (4)، ثم بيانات المفتاح عند التفعيل
async function checkAuthData(req: Request, ad: Uint8Array) {
  if (ad.length < 37) throw new HttpError(400, 'طلب غير صالح.');
  if (!equal(ad.slice(0, 32), await sha256(enc.encode(site(req).rpId)))) throw new HttpError(400, 'طلب البصمة لا يطابق هذا الموقع.');
  const flags = ad[32];
  // UP: المستخدم حاضر، وUV: تحقق الهاتف منه بالبصمة أو الوجه أو رمز القفل
  if (!(flags & 0x01) || !(flags & 0x04)) throw new HttpError(400, 'لم يتحقق الهاتف من بصمتك.');
  const count = ((ad[33] << 24) | (ad[34] << 16) | (ad[35] << 8) | ad[36]) >>> 0;
  return { flags, count };
}

function importKey(spki: Uint8Array, alg: number) {
  if (alg === ES256) return crypto.subtle.importKey('spki', spki, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
  if (alg === RS256) return crypto.subtle.importKey('spki', spki, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
  throw new HttpError(400, 'نوع المفتاح غير مدعوم.');
}

// توقيع ES256 يصل بصيغة DER، وأداة التحقق تريد r وs متجاورين (64 بايت)
function derToRaw(der: Uint8Array): Uint8Array {
  let i = 2;
  if (der[0] !== 0x30) throw new HttpError(400, 'توقيع غير صالح.');
  if (der[1] & 0x80) i = 2 + (der[1] & 0x7f);
  const part = () => {
    if (der[i] !== 0x02) throw new HttpError(400, 'توقيع غير صالح.');
    const len = der[i + 1];
    let v = der.slice(i + 2, i + 2 + len);
    i += 2 + len;
    while (v.length > 32 && v[0] === 0) v = v.slice(1);
    if (v.length > 32) throw new HttpError(400, 'توقيع غير صالح.');
    const out = new Uint8Array(32);
    out.set(v, 32 - v.length);
    return out;
  };
  const r = part();
  const s = part();
  const raw = new Uint8Array(64);
  raw.set(r, 0); raw.set(s, 32);
  return raw;
}

// ——— التفعيل: المستخدم داخل بالرمز السري، ويضيف هذا الهاتف ———
export async function registerOptions(req: Request, env: Env, user: User): Promise<Response> {
  const { results } = await env.DB.prepare('SELECT id FROM passkeys WHERE user_id = ?').bind(user.id).all<{ id: string }>();
  return json({
    challenge: await newChallenge(env, 'reg', user.id),
    rp: { id: site(req).rpId, name: 'ميداني' },
    user: { id: toB64url(enc.encode('u' + user.id)), name: user.username, displayName: user.display_name },
    pubKeyCredParams: [{ type: 'public-key', alg: ES256 }, { type: 'public-key', alg: RS256 }],
    timeout: 60_000,
    attestation: 'none',
    authenticatorSelection: { residentKey: 'required', requireResidentKey: true, userVerification: 'required' },
    excludeCredentials: (results || []).map((r) => ({ type: 'public-key', id: r.id })),
  });
}

export async function registerVerify(req: Request, env: Env, user: User): Promise<Response> {
  const b = await readJson<{ id?: string; clientDataJSON?: string; authenticatorData?: string; publicKey?: string; alg?: number; label?: string }>(req);
  const rawId = fromB64url(String(b.id || ''));
  if (!rawId.length || rawId.length > 1024) throw new HttpError(400, 'طلب غير صالح.');
  await checkClientData(env, req, fromB64url(String(b.clientDataJSON || '')), 'webauthn.create', 'reg', user.id);
  const ad = fromB64url(String(b.authenticatorData || ''));
  const { flags, count } = await checkAuthData(req, ad);
  // بيانات المفتاح في authenticatorData: يجب أن يكون المعرّف فيها هو المعرّف المرسل
  if (!(flags & 0x40) || ad.length < 55) throw new HttpError(400, 'طلب غير صالح.');
  const idLen = (ad[53] << 8) | ad[54];
  if (!equal(ad.slice(55, 55 + idLen), rawId)) throw new HttpError(400, 'طلب غير صالح.');
  const alg = Number(b.alg);
  const spki = fromB64url(String(b.publicKey || ''));
  await importKey(spki, alg); // يرفض المفتاح التالف قبل حفظه

  const id = toB64url(rawId);
  const label = String(b.label || 'هاتف').replace(/\s+/g, ' ').trim().slice(0, 60) || 'هاتف';
  const exists = await env.DB.prepare('SELECT 1 FROM passkeys WHERE id = ?').bind(id).first();
  if (exists) throw new HttpError(409, 'البصمة مفعّلة على هذا الهاتف من قبل.');
  let s = '';
  for (const c of spki) s += String.fromCharCode(c);
  await env.DB.prepare('INSERT INTO passkeys (id, user_id, public_key, alg, sign_count, label, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .bind(id, user.id, btoa(s), alg, count, label, nowSec()).run();
  await audit(env, user, 'passkey.add', 'ok', user.username, label);
  return json({ ok: true });
}

// ——— الدخول: دون اسم ولا رمز. الهاتف يعرض مفاتيح هذا الموقع، والبصمة تفتح أحدها ———
export async function loginOptions(req: Request, env: Env): Promise<Response> {
  const ip = req.headers.get('CF-Connecting-IP') || 'unknown';
  if (await isLocked(env, `ip:${ip}`)) throw new HttpError(429, 'محاولات كثيرة. انتظر 15 دقيقة ثم حاول مجدداً.');
  return json({ challenge: await newChallenge(env, 'auth', null), rpId: site(req).rpId, timeout: 60_000, userVerification: 'required' });
}

export async function loginVerify(req: Request, env: Env): Promise<Response> {
  const ip = req.headers.get('CF-Connecting-IP') || 'unknown';
  const ipKey = `ip:${ip}`;
  if (await isLocked(env, ipKey)) throw new HttpError(429, 'محاولات كثيرة. انتظر 15 دقيقة ثم حاول مجدداً.');
  const b = await readJson<{ id?: string; clientDataJSON?: string; authenticatorData?: string; signature?: string }>(req);
  const id = toB64url(fromB64url(String(b.id || '')));

  const row = await env.DB.prepare(
    'SELECT p.public_key, p.alg, p.sign_count, u.id, u.username, u.display_name, u.role, u.active ' +
    'FROM passkeys p JOIN users u ON u.id = p.user_id WHERE p.id = ?',
  ).bind(id).first<{ public_key: string; alg: number; sign_count: number; id: number; username: string; display_name: string; role: Role; active: number }>();

  const fail = async (why: string, msg = 'لم يُقبل الدخول بالبصمة. ادخل بالاسم والرمز السري.') => {
    await recordFailure(env, ipKey, MAX_PER_IP);
    await audit(env, row ? { id: row.id, username: row.username } : null, 'login', 'denied', row?.username || null, 'passkey:' + why);
    return new HttpError(401, msg);
  };
  if (!row) throw await fail('unknown', 'هذه البصمة غير مسجّلة. ادخل بالاسم والرمز السري، ثم فعّل البصمة من جديد.');

  const clientData = fromB64url(String(b.clientDataJSON || ''));
  await checkClientData(env, req, clientData, 'webauthn.get', 'auth', null);
  const ad = fromB64url(String(b.authenticatorData || ''));
  const { count } = await checkAuthData(req, ad);

  const key = await importKey(Uint8Array.from(atob(row.public_key), (c) => c.charCodeAt(0)), row.alg);
  const data = new Uint8Array(ad.length + 32);
  data.set(ad, 0);
  data.set(await sha256(clientData), ad.length);
  let sig = fromB64url(String(b.signature || ''));
  if (row.alg === ES256) sig = derToRaw(sig);
  const algo = row.alg === ES256 ? { name: 'ECDSA', hash: 'SHA-256' } : { name: 'RSASSA-PKCS1-v1_5' };
  if (!(await crypto.subtle.verify(algo, key, sig, data))) throw await fail('signature');
  // العدّاد يزيد مع كل توقيع في الأجهزة التي تعدّ: إن لم يزد فالمفتاح منسوخ
  if ((count > 0 || row.sign_count > 0) && count <= row.sign_count) throw await fail('counter');
  if (row.active !== 1) throw await fail('inactive', 'اسم المستخدم موقوف. راجع المدير.');

  await env.DB.prepare('UPDATE passkeys SET sign_count = ?, last_used = ? WHERE id = ?').bind(count, nowSec(), id).run();
  return startSession(env, row, 'passkey');
}
