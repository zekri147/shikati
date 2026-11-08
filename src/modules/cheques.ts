import type { Env } from '../env';
import type { AppModule } from './types';
import { HttpError, json } from '../http';
import { cacheGet, cachePut, zohoGet } from '../zoho';
import { canDeposit, handleDeposit, lockStates, reconcileDoneLocks } from './deposit';
import { handleChequeImage, handleImageRotation } from './image';
import { handleChequeDetail } from './detail';
import { canRegister, handleOrient, handlePreview, handleRead, handleRegister, registerOptions, searchCustomers } from './register';
import { ACCOUNT_CHEQUES_IN_HAND, ACCOUNT_ENDORSED, CACHE_KEY, DEST, STATUS, todayAlgiers } from './constants';
import { handleBillsPreview, handleEndorse, searchVendors } from './endorse';
import { handleUndo } from './undo';
import { handleEdit, handleEditPreview } from './edit';
import { custodyMap, custodyPeople, handleCustody, type CustodyInfo } from './custody';
import { chequeNumber, wrongAccountText } from './fields';
import { COLLECT_LATE_DAYS, fieldDate, fillDepositDates } from './depositdate';

export { ACCOUNT_CHEQUES_IN_HAND, DEST, STATUS, todayAlgiers };

const LOCATIONS: Record<string, string> = { ALGER: 'الجزائر', 'EL EULMA': 'العلمة' };

const CACHE_TTL = 60;
const MAX_PAGES = 50;
export const LATE_DAYS = 7;

interface ZohoPayment {
  payment_id: string;
  payment_number?: string;
  customer_id: string;
  customer_name: string;
  amount: number;
  date: string;
  account_id: string;
  account_name?: string;
  location_name?: string;
  reference_number?: string;
  invoice_numbers?: string;
  last_modified_time?: string;
  has_attachment?: boolean;
  cf_5d7197?: string;
  cf_d_pos_vers?: string;
  cf_n_cheque?: string;
  cf_023de7?: string;
  cf_51a7f5?: string;
  cf_46404d?: string;
  cf_46404d_unformatted?: string;
  check_details?: { check_number?: string };
}

interface ListResponse {
  customerpayments: ZohoPayment[];
  page_context?: { has_more_page?: boolean };
}

export interface Cheque {
  id: string;
  number: string;
  customer: string;
  // معرّف العميل في زوهو: لمعرفة مندوبه في إشعار الشيك المرفوض (src/notify.ts)
  customer_id?: string;
  amount: number;
  cheque_number: string;
  date: string;
  days: number;
  location: string;
  status: string;
  destination: string;
  account: string;
  invoices: string;
  // هل للدفعة مرفق في زوهو (صورة الشيك عادةً)
  has_image?: boolean;
  // حالة قفل الإيداع في التطبيق، إن وُجد
  lock?: string;
  // العهدة: من يحمل الشيك، للشيكات في الحوزة. تُضاف في كل طلب، لا تُخزَّن
  custody?: CustodyInfo;
  // تاريخ الإيداع في البنك، للشيكات المودعة
  deposit_date?: string;
  // أيام منذ الإيداع دون تحصيل
  deposit_days?: number;
}

interface Section {
  items: Cheque[];
  count: number;
  total: number;
}

// التنبيهات تعوّض ما كان يصل عبر تيليجرام. كل تنبيه يشير إلى شيك في قائمة all.
export type AlertKind = 'rejected' | 'late' | 'collect_late' | 'endorse_incomplete' | 'wrong_account' | 'unknown_lock' | 'box' | 'fiscal' | 'handover';
export interface ChequeAlert {
  kind: AlertKind;
  id: string;
  text?: string;
}
// تنبيهات تخص المدير وحده
const ADMIN_ONLY: AlertKind[] = ['box', 'fiscal', 'unknown_lock'];

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
  // كل الشيكات بكل حالاتها، الأحدث أولاً، للبحث وصفحة التنبيهات
  all: Cheque[];
  alerts: ChequeAlert[];
}

function daysBetween(from: string, to: string): number {
  const a = Date.parse(from + 'T00:00:00Z');
  const b = Date.parse(to + 'T00:00:00Z');
  if (Number.isNaN(a) || Number.isNaN(b)) return 0;
  return Math.round((b - a) / 86_400_000);
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
    number: p.payment_number || '',
    customer: p.customer_name,
    customer_id: p.customer_id,
    amount: Number(p.amount) || 0,
    cheque_number: chequeNumber(p.cf_n_cheque || p.check_details?.check_number || p.reference_number),
    date: p.date,
    days: Math.max(0, daysBetween(p.date, today)),
    location: LOCATIONS[(p.location_name || '').toUpperCase()] || p.location_name || '',
    status: (p.cf_5d7197 || '').trim(),
    destination: (p.cf_d_pos_vers || '').trim(),
    account: (p.account_name || '').trim(),
    invoices: (p.invoice_numbers || '').trim(),
    has_image: !!p.has_attachment,
    deposit_date: fieldDate(p as unknown as Record<string, unknown>) || undefined,
  });

  const rejected: Cheque[] = [];
  const agbInHand: Cheque[] = [];
  const rostomiaInHand: Cheque[] = [];
  const noDest: Cheque[] = [];
  const agbPending: Cheque[] = [];
  const agbRecent: { c: Cheque; t: string }[] = [];
  const all: { c: Cheque; t: string }[] = [];
  const alerts: ChequeAlert[] = [];

  for (const p of payments) {
    const c = toCheque(p);
    const inHandCIH = c.status === STATUS.IN_HAND && p.account_id === ACCOUNT_CHEQUES_IN_HAND;
    all.push({ c, t: p.date + (p.last_modified_time || '') });

    if (c.status === STATUS.REJECTED) rejected.push(c);
    if (inHandCIH && c.destination === DEST.AGB) agbInHand.push(c);
    if (inHandCIH && c.destination === DEST.ROSTOMIA) rostomiaInHand.push(c);
    if (inHandCIH && !c.destination) noDest.push(c);
    if (c.status === STATUS.DEPOSITED && c.destination === DEST.AGB) agbPending.push(c);
    if ((c.status === STATUS.DEPOSITED || c.status === STATUS.COLLECTED) && c.destination === DEST.AGB) {
      agbRecent.push({ c, t: p.last_modified_time || p.date });
    }

    // التنبيهات: فقط للشيكات التي ما زالت في دورة حياتها
    if (c.status === STATUS.REJECTED) alerts.push({ kind: 'rejected', id: c.id });
    const active = c.status === STATUS.IN_HAND || c.status === STATUS.DEPOSITED || c.status === '';
    if (!active) continue;
    if (c.status === STATUS.IN_HAND && c.days > LATE_DAYS) alerts.push({ kind: 'late', id: c.id });
    const wrong = wrongAccountText(p.account_id, c.account, c.destination);
    if (wrong) alerts.push({ kind: 'wrong_account', id: c.id, text: wrong });
    // مسجّل لمورد في حساب الشيكات المظهّرة، ولم تُنشأ دفعة المورد بعد
    if (c.status === STATUS.IN_HAND && p.account_id === ACCOUNT_ENDORSED && c.destination === 'Autre Fournisseur') {
      alerts.push({ kind: 'endorse_incomplete', id: c.id });
    }
    const box = (p.cf_51a7f5 || '').trim();
    if (box) alerts.push({ kind: 'box', id: c.id, text: box });
    const fiscal = (p.cf_023de7 || '').trim();
    if (fiscal.startsWith('✖')) alerts.push({ kind: 'fiscal', id: c.id, text: fiscal.replace(/^✖\s*/, '') });
  }

  [rejected, agbInHand, rostomiaInHand, noDest, agbPending].forEach((l) => l.sort(oldestFirst));
  // لا يوجد تاريخ إيداع في القائمة، فنرتّب بآخر تعديل للدفعة كأقرب مؤشر
  agbRecent.sort((a, b) => (a.t < b.t ? 1 : a.t > b.t ? -1 : 0));
  all.sort((a, b) => (a.t < b.t ? 1 : a.t > b.t ? -1 : 0));

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
    all: all.map((x) => x.c),
    alerts,
  };
}

export async function getView(env: Env, refresh: boolean): Promise<ChequesView> {
  if (!refresh) {
    const cached = await cacheGet(env, CACHE_KEY);
    if (cached) return JSON.parse(cached) as ChequesView;
  }
  const today = todayAlgiers();
  const view = buildView(await fetchAllChequePayments(env), today);
  // تحصيل متأخر: مودع منذ أكثر من 7 أيام ولم يُحصَّل. لبنك AGB وحده بطلب ZEKRI،
  // لأن تحصيله يُسجَّل آلياً من رسائل البنك، أما الرستمية فلا تتحوّل إلى «محصّل».
  const deposited = view.all.filter((c) => c.status === STATUS.DEPOSITED);
  await fillDepositDates(env, deposited);
  for (const c of deposited) {
    if (!c.deposit_date) continue;
    c.deposit_days = Math.max(0, daysBetween(c.deposit_date, today));
    if (c.destination === DEST.AGB && c.deposit_days > COLLECT_LATE_DAYS) view.alerts.push({ kind: 'collect_late', id: c.id });
  }
  // الأقسام نسخ من all بعد التخزين، فنكمّل تاريخ الإيداع فيها أيضاً
  const byId = new Map(view.all.map((c) => [c.id, c]));
  for (const c of view.agb_pending_collection.items.concat(view.agb_recent.items)) {
    const same = byId.get(c.id);
    if (same) { c.deposit_date = same.deposit_date; c.deposit_days = same.deposit_days; }
  }
  await cachePut(env, CACHE_KEY, JSON.stringify(view), CACHE_TTL);
  return view;
}

export const chequesModule: AppModule = {
  id: 'cheques',
  title: 'الشيكات',
  roles: ['admin', 'rep'],
  async handle(req, env, user, subpath) {
    if (req.method === 'GET' && (subpath === '' || subpath === '/')) {
      const refresh = new URL(req.url).searchParams.get('refresh') === '1';
      const view = await getView(env, refresh);
      // الأقفال تُقرأ في كل طلب، لا من التخزين المؤقت
      const locks = await lockStates(env);
      const byId = new Map(view.all.map((c) => [c.id, c]));
      for (const c of [...view.agb_in_hand.items, ...view.all]) if (locks[c.id]) c.lock = locks[c.id];
      await reconcileDoneLocks(env, view.agb_in_hand.items);
      for (const c of view.agb_in_hand.items) {
        const same = byId.get(c.id);
        if (same) same.lock = c.lock;
      }
      for (const [id, state] of Object.entries(locks)) {
        if (state === 'unknown' && byId.has(id)) view.alerts.push({ kind: 'unknown_lock', id });
      }
      // العهدة للشيكات في الحوزة، وتنبيه لمن سُلّم إليه شيك ينتظر تأكيده
      const custody = await custodyMap(env, user);
      const inHand = [...view.agb_in_hand.items, ...view.rostomia_in_hand.items, ...view.no_destination.items, ...view.all];
      for (const c of inHand) {
        const k = c.status === STATUS.IN_HAND ? custody.get(c.id) : undefined;
        if (k) c.custody = k;
      }
      for (const c of view.all) {
        if (c.custody?.incoming) view.alerts.push({ kind: 'handover', id: c.id, text: c.custody.from || undefined });
      }
      const alerts = user.role === 'admin' ? view.alerts : view.alerts.filter((a) => !ADMIN_ONLY.includes(a.kind));
      return json({ ...view, alerts, role: user.role, can_deposit: canDeposit(env, user), can_register: canRegister(env, user) });
    }
    if (req.method === 'POST' && subpath === '/deposit') return handleDeposit(req, env, user);
    // العهدة: من يحمل الشيك. قاعدة التطبيق وحدها، لا زوهو
    if (req.method === 'GET' && subpath === '/custody/people') return custodyPeople(env, user);
    if (req.method === 'POST' && subpath === '/custody') {
      return handleCustody(req, env, user, async (pid) => (await getView(env, false)).all.some((c) => c.id === pid && c.status === STATUS.IN_HAND));
    }
    // تسجيل شيك جديد
    if (req.method === 'GET' && subpath === '/register/options') return registerOptions(env, user);
    if (req.method === 'GET' && subpath === '/register/vendors') {
      return searchVendors(env, user, new URL(req.url).searchParams.get('q') || '');
    }
    if (req.method === 'POST' && subpath === '/endorse') return handleEndorse(req, env, user);
    if (req.method === 'POST' && subpath === '/undo') return handleUndo(req, env, user);
    if (req.method === 'POST' && subpath === '/edit/preview') return handleEditPreview(req, env, user);
    if (req.method === 'POST' && subpath === '/edit') return handleEdit(req, env, user);
    if (req.method === 'POST' && subpath === '/endorse/preview') return handleBillsPreview(req, env, user);
    if (req.method === 'GET' && subpath === '/register/customers') {
      return searchCustomers(env, user, new URL(req.url).searchParams.get('q') || '');
    }
    if (req.method === 'POST' && subpath === '/register/read') return handleRead(req, env, user);
    if (req.method === 'POST' && subpath === '/register/orient') return handleOrient(req, env, user);
    if (req.method === 'POST' && subpath === '/register/preview') return handlePreview(req, env, user);
    if (req.method === 'POST' && subpath === '/register') return handleRegister(req, env, user);
    const img = subpath.match(/^\/image\/(\d{10,25})$/);
    if (req.method === 'GET' && img) return handleChequeImage(env, img[1]);
    const rot = subpath.match(/^\/image\/(\d{10,25})\/rotation$/);
    if (req.method === 'GET' && rot) return handleImageRotation(env, rot[1]);
    const det = subpath.match(/^\/detail\/(\d{10,25})$/);
    if (req.method === 'GET' && det) return handleChequeDetail(env, user, det[1]);
    throw new HttpError(404, 'غير موجود.');
  },
};
