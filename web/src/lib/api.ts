import { clearCaches } from './cache';

// طلبات الخادم. لا إعادة تلقائية لأي طلب كتابة: الخطأ يصل كما هو إلى الشاشة.
export class ApiError extends Error {
  constructor(message: string, public status: number) {
    super(message);
  }
}

type Opts = { method?: string; body?: unknown; noRedirect?: boolean };

export async function api<T = any>(path: string, opts: Opts = {}): Promise<T> {
  const init: RequestInit = { method: opts.method || 'GET', credentials: 'same-origin', headers: {} };
  if (opts.body !== undefined) {
    (init.headers as Record<string, string>)['Content-Type'] = 'application/json';
    init.body = JSON.stringify(opts.body);
  }
  let res: Response;
  try {
    res = await fetch(path, init);
  } catch {
    throw new ApiError('لا يوجد اتصال بالإنترنت. تحقق من الشبكة ثم حاول مجدداً.', 0);
  }
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && !opts.noRedirect) {
    location.href = '/login';
    throw new ApiError(data.error || 'انتهت الجلسة.', 401);
  }
  if (!res.ok) throw new ApiError(data.error || 'حدث خطأ غير متوقع.', res.status);
  return data as T;
}

// انقطاع الرد بعد طلب كتابة: لا نعرف إن نُفّذ، فلا يُعرض زر إعادة
export const isCutOff = (e: unknown) => e instanceof ApiError && (e.status === 504 || e.status === 0);
export const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

export type Me = {
  user: { username: string; display_name: string; role: 'admin' | 'depositor' | 'rep'; rep_code: string | null };
  modules: { id: string; title: string }[];
};

export async function logout() {
  clearCaches();
  try { await api('/api/logout', { method: 'POST', body: {}, noRedirect: true }); } catch { /* نكمل */ }
  location.href = '/login';
}
