import type { Env, User } from '../env';
import { HttpError, json, readJson } from '../http';
import { zohoRequest, ZohoTimeout } from '../zoho';
import { audit } from '../audit';
import { DEPOSIT_DATE_FIELD } from './depositdate';
import { bankCollectedDate, showDate } from './banksms';
import { ACCOUNT_CHEQUES_IN_HAND, ACCOUNT_ENDORSED, CACHE_KEY, STATUS, todayAlgiers } from './constants';

// التراجع عن آخر عملية على الشيك، بموافقة ZEKRI يوم 2/11/2026:
//   الإيداع  ← حذف المعاملة البنكية، والحالة تعود «في الحوزة»
//   التظهير  ← حذف دفعة المورد، والحالة تعود «في الحوزة»
//   التسجيل  ← حذف دفعة العميل
// يشمل ما أُنشئ قبل التطبيق. المدير يتراجع عن أي عملية، والمودِع عن عملياته هو فقط.
// التراجع يكون من آخر عملية إلى أولها، ويُفحص كل شيء في زوهو قبل الحذف.
// لا إعادة تلقائية بعد طلب الحذف: إن انقطع الرد يُطلب التحقق.

const ID_RE = /^\d{10,25}$/;

export type UndoKind = 'deposit' | 'endorse' | 'register';

interface Payment {
  payment_id: string;
  payment_number?: string;
  customer_name?: string;
  amount?: number;
  date?: string;
  account_id?: string;
  deposit_details?: { deposit_id?: string; account_name?: string }[];
  payment_refunds?: unknown[];
  custom_field_hash?: Record<string, string>;
}

interface VendorPayment {
  payment_id: string;
  vendor_name?: string;
  payment_number?: string;
  amount?: number;
  paid_through_account_id?: string;
  reference_number?: string;
  cf_n_cheque?: string;
  cf_c3f811_unformatted?: string;
}

export interface UndoPlan {
  kind: UndoKind;
  title: string;
  // ما سيحدث بالضبط، يُعرض في نافذة التأكيد
  effect: string;
  // سبب المنع إن وُجد، وإلا فالتراجع ممكن
  blocker: string | null;
  txn_id?: string;
  vendor_payment_id?: string;
}

const str = (v: unknown) => String(v ?? '').trim();
const digits = (v: unknown) => str(v).replace(/\D/g, '').replace(/^0+/, '');

async function readPayment(env: Env, pid: string): Promise<Payment | null> {
  const r = await zohoRequest<{ payment?: Payment }>(env, 'GET', `/customerpayments/${pid}`, { timeoutMs: 15_000 });
  if (r.status === 404 || r.data?.code === 1002) return null;
  if (!r.data || r.data.code !== 0 || !r.data.payment) throw new HttpError(502, 'تعذّرت قراءة الشيك من زوهو.');
  return r.data.payment;
}

// دفعة المورد التي سُلّم بها هذا الشيك: من حساب الشيكات المظهّرة، بالمبلغ نفسه،
// ومربوطة بسجل الشيك الوارد أو تحمل رقمه. تعمل أيضاً للتظهير القديم قبل التطبيق.
export async function findVendorPayment(env: Env, p: Payment): Promise<VendorPayment | null> {
  const r = await zohoRequest<{ vendorpayments?: VendorPayment[] }>(env, 'GET', '/vendorpayments', {
    params: { amount: Number(p.amount) || 0, per_page: 50 },
    timeoutMs: 15_000,
  });
  if (!r.data || r.data.code !== 0) throw new HttpError(502, 'تعذّر البحث عن دفعة المورد في زوهو.');
  const cf = p.custom_field_hash || {};
  const incoming = str(cf.cf_a1dfce_unformatted);
  const chq = digits(cf.cf_n_cheque);
  const hits = (r.data.vendorpayments || []).filter((v) => {
    if (str(v.paid_through_account_id) !== ACCOUNT_ENDORSED) return false;
    if (Math.abs((Number(v.amount) || 0) - (Number(p.amount) || 0)) > 0.005) return false;
    if (incoming && str(v.cf_c3f811_unformatted) === incoming) return true;
    return !!chq && (digits(v.cf_n_cheque) === chq || digits(v.reference_number) === chq);
  });
  if (hits.length > 1) throw new HttpError(409, 'وُجدت أكثر من دفعة مورد لهذا الشيك. راجعها في زوهو.');
  return hits[0] || null;
}

// ما الذي يمكن التراجع عنه الآن؟ آخر عملية فقط.
export async function undoPlan(env: Env, p: Payment): Promise<UndoPlan | null> {
  const cf = p.custom_field_hash || {};
  const status = str(cf.cf_5d7197);
  const deposits = p.deposit_details || [];

  // 1. الإيداع
  if (deposits.length > 0) {
    const plan: UndoPlan = {
      kind: 'deposit', title: 'التراجع عن الإيداع',
      effect: `يُحذف الإيداع في «${str(deposits[0].account_name) || 'البنك'}» من زوهو، وتعود حالة الشيك «${STATUS.IN_HAND}».`,
      blocker: null,
    };
    if (status === STATUS.COLLECTED) return { ...plan, blocker: 'الشيك محصّل، فلا يمكن التراجع عن إيداعه.' };
    // الحالة قد تعود «مودع في البنك» بعد التحصيل بتعديل في زوهو، وسطر رسالة البنك يبقى في السجل
    const collected = bankCollectedDate(cf.cf_fffaad);
    if (collected) {
      return { ...plan, blocker: `البنك أكّد تحصيل هذا الشيك برسالة يوم ${showDate(collected)}، فلا يمكن التراجع عن إيداعه.` };
    }
    if (status !== STATUS.DEPOSITED) return { ...plan, blocker: `حالة الشيك «${status || 'فارغة'}» وليست «${STATUS.DEPOSITED}».` };
    if (deposits.length > 1) return { ...plan, blocker: 'للشيك أكثر من إيداع في زوهو. راجعه هناك.' };
    if (p.account_id !== ACCOUNT_CHEQUES_IN_HAND) return { ...plan, blocker: 'الشيك ليس في حساب الشيكات في الحوزة.' };
    const tid = str(deposits[0].deposit_id);
    if (!ID_RE.test(tid)) return { ...plan, blocker: 'تعذّر تحديد الإيداع في زوهو.' };
    const r = await zohoRequest<{ banktransaction?: { line_items?: { transaction_id?: string }[]; imported_transactions?: unknown[]; status?: string } }>(
      env, 'GET', `/banktransactions/${tid}`, { timeoutMs: 15_000 },
    );
    const t = r.data?.banktransaction;
    if (!r.data || r.data.code !== 0 || !t) return { ...plan, blocker: 'تعذّرت قراءة الإيداع من زوهو.' };
    const lines = t.line_items || [];
    if (lines.length !== 1 || str(lines[0].transaction_id) !== p.payment_id) {
      return { ...plan, blocker: 'هذا الإيداع يضم شيكات أخرى، فحذفه يلغي إيداعها أيضاً. راجعه في زوهو.' };
    }
    if ((t.imported_transactions || []).length > 0 || ['matched', 'reconciled'].includes(str(t.status))) {
      return { ...plan, blocker: 'الإيداع مطابَق مع كشف البنك، فلا يمكن حذفه من التطبيق.' };
    }
    return { ...plan, txn_id: tid };
  }

  // 2. التظهير
  const inEndorsed = p.account_id === ACCOUNT_ENDORSED;
  if (inEndorsed && (status === STATUS.ENDORSED || status === STATUS.IN_HAND)) {
    const vp = await findVendorPayment(env, p);
    if (vp) {
      return {
        kind: 'endorse', title: 'التراجع عن التظهير',
        effect: `تُحذف دفعة المورد ${str(vp.vendor_name)} (${str(vp.payment_number)}) من زوهو، فتعود فواتيره غير مدفوعة، وتعود حالة الشيك «${STATUS.IN_HAND}».`,
        blocker: null, vendor_payment_id: vp.payment_id,
      };
    }
    if (status === STATUS.ENDORSED) {
      return { kind: 'endorse', title: 'التراجع عن التظهير', effect: '', blocker: 'لم تُعرف دفعة المورد لهذا الشيك. راجعها في زوهو.' };
    }
  }

  // 3. التسجيل
  const plan: UndoPlan = {
    kind: 'register', title: 'حذف تسجيل الشيك',
    effect: 'تُحذف دفعة العميل من زوهو، فتعود فواتيره غير مدفوعة، ويختفي الشيك من التطبيق.',
    blocker: null,
  };
  // الشيك المرفوض أو المعاد أو شيك الضمان: مراحل لم يدخلها التطبيق بعد
  if (status !== STATUS.IN_HAND) return null;
  if ((p.payment_refunds || []).length > 0) return { ...plan, blocker: 'للدفعة استرداد مسجّل في زوهو.' };
  return plan;
}

// من أنجز العملية في التطبيق؟ المودِع يتراجع عن عملياته هو فقط
async function performer(env: Env, kind: UndoKind, pid: string): Promise<number | null> {
  const sql = {
    deposit: "SELECT user_id FROM deposits WHERE payment_id = ? AND state IN ('done', 'unknown')",
    endorse: "SELECT user_id FROM endorsements WHERE payment_id = ? AND state IN ('done', 'unknown')",
    register: "SELECT user_id FROM registrations WHERE payment_id = ? AND state = 'done'",
  }[kind];
  const row = await env.DB.prepare(sql).bind(pid).first<{ user_id: number | null }>();
  return row?.user_id ?? null;
}

export async function canUndo(env: Env, user: User, kind: UndoKind, pid: string): Promise<boolean> {
  if (user.role === 'admin') return true;
  return (await performer(env, kind, pid)) === user.id;
}

const NOT_YOURS = 'يتراجع المودِع عن العمليات التي أنجزها هو من التطبيق فقط. اطلب ذلك من المدير.';

// لصفحة التفاصيل: خيار التراجع المتاح لهذا المستخدم، أو لا شيء
export async function undoForDetail(env: Env, user: User, p: Payment): Promise<(UndoPlan & { allowed: boolean }) | null> {
  let plan: UndoPlan | null;
  try {
    plan = await undoPlan(env, p);
  } catch {
    return null;
  }
  if (!plan) return null;
  const mine = await canUndo(env, user, plan.kind, p.payment_id);
  if (!mine) {
    // المودِع لا يرى زر تراجع لعملية غيره
    return null;
  }
  return { kind: plan.kind, title: plan.title, effect: plan.effect, blocker: plan.blocker, allowed: !plan.blocker };
}

function logLine(user: User, text: string): string {
  return `${todayAlgiers()} — ${text} من تطبيق شيكاتي (${user.display_name})`;
}

async function setStatus(env: Env, p: Payment, user: User, text: string, clearDepositDate = false): Promise<boolean> {
  const old = str(p.custom_field_hash?.cf_fffaad);
  const line = logLine(user, text);
  const put = (clear: boolean) => zohoRequest(env, 'PUT', `/customerpayments/${p.payment_id}`, {
    body: { custom_fields: [
      { api_name: 'cf_5d7197', value: STATUS.IN_HAND },
      { api_name: 'cf_fffaad', value: old ? `${old}\n${line}` : line },
      ...(clear ? [{ api_name: DEPOSIT_DATE_FIELD, value: '' }] : []),
    ] },
  });
  try {
    const up = await put(clearDepositDate);
    if (up.data && up.data.code === 0) return true;
    // رفض صريح (لم يُنفَّذ شيء): إن كان السبب تفريغ تاريخ الإيداع، نعيد الحالة دونه
    if (clearDepositDate && up.data && up.data.code !== 0) {
      const again = await put(false);
      return !!again.data && again.data.code === 0;
    }
    return false;
  } catch {
    return false;
  }
}

const NO_RETRY = 'لم يصل رد واضح من زوهو بعد طلب الحذف. لا تعد المحاولة: حدّث الصفحة بعد دقيقة وتحقق، ثم أخبر المدير.';

async function del(env: Env, path: string): Promise<{ ok: boolean; message: string }> {
  let r;
  try {
    r = await zohoRequest(env, 'DELETE', path, { timeoutMs: 30_000 });
  } catch (e) {
    if (e instanceof ZohoTimeout) throw new HttpError(504, NO_RETRY);
    throw e;
  }
  if (!r.data) throw new HttpError(504, NO_RETRY);
  if (r.data.code !== 0) return { ok: false, message: `زوهو رفض الحذف: ${str(r.data.message || r.data.code).slice(0, 200)}` };
  return { ok: true, message: '' };
}

export async function handleUndo(req: Request, env: Env, user: User): Promise<Response> {
  const b = await readJson<{ payment_id?: string; kind?: string }>(req);
  const pid = str(b.payment_id);
  const kind = str(b.kind) as UndoKind;
  if (!ID_RE.test(pid)) throw new HttpError(400, 'معرّف الدفعة غير صالح.');
  if (!['deposit', 'endorse', 'register'].includes(kind)) throw new HttpError(400, 'نوع التراجع غير صالح.');

  const target = `${pid} / ${kind}`;
  const deny = async (status: number, message: string): Promise<never> => {
    await audit(env, user, `undo.${kind}`, 'denied', target, message);
    throw new HttpError(status, message);
  };

  if (!(await canUndo(env, user, kind, pid))) return deny(403, NOT_YOURS);

  // 1. قراءة الشيك من جديد، والتأكد أن آخر عملية هي التي طلب المستخدم التراجع عنها
  const p = await readPayment(env, pid);
  if (!p) return deny(404, 'هذا الشيك غير موجود في زوهو، ربما حُذف من قبل.');
  const plan = await undoPlan(env, p);
  if (!plan || plan.kind !== kind) return deny(409, 'تغيّرت حالة الشيك. حدّث الصفحة.');
  if (plan.blocker) return deny(409, plan.blocker);
  const chq = str(p.custom_field_hash?.cf_n_cheque);

  const done = async (message: string, warning?: string) => {
    await env.DB.prepare('DELETE FROM cache WHERE key = ?').bind(CACHE_KEY).run();
    await audit(env, user, `undo.${kind}`, 'ok', target, `${chq}: ${warning || message}`);
    return json({ ok: true, message, warning });
  };

  // 2. الحذف، ثم إرجاع الحالة
  if (kind === 'deposit') {
    const r = await del(env, `/banktransactions/${plan.txn_id}`).catch(async (e) => {
      await audit(env, user, 'undo.deposit', 'error', target, String(e.message));
      throw e;
    });
    if (!r.ok) return deny(502, r.message);
    await env.DB.prepare(
      "UPDATE deposits SET state = 'failed', message = ?, finished_at = datetime('now') WHERE payment_id = ?",
    ).bind(`تراجع عن الإيداع (${user.display_name})`, pid).run();
    const ok = await setStatus(env, p, user, 'تراجع عن الإيداع', true);
    await env.DB.prepare('DELETE FROM deposit_dates WHERE payment_id = ?').bind(pid).run();
    return done('حُذف الإيداع، وعاد الشيك «في الحوزة».',
      ok ? undefined : 'حُذف الإيداع، لكن تعذّر إرجاع حالة الشيك إلى «في الحوزة». حدّثها في زوهو.');
  }

  if (kind === 'endorse') {
    const r = await del(env, `/vendorpayments/${plan.vendor_payment_id}`).catch(async (e) => {
      await audit(env, user, 'undo.endorse', 'error', target, String(e.message));
      throw e;
    });
    if (!r.ok) return deny(502, r.message);
    await env.DB.prepare(
      "UPDATE endorsements SET state = 'failed', message = ?, finished_at = datetime('now') WHERE payment_id = ?",
    ).bind(`تراجع عن التظهير (${user.display_name})`, pid).run();
    const status = str(p.custom_field_hash?.cf_5d7197);
    const ok = status === STATUS.IN_HAND ? true : await setStatus(env, p, user, 'تراجع عن التظهير');
    return done('حُذفت دفعة المورد، وعاد الشيك «في الحوزة».',
      ok ? undefined : 'حُذفت دفعة المورد، لكن تعذّر إرجاع حالة الشيك إلى «في الحوزة». حدّثها في زوهو.');
  }

  const r = await del(env, `/customerpayments/${pid}`).catch(async (e) => {
    await audit(env, user, 'undo.register', 'error', target, String(e.message));
    throw e;
  });
  if (!r.ok) return deny(502, r.message);
  // يحرّر الفهرس الفريد، فيمكن تسجيل الشيك نفسه من جديد
  await env.DB.prepare(
    "UPDATE registrations SET state = 'failed', message = ?, finished_at = datetime('now') WHERE payment_id = ?",
  ).bind(`حُذف التسجيل (${user.display_name})`, pid).run();
  return done(`حُذف تسجيل شيك ${p.customer_name || ''} من زوهو.`);
}
