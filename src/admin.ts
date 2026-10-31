import type { Env, Role, User } from './env';
import { HttpError, json, readJson } from './http';
import { hashPassword } from './crypto';
import { audit } from './audit';
import { handleDiag } from './diag';

const USERNAME_RE = /^[a-z0-9._-]{3,32}$/;
const ROLES: Role[] = ['admin', 'depositor'];

function validatePassword(pw: unknown): string {
  const s = String(pw ?? '');
  if (s.length < 8 || s.length > 128) throw new HttpError(400, 'الرمز السري يجب أن يكون بين 8 و128 حرفاً.');
  return s;
}

export async function handleAdmin(req: Request, env: Env, admin: User, path: string): Promise<Response> {
  // GET /api/admin/users
  if (req.method === 'GET' && path === '/users') {
    const { results } = await env.DB.prepare(
      'SELECT id, username, display_name, role, active, created_at FROM users ORDER BY id',
    ).all();
    return json({ users: results });
  }

  // POST /api/admin/users
  if (req.method === 'POST' && path === '/users') {
    const b = await readJson<{ username?: string; display_name?: string; role?: string; password?: string }>(req);
    const username = String(b.username || '').trim().toLowerCase();
    const display = String(b.display_name || '').trim();
    const role = b.role as Role;
    if (!USERNAME_RE.test(username)) {
      throw new HttpError(400, 'اسم المستخدم: من 3 إلى 32 حرفاً لاتينياً صغيراً أو رقماً.');
    }
    if (!display || display.length > 60) throw new HttpError(400, 'أدخل الاسم الظاهر.');
    if (!ROLES.includes(role)) throw new HttpError(400, 'الدور غير صالح.');
    const pw = await hashPassword(validatePassword(b.password));
    try {
      await env.DB.prepare(
        'INSERT INTO users (username, display_name, role, pw_hash, pw_salt, pw_iter) VALUES (?, ?, ?, ?, ?, ?)',
      ).bind(username, display, role, pw.hash, pw.salt, pw.iter).run();
    } catch {
      throw new HttpError(409, 'اسم المستخدم موجود مسبقاً.');
    }
    await audit(env, admin, 'user.create', 'ok', username, role);
    return json({ ok: true }, 201);
  }

  // POST /api/admin/users/:id/(disable|enable|password)
  const m = path.match(/^\/users\/(\d+)\/(disable|enable|password)$/);
  if (req.method === 'POST' && m) {
    const id = Number(m[1]);
    const action = m[2];
    const target = await env.DB.prepare('SELECT id, username FROM users WHERE id = ?')
      .bind(id).first<{ id: number; username: string }>();
    if (!target) throw new HttpError(404, 'المستخدم غير موجود.');

    if (action === 'disable') {
      if (target.id === admin.id) throw new HttpError(400, 'لا يمكنك إيقاف حسابك أنت.');
      // الإيقاف فوري: نحذف كل جلساته المفتوحة
      await env.DB.batch([
        env.DB.prepare('UPDATE users SET active = 0 WHERE id = ?').bind(id),
        env.DB.prepare('DELETE FROM sessions WHERE user_id = ?').bind(id),
      ]);
    } else if (action === 'enable') {
      await env.DB.prepare('UPDATE users SET active = 1 WHERE id = ?').bind(id).run();
    } else {
      const b = await readJson<{ password?: string }>(req);
      const pw = await hashPassword(validatePassword(b.password));
      await env.DB.batch([
        env.DB.prepare('UPDATE users SET pw_hash = ?, pw_salt = ?, pw_iter = ? WHERE id = ?')
          .bind(pw.hash, pw.salt, pw.iter, id),
        env.DB.prepare('DELETE FROM sessions WHERE user_id = ?').bind(id),
      ]);
    }
    await audit(env, admin, `user.${action}`, 'ok', target.username);
    return json({ ok: true });
  }

  // GET /api/admin/diag
  if (req.method === 'GET' && path === '/diag') return handleDiag(env);

  // GET /api/admin/audit
  if (req.method === 'GET' && path === '/audit') {
    const { results } = await env.DB.prepare(
      'SELECT at, username, action, target, result, details FROM audit_log ORDER BY id DESC LIMIT 200',
    ).all();
    return json({ entries: results });
  }

  throw new HttpError(404, 'غير موجود.');
}
