import type { Env, User } from './env';

export async function audit(
  env: Env,
  user: Pick<User, 'id' | 'username'> | null,
  action: string,
  result: 'ok' | 'denied' | 'error',
  target?: string | null,
  details?: string | null,
): Promise<void> {
  await env.DB.prepare(
    'INSERT INTO audit_log (user_id, username, action, target, result, details) VALUES (?, ?, ?, ?, ?, ?)',
  ).bind(user?.id ?? null, user?.username ?? null, action, target ?? null, result, details ?? null).run();
}
