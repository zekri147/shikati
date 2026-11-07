import type { Env } from '../env';
import { zohoRequest, ZohoTimeout } from '../zoho';

// كتابة في زوهو: تعليق المراجعة الأسبوعية على العميل (بموافقة ZEKRI يوم 7/11/2026).
// هذا الملف وحده يكتب تعليقات العملاء. يحتاج رمز التجديد الصلاحية ZohoBooks.contacts.CREATE.
// لا إعادة تلقائية بعد الإرسال: إن انقطع الرد صارت الحالة «unknown» ولا يُعاد الطلب حتى يتحقق المدير.
// الإعادة الوحيدة هي عند 401 أو الرمز 57 داخل zohoRequest، لأن زوهو لم ينفّذ الطلب.

export interface ReviewForComment {
  week: string;
  customer_id: string;
  rep: string;
  balance: number;
  note: string;
  reviewed_at: string; // بتوقيت غرينتش: YYYY-MM-DD HH:MM:SS
  late: number;
}

export type CommentResult =
  | { state: 'done'; comment_id: string }
  | { state: 'failed'; error: string }
  | { state: 'unknown'; error: string };

const ddmm = (iso: string) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}`;

function algiersTime(utc: string): { date: string; time: string } {
  const d = new Date(utc.replace(' ', 'T') + 'Z');
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Africa/Algiers', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(d).map((x) => [x.type, x.value]));
  return { date: `${p.day}/${p.month}`, time: `${p.hour}:${p.minute}` };
}

function fmtAmount(n: number): string {
  const [whole, frac] = Math.abs(n).toFixed(2).split('.');
  // الوحدة بالعربية حتى لا ينقلب ترتيب المبلغ داخل النص العربي في زوهو
  return whole.replace(/\B(?=(\d{3})+(?!\d))/g, ' ') + (frac === '00' ? '' : '.' + frac) + ' دج';
}

// نص التعليق كما يظهر في سجل العميل في زوهو، ويُعرض للمندوب قبل التأكيد
export function commentText(r: ReviewForComment): string {
  const t = algiersTime(r.reviewed_at);
  return `مراجعة التحصيل لأسبوع ${ddmm(r.week)}: راجعه ${r.rep} يوم ${t.date} الساعة ${t.time}${r.late ? ' (بعد الأجل)' : ''}. `
    + `الرصيد ${fmtAmount(r.balance)}. `
    + (r.note ? `الملاحظة: ${r.note}` : 'دون ملاحظة.')
    + ' — من تطبيق ميداني';
}

export async function postReviewComment(env: Env, r: ReviewForComment): Promise<CommentResult> {
  let res;
  try {
    res = await zohoRequest<{ contact_comment?: { comment_id?: string }; comment?: { comment_id?: string } }>(
      env, 'POST', `/contacts/${r.customer_id}/comments`, { body: { description: commentText(r) }, timeoutMs: 20_000 });
  } catch (e) {
    if (e instanceof ZohoTimeout) return { state: 'unknown', error: 'انقطع الرد بعد الإرسال' };
    throw e;
  }
  const d = res.data;
  if (res.status < 400 && d && d.code === 0) {
    const id = String(d.contact_comment?.comment_id || d.comment?.comment_id || '');
    return { state: 'done', comment_id: id };
  }
  // رد صريح من زوهو برمز خطأ: لم يُنفَّذ الطلب
  if (d && typeof d.code === 'number' && d.code !== 0 && res.status < 500) {
    console.error('zoho comment rejected', r.customer_id, res.status, d.code, d.message);
    const hint = d.code === 57 ? 'رمز التجديد لا يملك صلاحية التعليق على العملاء (ZohoBooks.contacts.CREATE)' : String(d.message || '').slice(0, 160);
    return { state: 'failed', error: `زوهو رفض التعليق (${d.code}): ${hint}` };
  }
  // 401 بعد تجديد الرمز: زوهو لم ينفّذ الطلب
  if (res.status === 401) return { state: 'failed', error: 'زوهو رفض رمز الوصول (401)' };
  // خطأ في الخادم أو رد غير مفهوم: لا نعرف إن كُتب التعليق
  console.error('zoho comment unclear', r.customer_id, res.status, d?.code);
  return { state: 'unknown', error: `رد غير واضح من زوهو (HTTP ${res.status})` };
}
