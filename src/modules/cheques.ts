import type { Env } from '../env';
import type { AppModule } from './types';
import { HttpError, json } from '../http';
import { cacheGet, cachePut, zohoGet } from '../zoho';
import { canDeposit, handleDeposit, lockStates, reconcileDoneLocks } from './deposit';
import { handleChequeImage } from './image';
import { ACCOUNT_CHEQUES_IN_HAND, CACHE_KEY, DEST, STATUS, todayAlgiers } from './constants';

export { ACCOUNT_CHEQUES_IN_HAND, DEST, STATUS, todayAlgiers };

const LOCATIONS: Record<string, string> = { ALGER: 'الجزائر', 'EL EULMA': 'العلمة' };

const CACHE_TTL = 60;
const MAX_PAGES = 50;

interface ZohoPayment {
  payment_id: string;
  payment_number?: string;
  customer_id: string;
  customer_name: string;
  amount: number;
  date: string;
  account_id: string;
  location_name?: string;
  reference_number?: string;
  last_modified_time?: string;
  has_attachment?: boolean;
  cf_5d7197?: string;
  cf_d_pos_vers?: string;
  cf_n_cheque?: string;
  check_details?: { check_number?: string };
}

interface ListResponse {
  customerpayments: ZohoPayment[];
  page_context?: { has_more_page?: boolean };
}

export interface Cheque {
  id: string;
  customer: string;
  amount: number;
  cheque_number: string;
  date: string;
  days: number;
  location: string;
  status: string;
  destination: string;
  // هل للدفعة مرفق في زوهو (صورة الشيك عادةً)
  has_image?: boolean;
  // حالة قفل الإيداع في التطبيق، إن وُجد
  lock?: string;
}

interface Section {
  items: Cheque[];
  count: number;
  total: number;
}

export interface ChequesView {
  generated_at: string;
  today: string;
  waiting: { count: number; total: number };
  rejected: Section;
  agb_in_hand: Section;
  rostomia_in_hand: Section;
  no_destination: Section;
  agb_pending_collection: Section;
  agb_recent: Section;
}

function daysBetween(from: string, to: string): number {
  const a = Date.parse(from + 'T00:00:00Z');
  const b = Date.parse(to + 'T00:00:00Z');
  if (Number.isNaN(a) || Number.isNaN(b)) return 0;
  return Math.max(0, Math.round((b - a) / 86_400_000));
}

export async function fetchAllChequePayments(env: Env): Promise<ZohoPayment[]> {
  const all: ZohoPayment[] = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    const data = await zohoGet<ListResponse>(env, '/customerpayments', {
      filter_by: 'PaymentMode.Check',
      per_page: 200,
      page,
    });
    all.push(...(data.customerpayments || []));
    if (!data.page_context?.has_more_page) return all;
  }
  // لا نعرض أرقاماً ناقصة على أنها كاملة
  throw new HttpError(502, 'عدد الشيكات أكبر من المتوقع. راجع المطوّر.');
}

function section(items: Cheque[]): Section {
  const total = Math.round(items.reduce((s, c) => s + c.amount, 0) * 100) / 100;
  return { items, count: items.length, total };
}

const oldestFirst = (a: Cheque, b: Cheque) => b.days - a.days || b.amount - a.amount;

export function buildView(payments: ZohoPayment[], today: string): ChequesView {
  const toCheque = (p: ZohoPayment): Cheque => ({
    id: p.payment_id,
    customer: p.customer_name,
    amount: Number(p.amount) || 0,
    cheque_number: (p.cf_n_cheque || p.check_details?.check_number || p.reference_number || '').trim(),
    date: p.date,
    days: daysBetween(p.date, today),
    location: LOCATIONS[(p.location_name || '').toUpperCase()] || p.location_name || '',
    status: (p.cf_5d7197 || '').trim(),
    destination: (p.cf_d_pos_vers || '').trim(),
    has_image: !!p.has_attachment,
  });

  const rejected: Cheque[] = [];
  const agbInHand: Cheque[] = [];
  const rostomiaInHand: Cheque[] = [];
  const noDest: Cheque[] = [];
  const agbPending: Cheque[] = [];
  const agbRecent: { c: Cheque; t: string }[] = [];

  for (const p of payments) {
    const c = toCheque(p);
    const inHandCIH = c.status === STATUS.IN_HAND && p.account_id === ACCOUNT_CHEQUES_IN_HAND;

    if (c.status === STATUS.REJECTED) rejected.push(c);
    if (inHandCIH && c.destination === DEST.AGB) agbInHand.push(c);
    if (inHandCIH && c.destination === DEST.ROSTOMIA) rostomiaInHand.push(c);
    if (inHandCIH && !c.destination) noDest.push(c);
    if (c.status === STATUS.DEPOSITED && c.destination === DEST.AGB) agbPending.push(c);
    if ((c.status === STATUS.DEPOSITED || c.status === STATUS.COLLECTED) && c.destination === DEST.AGB) {
      agbRecent.push({ c, t: p.last_modified_time || p.date });
    }
  }

  [rejected, agbInHand, rostomiaInHand, noDest, agbPending].forEach((l) => l.sort(oldestFirst));
  // لا يوجد تاريخ إيداع في القائمة، فنرتّب بآخر تعديل للدفعة كأقرب مؤشر
  agbRecent.sort((a, b) => (a.t < b.t ? 1 : a.t > b.t ? -1 : 0));

  const waitingItems = [...agbInHand, ...rostomiaInHand, ...noDest];
  const waiting = section(waitingItems);

  return {
    generated_at: new Date().toISOString(),
    today,
    waiting: { count: waiting.count, total: waiting.total },
    rejected: section(rejected),
    agb_in_hand: section(agbInHand),
    rostomia_in_hand: section(rostomiaInHand),
    no_destination: section(noDest),
    agb_pending_collection: section(agbPending),
    agb_recent: section(agbRecent.slice(0, 5).map((x) => x.c)),
  };
}

async function getView(env: Env, refresh: boolean): Promise<ChequesView> {
  if (!refresh) {
    const cached = await cacheGet(env, CACHE_KEY);
    if (cached) return JSON.parse(cached) as ChequesView;
  }
  const view = buildView(await fetchAllChequePayments(env), todayAlgiers());
  await cachePut(env, CACHE_KEY, JSON.stringify(view), CACHE_TTL);
  return view;
}

export const chequesModule: AppModule = {
  id: 'cheques',
  title: 'شيكاتي',
  roles: ['admin', 'depositor'],
  async handle(req, env, user, subpath) {
    if (req.method === 'GET' && (subpath === '' || subpath === '/')) {
      const refresh = new URL(req.url).searchParams.get('refresh') === '1';
      const view = await getView(env, refresh);
      // الأقفال تُقرأ في كل طلب، لا من التخزين المؤقت
      const locks = await lockStates(env);
      for (const c of view.agb_in_hand.items) if (locks[c.id]) c.lock = locks[c.id];
      await reconcileDoneLocks(env, view.agb_in_hand.items);
      return json({ ...view, can_deposit: canDeposit(env, user) });
    }
    if (req.method === 'POST' && subpath === '/deposit') return handleDeposit(req, env, user);
    const img = subpath.match(/^\/image\/(\d{10,25})$/);
    if (req.method === 'GET' && img) return handleChequeImage(env, img[1]);
    throw new HttpError(404, 'غير موجود.');
  },
};
