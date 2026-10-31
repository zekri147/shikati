import type { Env } from './env';
import { HttpError, json, nowSec, readJson } from './http';
import { hashPassword, timingSafeEqual } from './crypto';
import { audit } from './audit';

// إعداد أولي: ينشئ أول حساب مدير من المتصفح، مرة واحدة فقط.
// يعمل بشرطين: لا يوجد أي مستخدم بعد، والسر SETUP_TOKEN موجود في إعدادات الخادم.
// بعد إنشاء أول حساب يتوقف نهائياً، ويُنصح بحذف السر SETUP_TOKEN.

const USERNAME_RE = /^[a-z0-9._-]{3,32}$/;
const MAX_FAILS = 5;
const LOCK = 30 * 60;

export async function setupAvailable(env: Env): Promise<boolean> {
  if (!env.SETUP_TOKEN || env.SETUP_TOKEN.length < 16) return false;
  const row = await env.DB.prepare('SELECT COUNT(*) AS n FROM users').first<{ n: number }>();
  return (row?.n ?? 0) === 0;
}

export async function handleSetup(req: Request, env: Env): Promise<Response> {
  if (!(await setupAvailable(env))) throw new HttpError(404, 'غير موجود.');

  const ip = req.headers.get('CF-Connecting-IP') || 'unknown';
  const key = `setup:${ip}`;
  const att = await env.DB.prepare('SELECT failures, locked_until FROM login_attempts WHERE key = ?')
    .bind(key).first<{ failures: number; locked_until: number }>();
  if (att && att.locked_until > nowSec()) throw new HttpError(429, 'محاولات كثيرة. انتظر 30 دقيقة.');

  const b = await readJson<{ token?: string; username?: string; display_name?: string; password?: string }>(req);
  if (!timingSafeEqual(String(b.token || ''), env.SETUP_TOKEN ?? '')) {
    const failures = (att?.failures ?? 0) + 1;
    await env.DB.prepare(
      'INSERT INTO login_attempts (key, failures, first_at, locked_until) VALUES (?, ?, ?, ?) ' +
      'ON CONFLICT(key) DO UPDATE SET failures = excluded.failures, locked_until = excluded.locked_until',
    ).bind(key, failures, nowSec(), failures >= MAX_FAILS ? nowSec() + LOCK : 0).run();
    await audit(env, null, 'setup', 'denied', null, 'bad_token');
    throw new HttpError(403, 'رمز الإعداد غير صحيح.');
  }

  const username = String(b.username || '').trim().toLowerCase();
  const display = String(b.display_name || '').trim();
  const password = String(b.password || '');
  if (!USERNAME_RE.test(username)) throw new HttpError(400, 'اسم الدخول: من 3 إلى 32 حرفاً لاتينياً صغيراً أو رقماً.');
  if (!display || display.length > 60) throw new HttpError(400, 'أدخل الاسم الظاهر.');
  if (password.length < 10 || password.length > 128) throw new HttpError(400, 'رمز المدير السري: 10 أحرف على الأقل.');

  const pw = await hashPassword(password);
  // الإدخال مشروط بخلوّ الجدول، فلا يمكن أن ينجح طلبان معاً
  const res = await env.DB.prepare(
    "INSERT INTO users (username, display_name, role, pw_hash, pw_salt, pw_iter) " +
    "SELECT ?, ?, 'admin', ?, ?, ? WHERE NOT EXISTS (SELECT 1 FROM users)",
  ).bind(username, display, pw.hash, pw.salt, pw.iter).run();
  if (!res.meta.changes) throw new HttpError(404, 'غير موجود.');

  await env.DB.prepare('DELETE FROM login_attempts WHERE key = ?').bind(key).run();
  await audit(env, { id: Number(res.meta.last_row_id), username }, 'setup', 'ok', username, 'first admin');
  return json({ ok: true }, 201);
}
