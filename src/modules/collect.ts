import type { Env, User } from '../env';
import { HttpError, json, nowSec } from '../http';
import { cacheGet, cachePut, zohoGet } from '../zoho';
import { todayAlgiers } from './constants';
import type { AppModule } from './types';

// قسم «التحصيل» (7/11/2026، بطلب ZEKRI): أرصدة العملاء المدينين لكل مندوب، قراءة فقط من زوهو.
// نقل من تبويب «التحصيل» في قائمة الاتصال، لكن الأرقام هنا حيّة بدل سكربت الصباح.
// العميل ينسب إلى مندوبه بالحقل المخصص «Owner» (cf_owner) على العميل في زوهو.
// المندوب يرى عملاءه فقط، والتصفية في الخادم. المدير يرى الكل ويختار المندوب.
// لا كتابة في زوهو في هذا الملف.

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
  return snap;
}

const isOld = (c: CollCustomer) => c.late === null || c.late > 90;

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
  return json({
    at: snap.at * 1000,
    today: snap.today,
    rep,
    own_rep: own || null,
    is_admin: isAdmin,
    customers,
    reps: isAdmin ? summarize(snap.customers) : undefined,
  });
}

export const collectModule: AppModule = {
  id: 'coll',
  title: 'التحصيل',
  roles: ['admin', 'depositor', 'rep'],
  // المدير يرى القسم دائماً، وغيره إن كان له رمز مندوب
  allow: (user) => user.role === 'admin' || !!normRep(user.rep_code),
  async handle(req, env, user, subpath) {
    if (req.method === 'GET' && (subpath === '' || subpath === '/')) return handleCollect(req, env, user);
    throw new HttpError(404, 'غير موجود.');
  },
};
