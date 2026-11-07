import type { Env, Role, User } from './env';
import { HttpError, json, nowSec, readJson } from './http';
import { hashPassword, randomToken, sha256Hex, timingSafeEqual } from './crypto';
import { audit } from './audit';

const COOKIE = '__Host-shikati';

// حد المحاولات: بعد 5 أخطاء لنفس الاسم خلال 15 دقيقة يُقفل 15 دقيقة.
// وبعد 20 خطأ من نفس العنوان يُقفل العنوان كذلك.
const WINDOW = 15 * 60;
const LOCK = 15 * 60;
const MAX_PER_USER = 5;
const MAX_PER_IP = 20;

// بصمة ثابتة تُحسب عند غياب المستخدم حتى يتساوى زمن الرد
const DUMMY_SALT = 'AAAAAAAAAAAAAAAAAAAAAA==';

async function isLocked(env: Env, key: string): Promise<boolean> {
  const row = await env.DB.prepare('SELECT locked_until FROM login_attempts WHERE key = ?')
    .bind(key).first<{ locked_until: number }>();
  return !!row && row.locked_until > nowSec();
}

async function recordFailure(env: Env, key: string, max: number): Promise<void> {
  const now = nowSec();
  const row = await env.DB.prepare('SELECT failures, first_at FROM login_attempts WHERE key = ?')
    .bind(key).first<{ failures: number; first_at: number }>();
  if (!row || now - row.first_at > WINDOW) {
    await env.DB.prepare(
      'INSERT INTO login_attempts (key, failures, first_at, locked_until) VALUES (?, 1, ?, 0) ' +
      'ON CONFLICT(key) DO UPDATE SET failures = 1, first_at = excluded.first_at, locked_until = 0',
    ).bind(key, now).run();
    return;
  }
  const failures = row.failures + 1;
  const lockedUntil = failures >= max ? now + LOCK : 0;
  await env.DB.prepare('UPDATE login_attempts SET failures = ?, locked_until = ? WHERE key = ?')
    .bind(failures, lockedUntil, key).run();
}

function sessionCookie(token: string, maxAge: number): string {
  return `${COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${maxAge}`;
}

function readCookie(req: Request): string | null {
  const header = req.headers.get('Cookie') || '';
  for (const part of header.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === COOKIE) return v.join('=') || null;
  }
  return null;
}

export async function login(req: Request, env: Env): Promise<Response> {
  const body = await readJson<{ username?: string; password?: string }>(req);
  const username = String(body.username || '').trim().toLowerCase();
  const password = String(body.password || '');
  if (!username || !password || username.length > 64 || password.length > 256) {
    throw new HttpError(400, 'أدخل اسم المستخدم والرمز السري.');
  }

  const ip = req.headers.get('CF-Connecting-IP') || 'unknown';
  const userKey = `u:${username}`;
  const ipKey = `ip:${ip}`;
  if ((await isLocked(env, userKey)) || (await isLocked(env, ipKey))) {
    await audit(env, null, 'login', 'denied', username, 'locked');
    throw new HttpError(429, 'محاولات كثيرة. انتظر 15 دقيقة ثم حاول مجدداً.');
  }

  const row = await env.DB.prepare(
    'SELECT id, username, display_name, role, pw_hash, pw_salt, pw_iter, active FROM users WHERE username = ?',
  ).bind(username).first<User & { pw_hash: string; pw_salt: string; pw_iter: number; active: number }>();

  const computed = await hashPassword(password, row?.pw_salt ?? DUMMY_SALT, row?.pw_iter);
  const ok = !!row && row.active === 1 && timingSafeEqual(computed.hash, row.pw_hash);

  if (!ok) {
    await recordFailure(env, userKey, MAX_PER_USER);
    await recordFailure(env, ipKey, MAX_PER_IP);
    await audit(env, row ? { id: row.id, username: row.username } : null, 'login', 'denied', username,
      row && row.active !== 1 ? 'inactive' : 'bad_credentials');
    // رسالة واحدة لكل الحالات حتى لا يُعرف إن كان الاسم موجوداً
    throw new HttpError(401, 'اسم المستخدم أو الرمز السري غير صحيح.');
  }

  await env.DB.prepare('DELETE FROM login_attempts WHERE key = ?').bind(userKey).run();

  const hours = Math.max(1, Number(env.SESSION_HOURS) || 12);
  const token = randomToken();
  const now = nowSec();
  await env.DB.prepare('INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)')
    .bind(await sha256Hex(token), row.id, now, now + hours * 3600).run();
  // تنظيف الجلسات المنتهية بين الحين والآخر
  await env.DB.prepare('DELETE FROM sessions WHERE expires_at < ?').bind(now).run();

  await audit(env, row, 'login', 'ok');
  return json(
    { user: { username: row.username, display_name: row.display_name, role: row.role } },
    200,
    { 'Set-Cookie': sessionCookie(token, hours * 3600) },
  );
}

export async function logout(req: Request, env: Env): Promise<Response> {
  const token = readCookie(req);
  if (token) await env.DB.prepare('DELETE FROM sessions WHERE token_hash = ?').bind(await sha256Hex(token)).run();
  return json({ ok: true }, 200, { 'Set-Cookie': sessionCookie('', 0) });
}

export async function currentUser(req: Request, env: Env): Promise<User | null> {
  const token = readCookie(req);
  if (!token || token.length > 100) return null;
  return await env.DB.prepare(
    'SELECT u.id, u.username, u.display_name, u.role, u.rep_code FROM sessions s JOIN users u ON u.id = s.user_id ' +
    'WHERE s.token_hash = ? AND s.expires_at > ? AND u.active = 1',
  ).bind(await sha256Hex(token), nowSec()).first<User>();
}

export async function requireUser(req: Request, env: Env, roles?: Role[]): Promise<User> {
  const user = await currentUser(req, env);
  if (!user) throw new HttpError(401, 'انتهت الجلسة. سجّل الدخول من جديد.');
  if (roles && !roles.includes(user.role)) throw new HttpError(403, 'ليست لديك صلاحية لهذا الإجراء.');
  return user;
}
