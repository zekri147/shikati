import type { Env, User } from '../env';
import { HttpError, json, nowSec, readJson } from '../http';
import { audit } from '../audit';
import { cacheGet, cachePut, zohoGet } from '../zoho';
import { todayAlgiers } from './constants';
import type { AppModule } from './types';
import { commentText, postReviewComment, type CommentResult } from './collcomment';

// قسم «التحصيل» (7/11/2026، بطلب ZEKRI): أرصدة العملاء المدينين لكل مندوب، قراءة فقط من زوهو.
// نقل من تبويب «التحصيل» في قائمة الاتصال، لكن الأرقام هنا حيّة بدل سكربت الصباح.
// العميل ينسب إلى مندوبه بالحقل المخصص «Owner» (cf_owner) على العميل في زوهو.
// المندوب يرى عملاءه فقط، والتصفية في الخادم. المدير يرى الكل ويختار المندوب.
// المراجعة الأسبوعية تُحفظ في الجدول coll_reviews، ثم تُرسل فوراً تعليقاً على العميل في زوهو.
// منذ 7/11/2026 (بطلب ZEKRI) تشمل كل عميل مدين، وعدد ما يحتاجه كل مندوب يُحفظ في coll_week_need.
// الكتابة في زوهو نفسها في collcomment.ts وحده (بموافقة ZEKRI يوم 7/11/2026).

const CACHE_KEY = 'coll_snapshot';
const TTL = 600;            // عشر دقائق
const MIN_REFRESH = 60;     // التحديث اليدوي لا يطلب زوهو أكثر من مرة في الدقيقة
const MAX_PAGES = 10;
const REP_RE = /^[A-Z][A-Z0-9 _-]{1,31}$/;

interface ZohoContact {
  contact_id: string;
  contact_name: string;
  contact_type?: string;
  outstanding_receivable_amount?: number;
  mobile?: string;
  phone?: string;
  cf_owner?: string;
  custom_field_hash?: Record<string, string>;
}
interface ZohoInvoice {
  invoice_id: string;
  invoice_number: string;
  customer_id: string;
  date: string;
  due_date?: string;
  balance: number;
  location_name?: string;
}

export interface CollInvoice { number: string; date: string; due: string; balance: number; late: number }
export interface CollCustomer {
  id: string;
  name: string;
  owner: string;          // رمز المندوب، أو فارغ إن لم يُحدَّد في زوهو
  balance: number;        // رصيد العميل كاملاً في زوهو
  opening: number;        // الرصيد الافتتاحي: الرصيد ناقص مجموع الفواتير غير المسدّدة
  late: number | null;    // أيام تأخر أقدم فاتورة غير مسدّدة، و0 إن لم يحن موعدها، وnull إن لم تكن له فواتير
  phone: string;          // أرقام دولية فقط، مثل 213661460848
  location: string;
  invoices: CollInvoice[];
}
interface Snapshot { at: number; today: string; customers: CollCustomer[] }

const round2 = (n: number) => Math.round(n * 100) / 100;

function daysLate(due: string, today: string): number {
  const ms = Date.parse(today + 'T12:00:00Z') - Date.parse(due.slice(0, 10) + 'T12:00:00Z');
  return Number.isFinite(ms) ? Math.max(0, Math.round(ms / 86_400_000)) : 0;
}

// الهاتف بصيغة دولية لروابط الاتصال وواتساب: +213-0561765718 أو 0561765718 تصبح 213561765718
export function intlPhone(raw: string | undefined): string {
  let d = String(raw || '').replace(/\D/g, '');
  if (d.startsWith('00')) d = d.slice(2);
  if (d.startsWith('2130')) d = '213' + d.slice(4);
  else if (d.startsWith('0') && d.length === 10) d = '213' + d.slice(1);
  else if (d.length === 9 && /^[567]/.test(d)) d = '213' + d;
  return /^\d{11,15}$/.test(d) ? d : '';
}

export const normRep = (s: unknown) => String(s ?? '').trim().toUpperCase();

export function buildSnapshot(contacts: ZohoContact[], invoices: ZohoInvoice[], today: string): CollCustomer[] {
  const byCustomer = new Map<string, ZohoInvoice[]>();
  for (const inv of invoices) {
    if (!(Number(inv.balance) > 0)) continue;
    const list = byCustomer.get(inv.customer_id) || [];
    list.push(inv);
    byCustomer.set(inv.customer_id, list);
  }
  const out: CollCustomer[] = [];
  for (const c of contacts) {
    if (c.contact_type && c.contact_type !== 'customer') continue;
    const balance = round2(Number(c.outstanding_receivable_amount) || 0);
    if (balance < 1) continue;
    const invs = (byCustomer.get(c.contact_id) || [])
      .map((i) => ({ number: i.invoice_number, date: i.date, due: (i.due_date || i.date || '').slice(0, 10), balance: round2(Number(i.balance)), loc: i.location_name || '' }))
      .sort((a, b) => a.due.localeCompare(b.due));
    const invSum = invs.reduce((t, i) => t + i.balance, 0);
    const opening = round2(balance - invSum);
    const owner = normRep(c.cf_owner ?? c.custom_field_hash?.cf_owner);
    out.push({
      id: c.contact_id,
      name: c.contact_name,
      owner: REP_RE.test(owner) ? owner : '',
      balance,
      opening: opening >= 1 ? opening : 0,
      late: invs.length ? daysLate(invs[0].due, today) : null,
      phone: intlPhone(c.mobile) || intlPhone(c.phone),
      location: invs.length ? invs[invs.length - 1].loc : '',
      invoices: invs.map((i) => ({ number: i.number, date: i.date, due: i.due, balance: i.balance, late: daysLate(i.due, today) })),
    });
  }
  // الأقدم تأخراً أولاً، ثم الرصيد الافتتاحي (بلا تاريخ)، ثم الأكبر رصيداً
  return out.sort((a, b) => (b.late ?? -1) - (a.late ?? -1) || b.balance - a.balance);
}

// العملاء المدينون: مرتبون بالرصيد تنازلياً، فنتوقف عند أول صفحة تصل إلى رصيد صفر
async function fetchDebtors(env: Env): Promise<ZohoContact[]> {
  const out: ZohoContact[] = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    const data = await zohoGet<{ contacts?: ZohoContact[]; page_context?: { has_more_page?: boolean } }>(env, '/contacts', {
      contact_type: 'customer', sort_column: 'outstanding_receivable_amount', sort_order: 'D', per_page: 200, page,
    });
    const rows = data.contacts || [];
    out.push(...rows);
    const last = rows[rows.length - 1];
    if (!data.page_context?.has_more_page || !last || !(Number(last.outstanding_receivable_amount) > 0)) break;
  }
  return out;
}

// الفواتير غير المسدّدة: «unpaid» في زوهو تشمل المرسلة والمتأخرة والمسدّدة جزئياً
async function fetchUnpaidInvoices(env: Env): Promise<ZohoInvoice[]> {
  const out: ZohoInvoice[] = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    const data = await zohoGet<{ invoices?: ZohoInvoice[]; page_context?: { has_more_page?: boolean } }>(env, '/invoices', {
      status: 'unpaid', per_page: 200, page,
    });
    out.push(...(data.invoices || []));
    if (!data.page_context?.has_more_page) break;
  }
  return out;
}

async function getSnapshot(env: Env, refresh: boolean): Promise<Snapshot> {
  const cached = await cacheGet(env, CACHE_KEY);
  if (cached) {
    const snap = JSON.parse(cached) as Snapshot;
    if (!refresh || nowSec() - snap.at < MIN_REFRESH) return snap;
  }
  const today = todayAlgiers();
  const [contacts, invoices] = await Promise.all([fetchDebtors(env), fetchUnpaidInvoices(env)]);
  const snap: Snapshot = { at: nowSec(), today, customers: buildSnapshot(contacts, invoices, today) };
  await cachePut(env, CACHE_KEY, JSON.stringify(snap), TTL);
  await recordNeed(env, snap.customers);
  return snap;
}

const isOld = (c: CollCustomer) => c.late === null || c.late > 90;
// من يحتاج مراجعة هذا الأسبوع: كل عميل مدين له مندوب (منذ 7/11/2026، بطلب ZEKRI).
// قبلها: من تأخر دينه أكثر من 90 يوماً أو عليه رصيد افتتاحي فقط.
export const needsReview = (c: CollCustomer) => c.balance >= 1 && !!c.owner;

// عدد من يحتاج مراجعة لكل مندوب هذا الأسبوع: يُستبدل كاملاً مع كل تحديث للأرصدة، فيبقى آخر رقم بعد نهاية الأسبوع
export function needByRep(customers: CollCustomer[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const c of customers) if (needsReview(c)) out.set(c.owner, (out.get(c.owner) || 0) + 1);
  return out;
}
async function recordNeed(env: Env, customers: CollCustomer[]) {
  const week = reviewWeek(todayAlgiers());
  const stmts = [env.DB.prepare('DELETE FROM coll_week_need WHERE week = ?').bind(week)];
  for (const [rep, need] of needByRep(customers)) {
    stmts.push(env.DB.prepare('INSERT INTO coll_week_need (week, rep, need) VALUES (?, ?, ?)').bind(week, rep, need));
  }
  try { await env.DB.batch(stmts); } catch (e) { console.error('coll_week_need', e); }
}

// ——— المراجعة الأسبوعية: الأسبوع من السبت إلى الخميس، والأجل الخميس 12:00 بتوقيت الجزائر ———

const NOTE_MAX = 400;
const ID_RE = /^\d{10,25}$/;

// تاريخ سبت الأسبوع الذي فيه اليوم (بتوقيت الجزائر). الجمعة تتبع الأسبوع الذي بدأ قبلها.
export function reviewWeek(today: string): string {
  const d = new Date(today + 'T12:00:00Z');
  const back = (d.getUTCDay() + 1) % 7; // السبت 0، الأحد 1، ... الجمعة 6
  d.setUTCDate(d.getUTCDate() - back);
  return d.toISOString().slice(0, 10);
}
// الخميس 12:00 بتوقيت الجزائر (غرينتش +1 طوال السنة) = 11:00 بتوقيت غرينتش
export function reviewDeadline(week: string): number {
  return Date.parse(week + 'T11:00:00Z') + 5 * 86_400_000;
}

interface ReviewRow {
  week: string; customer_id: string; rep: string; customer_name: string; balance: number; note: string;
  username: string; reviewed_at: string; late: number; zoho_state: string; zoho_error: string | null;
}
const REVIEW_COLS = 'week, customer_id, rep, customer_name, balance, note, username, reviewed_at, late, zoho_state, zoho_error';

async function weekReviews(env: Env, week: string, rep?: string): Promise<ReviewRow[]> {
  const sql = `SELECT ${REVIEW_COLS} FROM coll_reviews WHERE week = ?` + (rep ? ' AND rep = ?' : '');
  const stmt = rep ? env.DB.prepare(sql).bind(week, rep) : env.DB.prepare(sql).bind(week);
  return (await stmt.all<ReviewRow>()).results || [];
}

// تقدّم المراجعة لكل مندوب: كم يحتاج، وكم راجع، وآخر مراجعة
function reviewProgress(customers: CollCustomer[], rows: ReviewRow[]) {
  const done = new Map(rows.map((r) => [r.customer_id, r]));
  const out = new Map<string, { rep: string; need: number; done: number; last: string; late: number }>();
  for (const c of customers) {
    if (!c.owner || !needsReview(c)) continue;
    const p = out.get(c.owner) || { rep: c.owner, need: 0, done: 0, last: '', late: 0 };
    p.need++;
    const r = done.get(c.id);
    if (r) {
      p.done++;
      if (r.late) p.late++;
      if (r.reviewed_at > p.last) p.last = r.reviewed_at;
    }
    out.set(c.owner, p);
  }
  return [...out.values()].sort((a, b) => a.rep.localeCompare(b.rep));
}

// ——— الإرسال إلى زوهو (المرحلة الثالثة): الكتابة نفسها في collcomment.ts ———

// القفل: الصف يصير «pending» بإدخال ذري، فلا يُرسل تعليقان للمراجعة نفسها
const SENDABLE = "('none', 'failed')";

async function sendRow(env: Env, actor: User, week: string, id: string): Promise<{ state: string; error?: string }> {
  const lock = await env.DB.prepare(
    `UPDATE coll_reviews SET zoho_state = 'pending', zoho_error = NULL WHERE week = ? AND customer_id = ? AND zoho_state IN ${SENDABLE}`,
  ).bind(week, id).run();
  if (!lock.meta.changes) throw new HttpError(409, 'هذه المراجعة أُرسلت إلى زوهو أو قيد الإرسال.');
  const row = await env.DB.prepare(`SELECT ${REVIEW_COLS} FROM coll_reviews WHERE week = ? AND customer_id = ?`).bind(week, id).first<ReviewRow>();
  if (!row) throw new HttpError(404, 'المراجعة غير موجودة.');
  let result: CommentResult;
  try {
    result = await postReviewComment(env, row);
  } catch (e) {
    // خطأ قبل الإرسال (رمز الوصول مثلاً): زوهو لم يستقبل شيئاً
    result = { state: 'failed', error: e instanceof HttpError ? e.publicMessage : 'تعذّر الاتصال بزوهو' };
  }
  if (result.state === 'done') {
    await env.DB.prepare("UPDATE coll_reviews SET zoho_state = 'done', zoho_comment_id = ?, zoho_error = NULL WHERE week = ? AND customer_id = ?")
      .bind(result.comment_id, week, id).run();
  } else {
    await env.DB.prepare('UPDATE coll_reviews SET zoho_state = ?, zoho_error = ? WHERE week = ? AND customer_id = ?')
      .bind(result.state, result.error, week, id).run();
  }
  await audit(env, actor, 'coll.comment', result.state === 'done' ? 'ok' : 'error', row.customer_name,
    result.state === 'done' ? undefined : `${result.state}: ${result.error}`);
  return result.state === 'done' ? { state: 'done' } : { state: result.state, error: result.error };
}

// تسجيل المراجعة ثم إرسالها فوراً تعليقاً على العميل في زوهو. المندوب يراجع عملاءه فقط.
// بعد الإرسال تُقفل المراجعة. والمرفوضة من زوهو تُعدَّل ملاحظتها وتُرسل من جديد.
async function saveReview(req: Request, env: Env, user: User): Promise<Response> {
  const b = await readJson<{ customer_id?: string; note?: string }>(req);
  const id = String(b.customer_id || '');
  if (!ID_RE.test(id)) throw new HttpError(400, 'العميل غير صالح.');
  const note = String(b.note ?? '').replace(/\s+/g, ' ').trim().slice(0, NOTE_MAX);
  const own = normRep(user.rep_code);
  if (!own || user.role === 'admin') throw new HttpError(403, 'المراجعة للمندوب صاحب العميل فقط.');
  const snap = await getSnapshot(env, false);
  const c = snap.customers.find((x) => x.id === id);
  if (!c || c.owner !== own) throw new HttpError(403, 'هذا العميل ليس من عملائك.');
  if (!needsReview(c)) throw new HttpError(400, 'هذا العميل لا يحتاج مراجعة هذا الأسبوع.');
  const now = Date.now();
  const week = reviewWeek(todayAlgiers(new Date(now)));
  const late = now > reviewDeadline(week) ? 1 : 0;
  // مراجعة جديدة، أو تعديل ملاحظة مراجعة لم تصل إلى زوهو
  const up = await env.DB.prepare(
    'INSERT INTO coll_reviews (week, customer_id, rep, customer_name, balance, note, user_id, username, late, zoho_state) ' +
    "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'none') " +
    `ON CONFLICT(week, customer_id) DO UPDATE SET note = excluded.note WHERE coll_reviews.zoho_state IN ${SENDABLE}`,
  ).bind(week, id, own, c.name, c.balance, note, user.id, user.username, late).run();
  if (!up.meta.changes) {
    const cur = await env.DB.prepare('SELECT zoho_state FROM coll_reviews WHERE week = ? AND customer_id = ?').bind(week, id).first<{ zoho_state: string }>();
    throw new HttpError(409, cur?.zoho_state === 'done'
      ? 'سُجّلت هذه المراجعة في زوهو، فلا تُعدَّل.'
      : 'لم يصل رد واضح من زوهو لهذه المراجعة. لا تعد المحاولة: الإدارة تتحقق منها.');
  }
  await audit(env, user, 'coll.review', 'ok', c.name, note ? 'note' : undefined);
  const sent = await sendRow(env, user, week, id);
  return json({ ok: true, week, late: !!late, zoho: sent.state, error: sent.error });
}

// الإلغاء ممكن فقط لمراجعة لم تصل إلى زوهو
async function cancelReview(env: Env, user: User, id: string): Promise<Response> {
  if (!ID_RE.test(id)) throw new HttpError(400, 'العميل غير صالح.');
  const own = normRep(user.rep_code);
  if (!own) throw new HttpError(403, 'المراجعة للمندوب صاحب العميل فقط.');
  const week = reviewWeek(todayAlgiers());
  const r = await env.DB.prepare(`DELETE FROM coll_reviews WHERE week = ? AND customer_id = ? AND rep = ? AND zoho_state IN ${SENDABLE}`)
    .bind(week, id, own).run();
  if (!r.meta.changes) throw new HttpError(409, 'لا مراجعة قابلة للإلغاء: ما سُجّل في زوهو لا يُلغى من التطبيق.');
  await audit(env, user, 'coll.review.cancel', 'ok', id);
  return json({ ok: true });
}

// ——— للمدير: المراجعات التي لم تصل إلى زوهو، في كل الأسابيع ———

async function unsent(env: Env) {
  const { results } = await env.DB.prepare(
    `SELECT ${REVIEW_COLS} FROM coll_reviews WHERE zoho_state != 'done' ORDER BY week DESC, reviewed_at DESC LIMIT 200`,
  ).all<ReviewRow>();
  return (results || []).map((r) => ({
    week: r.week, id: r.customer_id, rep: r.rep, name: r.customer_name, note: r.note, at: r.reviewed_at,
    state: r.zoho_state, error: r.zoho_error, text: commentText(r),
  }));
}

function adminTarget(b: { week?: string; customer_id?: string }) {
  const week = String(b.week || '');
  const id = String(b.customer_id || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(week) || !ID_RE.test(id)) throw new HttpError(400, 'المراجعة غير صالحة.');
  return { week, id };
}

// إرسال مراجعة لم تُرسل أو رفضها زوهو. لا يشمل «unknown»: تلك تحتاج تحقق المدير أولاً.
async function adminSend(req: Request, env: Env, user: User): Promise<Response> {
  const { week, id } = adminTarget(await readJson(req));
  return json({ ok: true, ...(await sendRow(env, user, week, id)) });
}

// بعد أن يتحقق المدير في زوهو من مراجعة انقطع ردها (أو بقيت «قيد الإرسال» لتوقف الخادم): موجودة (تُقفل) أو غير موجودة (تصبح قابلة للإرسال)
async function adminResolve(req: Request, env: Env, user: User): Promise<Response> {
  const b = await readJson<{ week?: string; customer_id?: string; found?: boolean }>(req);
  const { week, id } = adminTarget(b);
  const r = await env.DB.prepare("UPDATE coll_reviews SET zoho_state = ?, zoho_error = ? WHERE week = ? AND customer_id = ? AND zoho_state IN ('unknown', 'pending')")
    .bind(b.found ? 'done' : 'failed', b.found ? null : 'تحقق المدير: غير موجود في زوهو', week, id).run();
  if (!r.meta.changes) throw new HttpError(409, 'هذه المراجعة ليست بانتظار التحقق.');
  await audit(env, user, 'coll.comment.resolve', 'ok', id, b.found ? 'found' : 'not_found');
  return json({ ok: true });
}

// ——— التذكير: كم بقي للمندوب هذا الأسبوع، لسطر التذكير الثابت في كل الشاشات ———

async function reviewStatus(env: Env, user: User): Promise<Response> {
  const own = normRep(user.rep_code);
  const week = reviewWeek(todayAlgiers());
  const deadline = reviewDeadline(week);
  if (!own || user.role === 'admin') return json({ week, deadline, need: 0, done: 0 });
  const snap = await getSnapshot(env, false);
  const mine = snap.customers.filter((c) => c.owner === own && needsReview(c));
  const rows = await weekReviews(env, week, own);
  const done = new Set(rows.map((r) => r.customer_id));
  return json({ week, deadline, need: mine.length, done: mine.filter((c) => done.has(c.id)).length });
}

// للمدير: الأسابيع الماضية لكل مندوب، كم احتاج وكم راجع وكم بعد الأجل (آخر 8 أسابيع)
async function reviewHistory(env: Env, week: string) {
  const { results } = await env.DB.prepare(
    'SELECT n.week AS week, n.rep AS rep, n.need AS need, ' +
    '(SELECT COUNT(*) FROM coll_reviews r WHERE r.week = n.week AND r.rep = n.rep) AS done, ' +
    '(SELECT COUNT(*) FROM coll_reviews r WHERE r.week = n.week AND r.rep = n.rep AND r.late = 1) AS late ' +
    'FROM coll_week_need n WHERE n.week < ? ORDER BY n.week DESC, n.rep LIMIT 80',
  ).bind(week).all<{ week: string; rep: string; need: number; done: number; late: number }>();
  const weeks = new Map<string, { week: string; reps: { rep: string; need: number; done: number; late: number }[] }>();
  for (const r of results || []) {
    const w = weeks.get(r.week) || { week: r.week, reps: [] };
    // من سدّد دينه بعد مراجعته يخرج من العدد، فلا يتجاوز ما راجعه ما احتاجه
    w.reps.push({ rep: r.rep, need: r.need, done: Math.min(r.done, r.need), late: Math.min(r.late, r.done, r.need) });
    weeks.set(r.week, w);
  }
  return [...weeks.values()].slice(0, 8);
}

function summarize(customers: CollCustomer[]) {
  const reps = new Map<string, { rep: string; total: number; old: number; count: number }>();
  for (const c of customers) {
    const r = reps.get(c.owner) || { rep: c.owner, total: 0, old: 0, count: 0 };
    r.total = round2(r.total + c.balance);
    if (isOld(c)) r.old = round2(r.old + c.balance);
    r.count++;
    reps.set(c.owner, r);
  }
  return [...reps.values()].sort((a, b) => b.total - a.total);
}

export async function handleCollect(req: Request, env: Env, user: User): Promise<Response> {
  const url = new URL(req.url);
  const snap = await getSnapshot(env, url.searchParams.get('refresh') === '1');
  const isAdmin = user.role === 'admin';
  const own = normRep(user.rep_code);
  // المدير يختار المندوب (أو الكل)، وغيره يرى عملاءه فقط مهما أرسل
  let rep = own;
  if (isAdmin) {
    const asked = url.searchParams.get('rep');
    rep = asked === null ? '' : asked === '-' ? '-' : normRep(asked);
  }
  const customers = rep === ''
    ? (isAdmin ? snap.customers : [])
    : snap.customers.filter((c) => (rep === '-' ? c.owner === '' : c.owner === rep));
  // المراجعة: أسبوع اليوم، لا أسبوع الصورة المحفوظة
  const week = reviewWeek(todayAlgiers());
  const rows = await weekReviews(env, week, isAdmin ? undefined : own);
  const shown = new Set(customers.map((c) => c.id));
  const reviews: Record<string, { at: string; note: string; late: boolean; by: string; zoho: string }> = {};
  for (const r of rows) if (shown.has(r.customer_id)) reviews[r.customer_id] = { at: r.reviewed_at, note: r.note, late: !!r.late, by: r.username, zoho: r.zoho_state };
  return json({
    at: snap.at * 1000,
    today: snap.today,
    rep,
    own_rep: own || null,
    is_admin: isAdmin,
    customers,
    reps: isAdmin ? summarize(snap.customers) : undefined,
    review: {
      week,
      deadline: reviewDeadline(week),
      can_review: !!own && !isAdmin,
      items: reviews,
      // المدير: تقدّم كل مندوب، وكل الملاحظات المكتوبة هذا الأسبوع
      progress: isAdmin ? reviewProgress(snap.customers, rows) : undefined,
      notes: isAdmin ? rows.filter((r) => r.note).sort((a, b) => b.reviewed_at.localeCompare(a.reviewed_at))
        .map((r) => ({ rep: r.rep, name: r.customer_name, note: r.note, at: r.reviewed_at, late: !!r.late })) : undefined,
      // المدير: ما لم يصل إلى زوهو، مع سببه
      unsent: isAdmin ? await unsent(env) : undefined,
      // المدير: سجل الالتزام في الأسابيع الماضية
      history: isAdmin ? await reviewHistory(env, week) : undefined,
    },
  });
}

export const collectModule: AppModule = {
  id: 'coll',
  title: 'التحصيل',
  roles: ['admin', 'rep'],
  // المدير يرى القسم دائماً، وغيره إن كان له رمز مندوب
  allow: (user) => user.role === 'admin' || !!normRep(user.rep_code),
  async handle(req, env, user, subpath) {
    if (req.method === 'GET' && (subpath === '' || subpath === '/')) return handleCollect(req, env, user);
    if (req.method === 'GET' && subpath === '/status') return reviewStatus(env, user);
    if (req.method === 'POST' && subpath === '/review') return saveReview(req, env, user);
    if (req.method === 'POST' && subpath === '/review/send' && user.role === 'admin') return adminSend(req, env, user);
    if (req.method === 'POST' && subpath === '/review/resolve' && user.role === 'admin') return adminResolve(req, env, user);
    const m = subpath.match(/^\/review\/(\d{10,25})$/);
    if (req.method === 'DELETE' && m) return cancelReview(env, user, m[1]);
    throw new HttpError(404, 'غير موجود.');
  },
};
