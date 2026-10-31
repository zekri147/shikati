import type { Env } from './env';
import { HttpError, nowSec } from './http';

// المرحلة الأولى: قراءة فقط. هذا الملف لا يحتوي أي طلب كتابة إلى زوهو بوكس.

let memToken: { token: string; exp: number } | null = null;

async function cacheGet(env: Env, key: string): Promise<string | null> {
  const row = await env.DB.prepare('SELECT value FROM cache WHERE key = ? AND expires_at > ?')
    .bind(key, nowSec()).first<{ value: string }>();
  return row?.value ?? null;
}

export async function cachePut(env: Env, key: string, value: string, ttlSec: number): Promise<void> {
  await env.DB.prepare(
    'INSERT INTO cache (key, value, expires_at) VALUES (?, ?, ?) ' +
    'ON CONFLICT(key) DO UPDATE SET value = excluded.value, expires_at = excluded.expires_at',
  ).bind(key, value, nowSec() + ttlSec).run();
}

export { cacheGet };

async function accessToken(env: Env, force = false): Promise<string> {
  if (!force && memToken && memToken.exp > nowSec()) return memToken.token;
  if (!force) {
    const cached = await cacheGet(env, 'zoho_access_token');
    if (cached) {
      const { token, exp } = JSON.parse(cached) as { token: string; exp: number };
      memToken = { token, exp };
      return token;
    }
  }
  if (!env.ZOHO_REFRESH_TOKEN || !env.ZOHO_CLIENT_ID || !env.ZOHO_CLIENT_SECRET) {
    console.error('zoho: missing secrets');
    throw new HttpError(503, 'الربط مع زوهو غير مُعدّ بعد.');
  }
  const res = await fetch(`${env.ZOHO_ACCOUNTS_URL}/oauth/v2/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      refresh_token: env.ZOHO_REFRESH_TOKEN,
      client_id: env.ZOHO_CLIENT_ID,
      client_secret: env.ZOHO_CLIENT_SECRET,
      grant_type: 'refresh_token',
    }),
  });
  const data = (await res.json().catch(() => ({}))) as { access_token?: string; expires_in?: number; error?: string };
  if (!res.ok || !data.access_token) {
    // لا نسجّل الرد كاملاً لأنه قد يحتوي بيانات حساسة
    console.error('zoho token refresh failed', res.status, data.error);
    throw new HttpError(502, 'تعذّر الاتصال بزوهو. حاول بعد قليل.');
  }
  // نُبقي هامش 5 دقائق قبل انتهاء الرمز
  const ttl = Math.max(60, (data.expires_in ?? 3600) - 300);
  memToken = { token: data.access_token, exp: nowSec() + ttl };
  await cachePut(env, 'zoho_access_token', JSON.stringify(memToken), ttl);
  return data.access_token;
}

export async function zohoGet<T>(env: Env, path: string, params: Record<string, string | number> = {}): Promise<T> {
  const url = new URL(env.ZOHO_API_BASE + path);
  url.searchParams.set('organization_id', env.ZOHO_ORG_ID);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v));

  for (let attempt = 0; attempt < 2; attempt++) {
    const token = await accessToken(env, attempt > 0);
    const res = await fetch(url.toString(), {
      method: 'GET',
      headers: { Authorization: `Zoho-oauthtoken ${token}` },
    });
    if (res.status === 401 && attempt === 0) {
      memToken = null;
      continue;
    }
    const data = (await res.json().catch(() => null)) as ({ code?: number; message?: string } & T) | null;
    if (!res.ok || !data || data.code !== 0) {
      console.error('zoho GET failed', path, res.status, data?.code, data?.message);
      if (res.status === 429) throw new HttpError(503, 'زوهو مشغول الآن. حاول بعد دقيقة.');
      throw new HttpError(502, 'تعذّر جلب البيانات من زوهو.');
    }
    return data;
  }
  throw new HttpError(502, 'تعذّر جلب البيانات من زوهو.');
}
