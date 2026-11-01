import type { Env, Role, User } from '../env';
import { HttpError, json, readJson } from '../http';
import { zohoRequest, ZohoTimeout } from '../zoho';
import { audit } from '../audit';
import { ACCOUNT_CHEQUES_IN_HAND, CACHE_KEY, DEST, STATUS, todayAlgiers } from './constants';

// تسجيل إيداع شيك في بنك AGB، بنفس طريقة دالة deposer_agb في زوهو.
// كل خطوة بعد إرسال طلب الإيداع لا تُعاد تلقائياً أبداً.

export const ACCOUNT_AGB = '7418406000000261404';
const STALE_PENDING_SEC = 300;
const PAYMENT_ID_RE = /^\d{10,25}$/;

export type DepositState = 'pending' | 'done' | 'failed' | 'unknown';

export function depositRoles(env: Env): Role[] {
  return String(env.DEPOSIT_ROLES || 'admin')
    .split(',')
    .map((r) => r.trim())
    .filter((r): r is Role => r === 'admin' || r === 'depositor');
}

export function canDeposit(env: Env, user: User): boolean {
  return depositRoles(env).includes(user.role);
}

interface ZohoPayment {
  payment_id: string;
  payment_number?: string;
  customer_id: string;
  customer_name: string;
  amount: number;
  account_id: string;
  payment_mode?: string;
  currency_id?: string;
  location_id?: string;
  invoices?: unknown[];
  deposit_details?: unknown[];
  custom_field_hash?: Record<string, string>;
}

interface LockRow {
  state: DepositState;
  started_at: string;
  stale: number;
}

// حالات الأقفال الحالية لعرضها في القائمة: الشيك المقفل لا يظهر له زر
export async function lockStates(env: Env): Promise<Record<string, DepositState>> {
  const { results } = await env.DB.prepare(
    "SELECT payment_id, state, (state = 'pending' AND started_at < datetime('now', ?)) AS stale " +
    "FROM deposits WHERE state != 'failed'",
  ).bind(`-${STALE_PENDING_SEC} seconds`).all<{ payment_id: string; state: DepositState; stale: number }>();
  const out: Record<string, DepositState> = {};
  for (const r of results) out[r.payment_id] = r.stale ? 'unknown' : r.state;
  return out;
}

// شيك مقفل بحالة «تم» لكنه عاد إلى قسم «في الحوزة»: إما أن الإيداع أُلغي في زوهو،
// وإما أن تحديث الحالة فشل بعد الإيداع. نقرأ الدفعة لنفرّق بينهما.
// إن لم يكن لها أي إيداع وحالتها «في الحوزة»، نحرّر القفل فيعود الزر.
// هذا آمن: محاولة الإيداع الجديدة تعيد كل الفحوص في زوهو قبل أي كتابة.
export async function reconcileDoneLocks(env: Env, items: { id: string; lock?: string }[]): Promise<void> {
  const candidates = items.filter((c) => c.lock === 'done').slice(0, 10);
  for (const c of candidates) {
    try {
      const r = await zohoRequest<{ payment?: ZohoPayment }>(env, 'GET', `/customerpayments/${c.id}`, { timeoutMs: 10_000 });
      const p = r.data?.payment;
      if (!r.data || r.data.code !== 0 || !p) continue;
      const hasDeposit = Array.isArray(p.deposit_details) && p.deposit_details.length > 0;
      const status = String(p.custom_field_hash?.cf_5d7197 || '').trim();
      if (hasDeposit || status !== STATUS.IN_HAND) continue;
      const res = await env.DB.prepare(
        "UPDATE deposits SET state = 'failed', message = ?, finished_at = datetime('now') WHERE payment_id = ? AND state = 'done'",
      ).bind('أُلغي الإيداع في زوهو بعد تسجيله، فأصبح الشيك قابلاً للإيداع من جديد', c.id).run();
      if (res.meta.changes) {
        delete c.lock;
        await audit(env, null, 'deposit.reverted', 'ok', c.id, 'no deposit in Zoho');
      }
    } catch {
      // عند أي خطأ يبقى القفل كما هو
    }
  }
}

const LOCKED_MESSAGES: Record<DepositState, string> = {
  pending: 'إيداع هذا الشيك قيد التنفيذ الآن. انتظر قليلاً ثم حدّث الصفحة.',
  done: 'سُجّل إيداع هذا الشيك من قبل في التطبيق.',
  unknown: 'محاولة سابقة لإيداع هذا الشيك لم تُعرف نتيجتها. تحقق في زوهو، ثم اطلب من المدير تحريره.',
  failed: '',
};

export async function handleDeposit(req: Request, env: Env, user: User): Promise<Response> {
  if (!canDeposit(env, user)) throw new HttpError(403, 'ليست لديك صلاحية تسجيل الإيداع.');

  const body = await readJson<{ payment_id?: string; amount?: number; cheque_number?: string }>(req);
  const pid = String(body.payment_id || '');
  if (!PAYMENT_ID_RE.test(pid)) throw new HttpError(400, 'معرّف الدفعة غير صالح.');

  // 1. القفل: إدخال ذرّي، لا ينجح إلا إن لم يوجد سطر، أو كان السطر السابق «فشل»
  const lock = await env.DB.prepare(
    "INSERT INTO deposits (payment_id, state, user_id, username, display_name) VALUES (?, 'pending', ?, ?, ?) " +
    "ON CONFLICT(payment_id) DO UPDATE SET state = 'pending', user_id = excluded.user_id, " +
    "username = excluded.username, display_name = excluded.display_name, started_at = datetime('now'), " +
    "finished_at = NULL, message = NULL, bank_txn_id = NULL WHERE deposits.state = 'failed'",
  ).bind(pid, user.id, user.username, user.display_name).run();

  if (!lock.meta.changes) {
    const row = await env.DB.prepare(
      "SELECT state, started_at, (state = 'pending' AND started_at < datetime('now', ?)) AS stale FROM deposits WHERE payment_id = ?",
    ).bind(`-${STALE_PENDING_SEC} seconds`, pid).first<LockRow>();
    const state: DepositState = row?.stale ? 'unknown' : (row?.state ?? 'pending');
    await audit(env, user, 'deposit', 'denied', pid, `locked:${state}`);
    throw new HttpError(409, LOCKED_MESSAGES[state]);
  }

  let info: { customer?: string; cheque?: string; amount?: number } = {};
  const finish = async (state: DepositState, message: string, bankTxnId: string | null = null) => {
    await env.DB.prepare(
      "UPDATE deposits SET state = ?, message = ?, bank_txn_id = COALESCE(?, bank_txn_id), customer = ?, " +
      "cheque_number = ?, amount = ?, finished_at = datetime('now') WHERE payment_id = ?",
    ).bind(state, message, bankTxnId, info.customer ?? null, info.cheque ?? null, info.amount ?? null, pid).run();
    await env.DB.prepare('DELETE FROM cache WHERE key = ?').bind(CACHE_KEY).run();
    const result = state === 'done' ? 'ok' : state === 'failed' ? 'denied' : 'error';
    await audit(env, user, 'deposit', result, `${pid} / ${info.cheque ?? ''}`, `${state}: ${message}`);
  };
  const fail = async (status: number, message: string): Promise<never> => {
    await finish('failed', message);
    throw new HttpError(status, message);
  };
  const unknown = async (message: string, bankTxnId: string | null = null): Promise<never> => {
    await finish('unknown', message, bankTxnId);
    throw new HttpError(504, message);
  };

  // 2. قراءة الدفعة من زوهو، والتحقق من أنها قابلة للإيداع
  let pr;
  try {
    pr = await zohoRequest<{ payment?: ZohoPayment }>(env, 'GET', `/customerpayments/${pid}`);
  } catch (e) {
    if (e instanceof ZohoTimeout) return fail(504, 'زوهو لم يرد. لم يُسجَّل أي إيداع، ويمكنك المحاولة مجدداً.');
    await finish('failed', 'خطأ قبل الإيداع');
    throw e;
  }
  const p = pr.data?.payment;
  if (!pr.data || pr.data.code !== 0 || !p) return fail(502, 'تعذّرت قراءة الدفعة من زوهو. لم يُسجَّل أي إيداع.');

  const cfh = p.custom_field_hash || {};
  const status = String(cfh.cf_5d7197 || '').trim();
  const dest = String(cfh.cf_d_pos_vers || '').trim();
  let chq = String(cfh.cf_n_cheque || '').trim();
  if (chq === '0000000') chq = '';
  info = { customer: p.customer_name, cheque: chq, amount: Number(p.amount) };

  if (Array.isArray(p.deposit_details) && p.deposit_details.length > 0) {
    return fail(409, 'هذا الشيك له إيداع مسجّل في زوهو من قبل.');
  }
  if (status === STATUS.COLLECTED || status === STATUS.REJECTED) {
    return fail(409, `حالة الشيك «${status}»، لا يمكن إيداعه.`);
  }
  if (status !== STATUS.IN_HAND) return fail(409, `حالة الشيك «${status || 'فارغة'}» وليست «${STATUS.IN_HAND}».`);
  if (p.account_id !== ACCOUNT_CHEQUES_IN_HAND || dest !== DEST.AGB) {
    return fail(409, 'الشيك ليس في الحوزة نحو بنك AGB.');
  }
  // ما رآه المستخدم في بطاقة التأكيد يجب أن يطابق زوهو الآن
  const shownAmount = Number(body.amount);
  const shownCheque = String(body.cheque_number ?? '').trim();
  if (!Number.isFinite(shownAmount) || Math.abs(shownAmount - Number(p.amount)) > 0.005 || shownCheque !== chq) {
    return fail(409, 'بيانات الشيك تغيّرت في زوهو. حدّث الصفحة وتحقق منها قبل الإيداع.');
  }

  // 3. إنشاء الإيداع مرتبطاً بالدفعة
  const today = todayAlgiers();
  const lineType = Array.isArray(p.invoices) && p.invoices.length > 0 ? 'invoice_payment' : 'customer_payment';
  const deposit: Record<string, unknown> = {
    transaction_type: 'deposit',
    to_account_id: ACCOUNT_AGB,
    date: today,
    currency_id: p.currency_id,
    description: `إيداع شيك ${chq} في AGB — دفعة ${p.payment_number ?? ''} — من تطبيق شيكاتي (${user.display_name})`,
    line_items: [{
      from_account_id: ACCOUNT_CHEQUES_IN_HAND,
      amount: p.amount,
      payment_mode: p.payment_mode || 'Check',
      customer_id: p.customer_id,
      transaction_id: pid,
      transaction_type: lineType,
    }],
  };
  if (chq) deposit.reference_number = chq;
  if (p.location_id) deposit.location_id = p.location_id;

  const NO_RETRY = 'لم يصل رد واضح من زوهو بعد محاولة الإيداع. لا تعد المحاولة: حدّث الصفحة بعد دقيقة وتحقق في زوهو، ثم أخبر المدير.';
  let created;
  try {
    created = await zohoRequest<{ banktransaction?: { transaction_id?: string } }>(env, 'POST', '/banktransactions', {
      body: deposit,
      timeoutMs: 30_000,
    });
  } catch (e) {
    if (e instanceof ZohoTimeout) return unknown(NO_RETRY);
    await finish('unknown', NO_RETRY);
    throw e;
  }
  if (!created.data) return unknown(NO_RETRY);
  if (created.data.code !== 0) {
    // زوهو رفض الطلب برمز خطأ صريح، فلم يُنشأ أي إيداع
    return fail(502, `زوهو رفض الإيداع: ${String(created.data.message || created.data.code).slice(0, 200)}`);
  }
  const tid = String(created.data.banktransaction?.transaction_id || '');
  if (!tid) return unknown(NO_RETRY);

  // 4. التحقق من أن الإيداع مرتبط فعلاً بالدفعة، وإلا نحذفه
  let check;
  try {
    check = await zohoRequest<{ banktransaction?: { line_items?: { transaction_id?: string }[] } }>(
      env, 'GET', `/banktransactions/${tid}`,
    );
  } catch {
    return unknown('أُنشئ الإيداع لكن تعذّر التحقق من ربطه بالدفعة. تحقق منه في زوهو، ثم أخبر المدير.', tid);
  }
  if (!check.data || check.data.code !== 0) {
    return unknown('أُنشئ الإيداع لكن تعذّر التحقق من ربطه بالدفعة. تحقق منه في زوهو، ثم أخبر المدير.', tid);
  }
  const linked = (check.data.banktransaction?.line_items || []).some((x) => String(x.transaction_id || '') === pid);
  if (!linked) {
    let deleted = false;
    try {
      const del = await zohoRequest(env, 'DELETE', `/banktransactions/${tid}`);
      deleted = !!del.data && del.data.code === 0;
    } catch { /* نعالجه أدناه */ }
    if (deleted) return fail(502, 'لم يُربط الإيداع بالدفعة فأُلغي. لم يتغيّر شيء في زوهو.');
    return unknown('لم يُربط الإيداع بالدفعة، وتعذّر حذفه. يجب حذفه يدوياً في زوهو. أخبر المدير.', tid);
  }

  // 5. تحديث حالة الشيك وإضافة سطر في سجل الدفعة باسم الموظف
  const logOld = String(cfh.cf_fffaad || '').trim();
  const logLine = `${today} — إيداع في AGB من تطبيق شيكاتي (${user.display_name})`;
  let updated = false;
  try {
    const up = await zohoRequest(env, 'PUT', `/customerpayments/${pid}`, {
      body: {
        custom_fields: [
          { api_name: 'cf_5d7197', value: STATUS.DEPOSITED },
          { api_name: 'cf_fffaad', value: logOld ? `${logOld}\n${logLine}` : logLine },
        ],
      },
    });
    updated = !!up.data && up.data.code === 0;
  } catch { /* نعالجه أدناه */ }

  if (!updated) {
    const warning = 'تم الإيداع وربطه بالدفعة، لكن تعذّر تحديث حالة الشيك في زوهو. حدّثها يدوياً إلى «مودع في البنك».';
    await finish('done', warning, tid);
    return json({ ok: true, warning });
  }

  await finish('done', 'تم الإيداع وتحديث الحالة', tid);
  return json({ ok: true, message: 'تم تسجيل الإيداع في بنك AGB.' });
}

// للمدير: قائمة الإيداعات، وتحرير قفل نتيجته غير معروفة بعد التحقق في زوهو
export async function listDeposits(env: Env): Promise<Response> {
  const { results } = await env.DB.prepare(
    "SELECT payment_id, state, display_name, customer, cheque_number, amount, bank_txn_id, message, started_at, finished_at, " +
    "(state = 'pending' AND started_at < datetime('now', ?)) AS stale FROM deposits ORDER BY started_at DESC LIMIT 100",
  ).bind(`-${STALE_PENDING_SEC} seconds`).all();
  return json({ deposits: results });
}

export async function releaseDeposit(env: Env, admin: User, pid: string): Promise<Response> {
  if (!PAYMENT_ID_RE.test(pid)) throw new HttpError(400, 'معرّف الدفعة غير صالح.');
  const res = await env.DB.prepare(
    "DELETE FROM deposits WHERE payment_id = ? AND (state = 'unknown' OR (state = 'pending' AND started_at < datetime('now', ?)))",
  ).bind(pid, `-${STALE_PENDING_SEC} seconds`).run();
  if (!res.meta.changes) throw new HttpError(409, 'لا يمكن تحرير هذا الإيداع: ليس في حالة «غير معروفة».');
  await env.DB.prepare('DELETE FROM cache WHERE key = ?').bind(CACHE_KEY).run();
  await audit(env, admin, 'deposit.release', 'ok', pid);
  return json({ ok: true });
}
