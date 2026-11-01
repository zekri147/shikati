import type { Env } from './env';
import { HttpError, nowSec } from './http';

// طلبات زوهو بوكس. طلبات الكتابة لا تُستعمل إلا من وحدة الإيداع (modules/deposit.ts).

const TOKEN_HINTS: Record<string, string> = {
  invalid_client: 'معرّف العميل أو سرّه غير صحيح، أو التطبيق في مركز بيانات آخر.',
  invalid_client_secret: 'سر العميل غير صحيح.',
  invalid_code: 'رمز التجديد غير صحيح أو أُلغي. أنشئ رمز تجديد جديداً.',
  access_denied: 'زوهو رفض الطلب. تحقق من حساب صاحب المفتاح.',
  'relay: forbidden': 'المفتاح المشترك مع الوسيط غير مطابق.',
  'relay: invalid_client': 'معرّف العميل أو سرّه في الوسيط غير صحيح.',
  'relay: invalid_code': 'رمز التجديد في الوسيط غير صحيح.',
  relay_unreachable: 'تعذّر الوصول إلى الوسيط في غوغل.',
};

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

type TokenReply = { access_token: string; expires_in?: number };

function tokenError(code: string): HttpError {
  const hint = TOKEN_HINTS[code] || 'حاول بعد قليل.';
  return new HttpError(502, `تعذّر الاتصال بزوهو (${code}). ${hint}`);
}

// تجديد مباشر من خادم رموز زوهو
async function direct(env: Env): Promise<TokenReply> {
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
  const text = await res.text();
  let data: { access_token?: string; expires_in?: number; error?: string } = {};
  try { data = JSON.parse(text); } catch { /* ليس رداً من زوهو */ }
  if (!res.ok || !data.access_token) {
    // رد غير JSON يأتي عادة من كلاود فلير نفسه، مثل: error code: 1016
    const cfCode = text.match(/error code:\s*(\d{3,5})/i)?.[1];
    console.error('zoho token refresh failed', res.status, data.error, cfCode ?? '');
    const code = /^[a-z_]{3,40}$/.test(String(data.error || ''))
      ? String(data.error)
      : `HTTP ${res.status}${cfCode ? ` / ${cfCode}` : ''}`;
    throw tokenError(code);
  }
  return { access_token: data.access_token, expires_in: data.expires_in };
}

// تجديد عبر الوسيط في غوغل، لأن كلاود فلير لا يصل إلى خادم الرموز الأمريكي
async function viaRelay(env: Env, force: boolean): Promise<TokenReply> {
  if (!env.ZOHO_RELAY_KEY) throw new HttpError(503, 'الربط مع زوهو غير مُعدّ بعد.');
  let res: Response;
  try {
    res = await fetch(env.ZOHO_RELAY_URL!.trim(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key: env.ZOHO_RELAY_KEY.trim(), force }),
      redirect: 'follow',
    });
  } catch (e) {
    console.error('relay fetch failed', e instanceof Error ? e.message : e);
    throw tokenError('relay_unreachable');
  }
  const text = await res.text();
  let data: { access_token?: string; expires_in?: number; error?: string } = {};
  try { data = JSON.parse(text); } catch { /* صفحة غير متوقعة من غوغل */ }
  if (!data.access_token) {
    const code = /^[a-z_]{3,40}$/.test(String(data.error || '')) ? `relay: ${data.error}` : `relay: HTTP ${res.status}`;
    console.error('relay token failed', code);
    throw tokenError(code);
  }
  return { access_token: data.access_token, expires_in: data.expires_in };
}

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
  const data = env.ZOHO_RELAY_URL ? await viaRelay(env, force) : await direct(env);
  // نُبقي هامش 5 دقائق قبل انتهاء الرمز
  const ttl = Math.max(60, (data.expires_in ?? 3600) - 300);
  memToken = { token: data.access_token, exp: nowSec() + ttl };
  await cachePut(env, 'zoho_access_token', JSON.stringify(memToken), ttl);
  return data.access_token;
}

export class ZohoTimeout extends Error {}

type ZohoResult = { code?: number; message?: string };

// طلب إلى زوهو بوكس. خطأ 401 يعني أن الطلب لم يُنفَّذ، فنجدّد الرمز ونعيده مرة واحدة.
// أي خطأ آخر لا يُعاد تلقائياً، خصوصاً في طلبات الكتابة.
export async function zohoRequest<T>(
  env: Env,
  method: 'GET' | 'POST' | 'PUT' | 'DELETE',
  path: string,
  opts: { params?: Record<string, string | number>; body?: unknown; timeoutMs?: number } = {},
): Promise<{ status: number; data: (ZohoResult & T) | null }> {
  const url = new URL(env.ZOHO_API_BASE + path);
  url.searchParams.set('organization_id', env.ZOHO_ORG_ID);
  for (const [k, v] of Object.entries(opts.params || {})) url.searchParams.set(k, String(v));

  for (let attempt = 0; attempt < 2; attempt++) {
    const token = await accessToken(env, attempt > 0);
    const headers: Record<string, string> = { Authorization: `Zoho-oauthtoken ${token}` };
    if (opts.body !== undefined) headers['Content-Type'] = 'application/json';
    let res: Response;
    try {
      res = await fetch(url.toString(), {
        method,
        headers,
        body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
        signal: AbortSignal.timeout(opts.timeoutMs ?? 25_000),
      });
    } catch (e) {
      // انقطاع أو مهلة: لا نعرف إن كان زوهو نفّذ الطلب
      console.error('zoho request failed', method, path, e instanceof Error ? e.name : e);
      throw new ZohoTimeout(String(e));
    }
    if (res.status === 401 && attempt === 0) {
      memToken = null;
      continue;
    }
    const data = (await res.json().catch(() => null)) as (ZohoResult & T) | null;
    // الرمز 57 يعني «غير مصرّح»: الأرجح أن رمز الوصول المحفوظ أقدم من الصلاحيات الجديدة.
    // زوهو لم ينفّذ الطلب، فنطلب رمزاً جديداً ونعيده مرة واحدة.
    if (data?.code === 57 && attempt === 0) {
      memToken = null;
      await env.DB.prepare('DELETE FROM cache WHERE key = ?').bind('zoho_access_token').run();
      continue;
    }
    return { status: res.status, data };
  }
  return { status: 401, data: null };
}

export async function zohoGet<T>(env: Env, path: string, params: Record<string, string | number> = {}): Promise<T> {
  let r;
  try {
    r = await zohoRequest<T>(env, 'GET', path, { params });
  } catch (e) {
    if (e instanceof ZohoTimeout) throw new HttpError(504, 'زوهو لم يرد في الوقت المحدد. حاول مرة أخرى.');
    throw e;
  }
  if (r.status >= 400 || !r.data || r.data.code !== 0) {
    console.error('zoho GET failed', path, r.status, r.data?.code, r.data?.message);
    if (r.status === 429) throw new HttpError(503, 'زوهو مشغول الآن. حاول بعد دقيقة.');
    throw new HttpError(502, 'تعذّر جلب البيانات من زوهو.');
  }
  return r.data;
}
