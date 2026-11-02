import type { Env } from '../env';
import { isReadableType, readOrientation } from './ocr';
import { HttpError, json } from '../http';
import { cacheGet, cachePut, zohoFetchRaw, zohoRequest, ZohoTimeout } from '../zoho';

// صورة الشيك المرفقة بالدفعة في زوهو. الخادم يجلبها ويمرّرها للمتصفح،
// فلا يرى المتصفح أي رمز وصول. معرّف المرفق يُقرأ من الدفعة نفسها، لا من المستخدم.

const IMAGE_TYPES: Record<string, string> = {
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', gif: 'image/gif', heic: 'image/heic',
};

interface Doc { document_id?: string; file_type?: string; file_name?: string; attachment_order?: number }

// طرق تحميل المرفق المعروفة في زوهو بوكس. نجرّبها بالترتيب ونحفظ أول طريق ينجح.
const ROUTES: { id: string; path: (pid: string, doc: string) => string; params?: Record<string, string> }[] = [
  { id: 'payment_attachment', path: (pid) => `/customerpayments/${pid}/attachment` },
  { id: 'payment_document', path: (pid, doc) => `/customerpayments/${pid}/documents/${doc}` },
  { id: 'document', path: (_pid, doc) => `/documents/${doc}`, params: { inline: 'true' } },
];
const ROUTE_CACHE = 'image_route';

async function firstImageDoc(env: Env, pid: string): Promise<{ doc: Doc; type: string } | null> {
  const r = await zohoRequest<{ payment?: { documents?: Doc[] } }>(env, 'GET', `/customerpayments/${pid}`, { timeoutMs: 15_000 });
  if (!r.data || r.data.code !== 0 || !r.data.payment) throw new HttpError(502, 'تعذّرت قراءة الدفعة من زوهو.');
  const docs = (r.data.payment.documents || []).filter((d) => d.document_id && IMAGE_TYPES[String(d.file_type || '').toLowerCase()]);
  // نفضّل الصيغ التي تعرضها كل المتصفحات على صيغة آيفون (HEIC)، ثم أحدث صورة (بعد تعديل الشيك)
  docs.sort((a, b) => Number(String(a.file_type).toLowerCase() === 'heic') - Number(String(b.file_type).toLowerCase() === 'heic')
    || (Number(b.attachment_order) || 0) - (Number(a.attachment_order) || 0));
  const doc = docs[0];
  return doc ? { doc, type: IMAGE_TYPES[String(doc.file_type).toLowerCase()] } : null;
}

function isImage(res: Response): boolean {
  const ct = (res.headers.get('Content-Type') || '').toLowerCase();
  return res.ok && (ct.startsWith('image/') || ct.startsWith('application/octet-stream'));
}

export async function handleChequeImage(env: Env, pid: string): Promise<Response> {
  let found;
  try {
    found = await firstImageDoc(env, pid);
  } catch (e) {
    if (e instanceof ZohoTimeout) throw new HttpError(504, 'زوهو لم يرد.');
    throw e;
  }
  if (!found) throw new HttpError(404, 'لا توجد صورة مرفقة بهذا الشيك.');

  const res = await fetchImage(env, pid, found.doc);
  if (!res) {
    console.error('cheque image: no route worked', pid);
    throw new HttpError(502, 'تعذّر تحميل صورة الشيك من زوهو.');
  }
  return new Response(res.body, {
    headers: {
      'Content-Type': contentType(res, found.type),
      'Cache-Control': 'private, max-age=600',
      'X-Content-Type-Options': 'nosniff',
      'Content-Disposition': 'inline',
    },
  });
}

const contentType = (res: Response, fallback: string) =>
  ((res.headers.get('Content-Type') || '').startsWith('image/') ? res.headers.get('Content-Type')!.split(';')[0].trim() : fallback);

async function fetchImage(env: Env, pid: string, doc: Doc): Promise<Response | null> {
  const preferred = await cacheGet(env, ROUTE_CACHE);
  const ordered = [...ROUTES].sort((a, b) => Number(b.id === preferred) - Number(a.id === preferred));
  for (const route of ordered) {
    let res: Response;
    try {
      res = await zohoFetchRaw(env, route.path(pid, doc.document_id!), route.params);
    } catch {
      continue;
    }
    if (!isImage(res)) {
      await res.body?.cancel();
      continue;
    }
    if (route.id !== preferred) await cachePut(env, ROUTE_CACHE, route.id, 30 * 86_400);
    return res;
  }
  return null;
}

// كلود يقبل الصورة حتى 5 ميغابايت بعد الترميز
const MAX_ORIENT_BYTES = 3_700_000;

function toBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

// اتجاه صورة الشيك: يُحدَّد بكلود مرة واحدة لكل مرفق ويُحفظ، فتظهر الصورة دائماً أفقية ومعتدلة
export async function handleImageRotation(env: Env, pid: string): Promise<Response> {
  let found;
  try {
    found = await firstImageDoc(env, pid);
  } catch {
    return json({ rotation: 0 });
  }
  if (!found) return json({ rotation: 0 });
  const docId = found.doc.document_id!;
  const row = await env.DB.prepare('SELECT document_id, rotation FROM image_rotation WHERE payment_id = ?')
    .bind(pid).first<{ document_id: string; rotation: number }>();
  if (row && row.document_id === docId) return json({ rotation: row.rotation });

  const save = async (rotation: number, source: string) => {
    await env.DB.prepare(
      'INSERT INTO image_rotation (payment_id, document_id, rotation, source) VALUES (?, ?, ?, ?) ' +
      "ON CONFLICT(payment_id) DO UPDATE SET document_id = excluded.document_id, rotation = excluded.rotation, source = excluded.source, at = datetime('now')",
    ).bind(pid, docId, rotation, source).run();
    return json({ rotation });
  };
  const res = await fetchImage(env, pid, found.doc).catch(() => null);
  if (!res) return json({ rotation: 0 });
  const type = contentType(res, found.type);
  const buf = await res.arrayBuffer();
  // صيغة لا يقرؤها كلود (مثل HEIC) أو صورة كبيرة جداً: تُعرض كما هي
  if (!isReadableType(type) || buf.byteLength > MAX_ORIENT_BYTES) return save(0, 'skip');
  const rotation = await readOrientation(env, { type, data: toBase64(buf) });
  if (rotation === null) return json({ rotation: 0 }); // يُعاد التحديد في المرة القادمة
  return save(rotation, 'claude');
}

// للمدير: نتيجة كل طريق لدفعة معيّنة، دون محتوى الصورة
export async function probeImage(env: Env, pid: string): Promise<Response> {
  const found = await firstImageDoc(env, pid);
  if (!found) return json({ payment_id: pid, image: null });
  const results = [];
  for (const route of ROUTES) {
    try {
      const res = await zohoFetchRaw(env, route.path(pid, found.doc.document_id!), route.params);
      const ct = res.headers.get('Content-Type');
      const len = res.headers.get('Content-Length');
      let code: unknown = null;
      if ((ct || '').includes('json')) code = ((await res.json().catch(() => ({}))) as { code?: unknown; message?: unknown });
      else await res.body?.cancel();
      results.push({ route: route.id, status: res.status, content_type: ct, length: len, ok: isImage(res), zoho: code });
    } catch (e) {
      results.push({ route: route.id, error: e instanceof Error ? e.name : String(e) });
    }
  }
  return json({ payment_id: pid, file_type: found.doc.file_type, routes: results, preferred: await cacheGet(env, ROUTE_CACHE) });
}
