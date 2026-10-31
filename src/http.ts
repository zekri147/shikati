export class HttpError extends Error {
  constructor(public status: number, public publicMessage: string) {
    super(publicMessage);
  }
}

const SECURITY_HEADERS: Record<string, string> = {
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
};

export function json(data: unknown, status = 200, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...SECURITY_HEADERS, ...extra },
  });
}

export function errorResponse(e: unknown): Response {
  if (e instanceof HttpError) return json({ error: e.publicMessage }, e.status);
  // التفاصيل تُكتب في سجل الخادم فقط، ولا تُعرض للمستخدم
  console.error('unhandled', e instanceof Error ? e.stack : e);
  return json({ error: 'حدث خطأ غير متوقع. حاول مرة أخرى.' }, 500);
}

export async function readJson<T>(req: Request): Promise<T> {
  const ct = req.headers.get('Content-Type') || '';
  if (!ct.includes('application/json')) throw new HttpError(415, 'صيغة الطلب غير مقبولة.');
  try {
    return (await req.json()) as T;
  } catch {
    throw new HttpError(400, 'طلب غير صالح.');
  }
}

// حماية من الطلبات المزوّرة من مواقع أخرى: كل طلب كتابة يجب أن يأتي من نفس الموقع
export function assertSameOrigin(req: Request): void {
  if (req.method === 'GET' || req.method === 'HEAD') return;
  const origin = req.headers.get('Origin');
  if (!origin || origin !== new URL(req.url).origin) throw new HttpError(403, 'طلب مرفوض.');
}

export function nowSec(): number {
  return Math.floor(Date.now() / 1000);
}
