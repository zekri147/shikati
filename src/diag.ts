import type { Env } from './env';
import { json } from './http';

// فحص الاتصال للمدير فقط: يعرض العناوين المستعملة ونتيجة الاتصال بها،
// دون أي سر ودون طلب رمز من زوهو.
async function probe(url: string) {
  const started = Date.now();
  try {
    const res = await fetch(url, { method: 'GET', redirect: 'manual' });
    const text = await res.text();
    return {
      url,
      status: res.status,
      cf_error: text.match(/error code:\s*(\d{3,5})/i)?.[1] ?? null,
      server: res.headers.get('server'),
      ms: Date.now() - started,
    };
  } catch (e) {
    return { url, status: null, error: e instanceof Error ? e.message : String(e), ms: Date.now() - started };
  }
}

export async function handleDiag(env: Env): Promise<Response> {
  const accounts = String(env.ZOHO_ACCOUNTS_URL);
  const api = String(env.ZOHO_API_BASE);
  return json({
    config: {
      accounts_url: JSON.stringify(accounts),
      api_base: JSON.stringify(api),
      org_id: env.ZOHO_ORG_ID,
      has_client_id: !!env.ZOHO_CLIENT_ID,
      has_client_secret: !!env.ZOHO_CLIENT_SECRET,
      has_refresh_token: !!env.ZOHO_REFRESH_TOKEN,
      refresh_token_prefix: env.ZOHO_REFRESH_TOKEN ? env.ZOHO_REFRESH_TOKEN.slice(0, 5) : null,
    },
    probes: await Promise.all([
      probe(accounts.replace(/\/+$/, '') + '/oauth/v2/token'),
      probe('https://accounts.zoho.com./oauth/v2/token'),
      probe('https://accounts.zoho.eu/oauth/v2/token'),
      probe('https://www.zoho.com/'),
      probe(api.replace(/\/+$/, '') + '/organizations'),
    ]),
  });
}
