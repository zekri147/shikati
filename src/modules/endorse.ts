import type { Env, User } from '../env';
import { HttpError, json, readJson } from '../http';
import { zohoGet, zohoRequest, ZohoTimeout } from '../zoho';
import { audit } from '../audit';
import { ACCOUNT_ENDORSED, CACHE_KEY, STATUS, todayAlgiers } from './constants';
import { searchContacts } from './register';

// التظهير لمورد: دفعة عميل في حساب الشيكات المظهّرة ← دفعة مورد من الحساب نفسه.
// ثالث مكان يكتب في زوهو، بموافقة ZEKRI يوم 2/11/2026. التوزيع آلياً على أقدم فواتير المورد.
// القواعد نفسها: قفل قبل أي طلب، ولا إعادة تلقائية بعد إرسال دفعة المورد.

const ID_RE = /^\d{10,25}$/;
const ENDORSED_DEST = 'Autre Fournisseur';
const VENDOR_STATUS = 'سُلّم للمورد';
const VENDOR_BANK = 'شيك مظهّر من عميل';

// التظهير لمورد للمدير وحده منذ 7/11/2026: دفع الموردين عمل محاسبي، لا عمل المندوب
export const canEndorse = (user: User) => user.role === 'admin';
function requireEndorse(user: User) {
  if (!canEndorse(user)) throw new HttpError(403, 'التظهير لمورد للمدير وحده.');
}

export async function searchVendors(env: Env, user: User, q: string): Promise<Response> {
  requireEndorse(user);
  return json({ vendors: await searchContacts(env, 'vendor', q) });
}

interface Bill { bill_id: string; bill_number: string; date: string; balance: number; vendor_id?: string }
export interface BillLine { bill_id: string; number: string; date: string; balance: number; applied: number }

export async function allocateBills(env: Env, vendorId: string, amount: number): Promise<{ lines: BillLine[]; unused: number }> {
  const data = await zohoGet<{ bills?: Bill[] }>(env, '/bills', {
    vendor_id: vendorId, filter_by: 'Status.Unpaid', sort_column: 'date', sort_order: 'A', per_page: 200,
  });
  let rest = Math.round(amount * 100);
  const lines: BillLine[] = [];
  for (const b of data.bills || []) {
    if (b.vendor_id && b.vendor_id !== vendorId) continue;
    const bal = Math.round((Number(b.balance) || 0) * 100);
    if (rest <= 0) break;
    if (bal <= 0) continue;
    const give = Math.min(bal, rest);
    lines.push({ bill_id: b.bill_id, number: b.bill_number, date: b.date, balance: bal / 100, applied: give / 100 });
    rest -= give;
  }
  return { lines, unused: rest / 100 };
}

interface CustomerPayment {
  payment_id: string;
  payment_number?: string;
  customer_name?: string;
  amount?: number;
  account_id?: string;
  location_id?: string;
  custom_field_hash?: Record<string, string>;
}

// هل يمكن إتمام تظهير هذه الدفعة؟ يعيد السبب إن لم يمكن
export function endorseBlocker(p: CustomerPayment): string | null {
  const cf = p.custom_field_hash || {};
  if (p.account_id !== ACCOUNT_ENDORSED) return 'الشيك ليس في حساب الشيكات المظهّرة.';
  if (String(cf.cf_d_pos_vers || '').trim() !== ENDORSED_DEST) return 'وجهة الشيك ليست «مورد آخر».';
  if (String(cf.cf_5d7197 || '').trim() !== STATUS.IN_HAND) return `حالة الشيك «${cf.cf_5d7197 || 'فارغة'}» وليست «${STATUS.IN_HAND}».`;
  return null;
}

export interface EndorseResult { state: 'done' | 'failed' | 'unknown'; message: string; vendor_payment_id?: string; warning?: string }

const LOCK_MESSAGES: Record<string, string> = {
  pending: 'تظهير هذا الشيك قيد التنفيذ الآن.',
  done: 'هذا الشيك ظُهّر من قبل من التطبيق.',
  unknown: 'محاولة سابقة لتظهير هذا الشيك لم تُعرف نتيجتها. تحقق في زوهو، ثم أخبر المدير.',
};

// تظهير دفعة عميل موجودة في حساب الشيكات المظهّرة. يُستدعى بعد التسجيل مباشرة، أو من صفحة الشيك.
export async function endorseCheque(
  env: Env, user: User, pid: string, vendorId: string, vendorName: string,
): Promise<EndorseResult> {
  // 1. القفل
  const lock = await env.DB.prepare(
    "INSERT INTO endorsements (payment_id, state, user_id, username, display_name, vendor_id, vendor) VALUES (?, 'pending', ?, ?, ?, ?, ?) " +
    "ON CONFLICT(payment_id) DO UPDATE SET state = 'pending', user_id = excluded.user_id, username = excluded.username, " +
    "display_name = excluded.display_name, vendor_id = excluded.vendor_id, vendor = excluded.vendor, started_at = datetime('now'), " +
    "finished_at = NULL, message = NULL, vendor_payment_id = NULL WHERE endorsements.state = 'failed'",
  ).bind(pid, user.id, user.username, user.display_name, vendorId, vendorName).run();
  if (!lock.meta.changes) {
    const row = await env.DB.prepare('SELECT state FROM endorsements WHERE payment_id = ?').bind(pid).first<{ state: string }>();
    await audit(env, user, 'endorse', 'denied', pid, `locked:${row?.state}`);
    return { state: 'failed', message: LOCK_MESSAGES[row?.state || 'pending'] || LOCK_MESSAGES.pending };
  }

  let chq = '';
  let amount = 0;
  const finish = async (state: EndorseResult['state'], message: string, vpid: string | null = null) => {
    await env.DB.prepare(
      "UPDATE endorsements SET state = ?, message = ?, vendor_payment_id = COALESCE(?, vendor_payment_id), cheque_number = ?, amount = ?, " +
      "finished_at = datetime('now') WHERE payment_id = ?",
    ).bind(state, message, vpid, chq || null, amount || null, pid).run();
    await env.DB.prepare('DELETE FROM cache WHERE key = ?').bind(CACHE_KEY).run();
    const result = state === 'done' ? 'ok' : state === 'failed' ? 'denied' : 'error';
    await audit(env, user, 'endorse', result, `${pid} / ${chq}`, `${state}: ${vendorName}: ${message}`);
  };
  const failed = async (message: string): Promise<EndorseResult> => {
    await finish('failed', message);
    return { state: 'failed', message };
  };

  // 2. قراءة دفعة العميل والتحقق منها، ثم توزيع المبلغ على فواتير المورد
  let p: CustomerPayment | undefined;
  let lines: BillLine[];
  let incomingId = '';
  try {
    const r = await zohoRequest<{ payment?: CustomerPayment }>(env, 'GET', `/customerpayments/${pid}`, { timeoutMs: 15_000 });
    p = r.data?.payment;
    if (!r.data || r.data.code !== 0 || !p) return failed('تعذّرت قراءة الشيك من زوهو. لم تُنشأ دفعة المورد.');
    const blocker = endorseBlocker(p);
    if (blocker) return failed(blocker);
    const cf = p.custom_field_hash || {};
    chq = String(cf.cf_n_cheque || '').trim();
    amount = Number(p.amount) || 0;
    // سجل «فاتورة الشيك» الوارد تُنشئه أتمتة زوهو بعد إنشاء الدفعة، فقد يتأخر ثانية
    incomingId = String(cf.cf_a1dfce_unformatted || '');
    if (!incomingId) {
      await new Promise((res) => setTimeout(res, 1500));
      const again = await zohoRequest<{ payment?: CustomerPayment }>(env, 'GET', `/customerpayments/${pid}`, { timeoutMs: 15_000 });
      incomingId = String(again.data?.payment?.custom_field_hash?.cf_a1dfce_unformatted || '');
    }
    lines = (await allocateBills(env, vendorId, amount)).lines;
  } catch (e) {
    if (e instanceof HttpError) return failed(e.publicMessage + ' لم تُنشأ دفعة المورد.');
    return failed('تعذّر الاتصال بزوهو. لم تُنشأ دفعة المورد.');
  }

  // 3. دفعة المورد. بعد هذا الطلب لا إعادة تلقائية أبداً.
  const customFields: { api_name: string; value: unknown }[] = [
    { api_name: 'cf_0370c8', value: VENDOR_BANK },
    { api_name: 'cf_5d7197', value: VENDOR_STATUS },
  ];
  if (/^\d+$/.test(chq)) customFields.push({ api_name: 'cf_n_cheque', value: Number(chq) });
  if (ID_RE.test(incomingId)) customFields.push({ api_name: 'cf_c3f811', value: incomingId });
  const body: Record<string, unknown> = {
    vendor_id: vendorId,
    payment_mode: 'Check',
    amount,
    date: todayAlgiers(),
    reference_number: chq,
    paid_through_account_id: ACCOUNT_ENDORSED,
    description: `تظهير شيك ${chq} — ${p.customer_name ?? ''} — من تطبيق ميداني (${user.display_name})`,
    bills: lines.map((l) => ({ bill_id: l.bill_id, amount_applied: l.applied })),
    custom_fields: customFields,
  };
  if (p.location_id) body.location_id = p.location_id;

  const NO_RETRY = 'لم يصل رد واضح من زوهو بعد إرسال دفعة المورد. لا تعد المحاولة: تحقق في زوهو، ثم أخبر المدير.';
  let created;
  try {
    created = await zohoRequest<{ vendorpayment?: { payment_id?: string } }>(env, 'POST', '/vendorpayments', { body, timeoutMs: 30_000 });
  } catch (e) {
    await finish('unknown', NO_RETRY);
    if (e instanceof ZohoTimeout) return { state: 'unknown', message: NO_RETRY };
    return { state: 'unknown', message: NO_RETRY };
  }
  if (!created.data) {
    await finish('unknown', NO_RETRY);
    return { state: 'unknown', message: NO_RETRY };
  }
  if (created.data.code !== 0) {
    return failed(`زوهو رفض دفعة المورد: ${String(created.data.message || created.data.code).slice(0, 200)}`);
  }
  const vpid = String(created.data.vendorpayment?.payment_id || '');
  if (!ID_RE.test(vpid)) {
    await finish('unknown', NO_RETRY);
    return { state: 'unknown', message: NO_RETRY };
  }

  // 4. حالة الشيك وسجله. فشلها لا يلغي التظهير.
  const cf = p.custom_field_hash || {};
  const logOld = String(cf.cf_fffaad || '').trim();
  const logLine = `${todayAlgiers()} — تظهير للمورد ${vendorName} من تطبيق ميداني (${user.display_name})`;
  let warning: string | undefined;
  try {
    const up = await zohoRequest(env, 'PUT', `/customerpayments/${pid}`, {
      body: { custom_fields: [
        { api_name: 'cf_5d7197', value: STATUS.ENDORSED },
        { api_name: 'cf_fffaad', value: logOld ? `${logOld}\n${logLine}` : logLine },
      ] },
    });
    if (!up.data || up.data.code !== 0) warning = 'أُنشئت دفعة المورد، لكن تعذّر تحديث حالة الشيك إلى «مظهّر لمورد».';
  } catch {
    warning = 'أُنشئت دفعة المورد، لكن لم يصل رد واضح عند تحديث حالة الشيك.';
  }
  await finish('done', warning || 'تم التظهير', vpid);
  return { state: 'done', message: 'تم التظهير', vendor_payment_id: vpid, warning };
}

// إتمام التظهير من صفحة الشيك
export async function handleEndorse(req: Request, env: Env, user: User): Promise<Response> {
  requireEndorse(user);
  const b = await readJson<{ payment_id?: string; vendor_id?: string; vendor?: string }>(req);
  const pid = String(b.payment_id || '');
  const vendorId = String(b.vendor_id || '');
  const vendor = String(b.vendor || '').trim().slice(0, 200);
  if (!ID_RE.test(pid)) throw new HttpError(400, 'معرّف الدفعة غير صالح.');
  if (!ID_RE.test(vendorId) || !vendor) throw new HttpError(400, 'اختر المورد.');
  const r = await endorseCheque(env, user, pid, vendorId, vendor);
  if (r.state === 'done') return json({ ok: true, vendor_payment_id: r.vendor_payment_id, warning: r.warning });
  throw new HttpError(r.state === 'unknown' ? 504 : 409, r.message);
}

export async function handleBillsPreview(req: Request, env: Env, user: User): Promise<Response> {
  requireEndorse(user);
  const b = await readJson<{ vendor_id?: string; amount?: number }>(req);
  const vendorId = String(b.vendor_id || '');
  const amount = Number(b.amount);
  if (!ID_RE.test(vendorId)) throw new HttpError(400, 'اختر المورد.');
  if (!Number.isFinite(amount) || amount <= 0) throw new HttpError(400, 'المبلغ غير صالح.');
  return json(await allocateBills(env, vendorId, amount));
}
