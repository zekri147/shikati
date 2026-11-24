import type { Env, User } from '../env';
import { HttpError, json, readJson } from '../http';
import { zohoGet, zohoRequest, zohoUpload, ZohoTimeout } from '../zoho';
import { audit } from '../audit';
import { CACHE_KEY, DEST, LOCATIONS, STATUS, todayAlgiers } from './constants';
import { collectUnsettled } from './cashin';
import { parseImage } from './ocr';
import { allocate, decodeBase64, requireRegister, type Allocation } from './register';

// التحويل البنكي من عميل: دفعة عميل بطريقة «تحويل بنكي» في حساب البنك مباشرة، موزّعة على أقدم فواتيره.
// لا يدخل حساب الشيكات في الحوزة، فلا عهدة ولا إيداع، ولا يظهر في قوائم الشيكات.
// منذ 24/11/2026 (بطلب ZEKRI): يُنشأ بحالة «مودع في البنك»، ويحصّله المدير يدوياً كالشيك (cashin.ts)
// من قسم «بانتظار التحصيل»، والحذف ممنوع بعد التحصيل حتى يُتراجع عنه. وصورة الإشعار إجبارية.
// بموافقة ZEKRI يوم 21/11/2026: كل مندوب يسجّل التحويل، ويتراجع عن تحويله هو (حذف الدفعة في زوهو)، والمدير عن أي تحويل.
// القواعد نفسها: قفل في القاعدة قبل أي طلب، ولا إعادة تلقائية بعد إرسال طلب الإنشاء أو الحذف.

const ID_RE = /^\d{10,25}$/;
const REQUEST_RE = /^[a-zA-Z0-9-]{16,64}$/;
const MODE = 'Bank Transfer';
// قواعد التحقق في زوهو تطلب رقم شيك من 7 أرقام. كل التحويلات المسجلة في زوهو تحمل هذا الرقم
const NO_CHEQUE = '0000000';

// البنوك التي تستقبل التحويلات (اختيار ZEKRI): حسابها في زوهو، والوجهة في «Déposé vers».
// الحقل لا خيار فيه لبنك CPA، وهو حساب للشركة مثل AGB، فوجهته ELONAC.
export const TRANSFER_BANKS: Record<string, { account: string; dest: string; label: string }> = {
  AGB: { account: '7418406000000261404', dest: DEST.AGB, label: 'بنك AGB' },
  ROSTOMIA: { account: '7418406000000903878', dest: DEST.ROSTOMIA, label: 'الرستمية' },
  CPA: { account: '7418406000000261410', dest: DEST.AGB, label: 'بنك CPA' },
};
const BANK_ACCOUNTS = new Set(Object.values(TRANSFER_BANKS).map((b) => b.account));

// دفعة تحويل بنكي في أحد بنوك التحويل؟ يعيد اسم البنك، وإلا فارغاً
export function transferBankLabel(p: { payment_mode?: string; account_id?: string }): string {
  if (str(p.payment_mode) !== MODE) return '';
  const acc = str(p.account_id);
  return Object.values(TRANSFER_BANKS).find((b) => b.account === acc)?.label || '';
}

export const transferBankOptions = () => Object.entries(TRANSFER_BANKS).map(([key, b]) => ({ key, label: b.label }));

const str = (v: unknown) => String(v ?? '').trim();
const normRef = (v: unknown) => str(v).toUpperCase().replace(/\s+/g, ' ');

interface TransferBody {
  request_id?: string;
  customer_id?: string;
  customer?: string;
  amount?: number;
  bank?: string;
  reference?: string;
  location?: string;
  image?: string;
  date?: string;
}

const LOCK_MESSAGES: Record<string, string> = {
  pending: 'تسجيل هذا التحويل قيد التنفيذ الآن. انتظر قليلاً ثم افتح «تحويلات سجّلتها».',
  done: 'تحويل بهذا المرجع إلى هذا البنك مسجّل من قبل لنفس العميل.',
  unknown: 'محاولة سابقة لتسجيل هذا التحويل لم تُعرف نتيجتها. لا تعد المحاولة، وأخبر المدير ليتحقق.',
};

interface ZPayment {
  payment_id: string; amount?: number; date?: string; account_id?: string; reference_number?: string; payment_mode?: string;
  custom_field_hash?: Record<string, string>;
}

export async function handleTransfer(req: Request, env: Env, user: User): Promise<Response> {
  requireRegister(env, user);
  const b = await readJson<TransferBody>(req);

  // 1. التحقق من المدخلات
  const requestId = str(b.request_id);
  const customerId = str(b.customer_id);
  const customer = str(b.customer).slice(0, 200);
  const amount = Math.round(Number(b.amount) * 100) / 100;
  const bankKey = str(b.bank);
  const bank = TRANSFER_BANKS[bankKey];
  const reference = normRef(b.reference).slice(0, 50) || null;
  const loc = LOCATIONS[str(b.location)];
  if (!REQUEST_RE.test(requestId)) throw new HttpError(400, 'طلب غير صالح. أعد فتح الشاشة.');
  if (!ID_RE.test(customerId)) throw new HttpError(400, 'اختر العميل.');
  if (!Number.isFinite(amount) || amount <= 0 || amount > 1e9) throw new HttpError(400, 'المبلغ غير صالح.');
  if (!bank) throw new HttpError(400, 'اختر البنك الذي استلم التحويل.');
  if (!loc) throw new HttpError(400, 'اختر الموقع.');
  if (!b.image) throw new HttpError(400, 'صوّر إشعار التحويل: الصورة إجبارية.');
  const image = parseImage(b.image);
  const today = todayAlgiers();
  const date = str(b.date) || today;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || date > today) throw new HttpError(400, 'تاريخ التحويل غير صالح: لا يكون بعد اليوم.');

  // 2. القفل: إدخال ذرّي قبل أي طلب إلى زوهو
  try {
    await env.DB.prepare(
      'INSERT INTO transfers (request_id, state, user_id, username, display_name, customer_id, customer, bank, reference, amount, date) ' +
      "VALUES (?, 'pending', ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ).bind(requestId, user.id, user.username, user.display_name, customerId, customer, bankKey, reference, amount, date).run();
  } catch {
    const same = await env.DB.prepare('SELECT state, payment_id FROM transfers WHERE request_id = ?')
      .bind(requestId).first<{ state: string; payment_id: string | null }>();
    if (same?.state === 'done') return json({ ok: true, payment_id: same.payment_id, repeated: true });
    const other = reference ? await env.DB.prepare(
      "SELECT state FROM transfers WHERE customer_id = ? AND bank = ? AND reference = ? AND state IN ('pending', 'done', 'unknown')",
    ).bind(customerId, bankKey, reference).first<{ state: string }>() : null;
    const state = same?.state || other?.state || 'pending';
    await audit(env, user, 'transfer', 'denied', `${customerId} / ${bankKey} ${reference || ''}`, `locked:${state}`);
    throw new HttpError(409, LOCK_MESSAGES[state] || LOCK_MESSAGES.pending);
  }

  const finish = async (state: 'done' | 'failed' | 'unknown', message: string, pid: string | null = null) => {
    await env.DB.prepare(
      "UPDATE transfers SET state = ?, message = ?, payment_id = COALESCE(?, payment_id), finished_at = datetime('now') WHERE request_id = ?",
    ).bind(state, message, pid, requestId).run();
    if (state !== 'failed') await env.DB.prepare('DELETE FROM cache WHERE key = ?').bind(CACHE_KEY).run();
    const result = state === 'done' ? 'ok' : state === 'failed' ? 'denied' : 'error';
    await audit(env, user, 'transfer', result, `${pid || customerId} / ${bankKey} ${amount}`, `${state}: ${customer}: ${message}`);
  };
  const fail = async (status: number, message: string): Promise<never> => {
    await finish('failed', message);
    throw new HttpError(status, message);
  };

  // 3. هل التحويل مسجّل في زوهو من قبل (من خارج التطبيق)؟ ثم التوزيع على الفواتير
  let lines: Allocation[];
  try {
    const dup = await zohoGet<{ customerpayments?: ZPayment[] }>(env, '/customerpayments', {
      customer_id: customerId, filter_by: 'PaymentMode.BankTransfer', per_page: 200,
    });
    const inBank = (dup.customerpayments || []).filter((p) => str(p.account_id) === bank.account);
    if (reference && inBank.some((p) => normRef(p.reference_number) === reference)) {
      return fail(409, `تحويل بالمرجع ${reference} إلى ${bank.label} مسجّل من قبل لهذا العميل في زوهو.`);
    }
    // دون مرجع: التحويل بالمبلغ والتاريخ والبنك نفسها يُعدّ مكرراً. المرجع يميّز تحويلين متشابهين
    if (!reference && inBank.some((p) => str(p.date) === date && Math.abs((Number(p.amount) || 0) - amount) < 0.005)) {
      return fail(409, `تحويل بهذا المبلغ وهذا التاريخ إلى ${bank.label} مسجّل من قبل لهذا العميل. إن كان تحويلاً آخر فاكتب رقم مرجعه.`);
    }
    lines = (await allocate(env, customerId, amount)).lines;
  } catch (e) {
    if (e instanceof HttpError) {
      if (e.status === 409) throw e;
      return fail(e.status, e.publicMessage + ' لم يُسجَّل شيء.');
    }
    return fail(502, 'تعذّر الاتصال بزوهو. لم يُسجَّل شيء، ويمكنك المحاولة مجدداً.');
  }

  // 4. إنشاء الدفعة. بعد هذا الطلب لا إعادة تلقائية أبداً.
  const logLine = `${today} — تسجيل تحويل بنكي إلى ${bank.label}${date !== today ? ` (وصل ${date})` : ''} من تطبيق ميداني (${user.display_name})`;
  const payment = {
    customer_id: customerId,
    payment_mode: MODE,
    amount,
    date,
    reference_number: reference || '',
    account_id: bank.account,
    location_id: loc.id,
    description: `تحويل بنكي إلى ${bank.label}${reference ? ` (${reference})` : ''} — سجّله ${user.display_name} من تطبيق ميداني`,
    custom_fields: [
      { api_name: 'cf_n_cheque', value: NO_CHEQUE },
      { api_name: 'cf_d_pos_vers', value: bank.dest },
      { api_name: 'cf_5d7197', value: STATUS.DEPOSITED },
      { api_name: 'cf_fffaad', value: logLine },
    ],
    invoices: lines.map((l) => ({ invoice_id: l.invoice_id, amount_applied: l.applied })),
  };

  // المندوب لا يفتح زوهو، فرسالته تقول ماذا يفعل دون ذكره (نص index.ts العام يذكر رقم الشيك)
  const NO_RETRY = user.role === 'admin'
    ? 'لم يصل رد واضح من زوهو بعد إرسال التحويل. لا تعد المحاولة: تحقق من دفعات العميل في زوهو بعد دقيقة.'
    : 'لم يصل رد واضح، فلا نعرف هل سُجّل التحويل. لا تعد المحاولة: أخبر المدير باسم العميل والمبلغ.';
  let created;
  try {
    created = await zohoRequest<{ payment?: { payment_id?: string } }>(env, 'POST', '/customerpayments', { body: payment, timeoutMs: 30_000 });
  } catch (e) {
    await finish('unknown', NO_RETRY);
    if (e instanceof ZohoTimeout) throw new HttpError(504, NO_RETRY);
    throw new HttpError(504, NO_RETRY);
  }
  if (!created.data) {
    await finish('unknown', NO_RETRY);
    throw new HttpError(504, NO_RETRY);
  }
  if (created.data.code !== 0) {
    // زوهو رفض الطلب برمز خطأ صريح (قاعدة تحقق مثلاً)، فلم تُنشأ أي دفعة
    return fail(502, `زوهو رفض التحويل: ${str(created.data.message || created.data.code).slice(0, 200)}`);
  }
  const pid = str(created.data.payment?.payment_id);
  if (!ID_RE.test(pid)) {
    await finish('unknown', NO_RETRY);
    throw new HttpError(504, NO_RETRY);
  }

  // 5. صورة إشعار التحويل مرفقاً على الدفعة. فشلها لا يلغي التسجيل.
  let warning: string | null = null;
  {
    try {
      const ext = image.type === 'image/png' ? 'png' : image.type === 'image/webp' ? 'webp' : 'jpg';
      const up = await zohoUpload(env, `/customerpayments/${pid}/attachment`, 'attachment', {
        name: `virement-${date}.${ext}`, type: image.type, bytes: decodeBase64(image.data),
      });
      if (!up.data || up.data.code !== 0) {
        console.error('transfer attachment failed', up.status, up.data?.code, up.data?.message);
        warning = 'سُجّل التحويل، لكن تعذّر رفع صورة الإشعار إلى زوهو.';
      }
    } catch {
      warning = 'سُجّل التحويل، لكن لم يصل رد واضح عند رفع صورة الإشعار.';
    }
  }

  await finish('done', warning || 'تم التسجيل', pid);
  return json({ ok: true, payment_id: pid, warning, allocated: lines.length });
}

// ——— تحويلات سجّلتها: آخر 30 يوماً من قاعدة التطبيق، للمندوب تحويلاته وللمدير الكل ———

interface Row {
  request_id: string; state: string; user_id: number | null; display_name: string | null; customer: string | null;
  bank: string; reference: string | null; amount: number; date: string; payment_id: string | null; message: string | null;
  collected: string | null;
}

export async function listTransfers(env: Env, user: User): Promise<Response> {
  requireRegister(env, user);
  const admin = user.role === 'admin';
  // التحصيل من جدول التحصيل اليدوي: «تم» ما لم يُتراجع عنه. الحالة الأكيدة في زوهو، والحذف يقرؤها قبل التنفيذ
  const sql = 'SELECT t.request_id, t.state, t.user_id, t.display_name, t.customer, t.bank, t.reference, t.amount, t.date, t.payment_id, t.message, ' +
    'c.state AS collected FROM transfers t LEFT JOIN collections c ON c.payment_id = t.payment_id ' +
    "WHERE t.state IN ('done', 'unknown') AND t.started_at >= datetime('now', '-30 days')" + (admin ? '' : ' AND t.user_id = ?') +
    ' ORDER BY t.started_at DESC LIMIT 30';
  const stmt = admin ? env.DB.prepare(sql) : env.DB.prepare(sql).bind(user.id);
  const rows = (await stmt.all<Row>()).results || [];
  return json({
    transfers: rows.map((r) => ({
      id: r.request_id, payment_id: r.payment_id, state: r.state, customer: r.customer, amount: r.amount, date: r.date,
      bank: TRANSFER_BANKS[r.bank]?.label || r.bank, reference: r.reference,
      by: admin && r.user_id !== user.id ? r.display_name : null,
      collected: r.collected === 'done',
      can_undo: r.state === 'done' && !!r.payment_id && (admin || r.user_id === user.id) && r.collected !== 'done',
    })),
  });
}

// ——— التراجع: حذف دفعة التحويل في زوهو ———


export async function handleTransferUndo(req: Request, env: Env, user: User): Promise<Response> {
  requireRegister(env, user);
  const b = await readJson<{ payment_id?: string }>(req);
  const pid = str(b.payment_id);
  if (!ID_RE.test(pid)) throw new HttpError(400, 'معرّف الدفعة غير صالح.');
  const target = `${pid} / transfer`;
  const UNDO_NO_RETRY = user.role === 'admin'
    ? 'لم يصل رد واضح من زوهو بعد طلب الحذف. لا تعد المحاولة: تحقق من دفعات العميل في زوهو بعد دقيقة.'
    : 'لم يصل رد واضح، فلا نعرف هل حُذف التحويل. لا تعد المحاولة: أخبر المدير باسم العميل والمبلغ.';
  const deny = async (status: number, message: string): Promise<never> => {
    await audit(env, user, 'undo.transfer', 'denied', target, message);
    throw new HttpError(status, message);
  };

  // المندوب يتراجع عن تحويله هو فقط، والمدير عن أي تحويل سجّله التطبيق
  const row = await env.DB.prepare("SELECT user_id, customer FROM transfers WHERE payment_id = ? AND state = 'done'")
    .bind(pid).first<{ user_id: number | null; customer: string | null }>();
  if (!row) return deny(404, 'هذا التحويل غير مسجّل من التطبيق، أو حُذف من قبل.');
  if (user.role !== 'admin' && row.user_id !== user.id) {
    return deny(403, 'يتراجع المندوب عن التحويلات التي سجّلها هو فقط. اطلب ذلك من المدير.');
  }
  const markDeleted = (message: string) => env.DB.prepare(
    "UPDATE transfers SET state = 'deleted', message = ?, finished_at = datetime('now') WHERE payment_id = ? AND state = 'done'",
  ).bind(message, pid).run();

  // 1. قراءة الدفعة من جديد، والتأكد أنها تحويل في أحد البنوك، دون استرداد
  const r = await zohoRequest<{ payment?: ZPayment & { payment_refunds?: unknown[] } }>(env, 'GET', `/customerpayments/${pid}`, { timeoutMs: 15_000 });
  if (r.status === 404 || r.data?.code === 1002) {
    await markDeleted('حُذفت دفعته من زوهو مباشرة.');
    return json({ ok: true, message: 'هذا التحويل محذوف من زوهو من قبل، فأُزيل من القائمة.' });
  }
  const p = r.data?.payment;
  if (!r.data || r.data.code !== 0 || !p) return deny(502, 'تعذّرت قراءة التحويل من زوهو.');
  if (str(p.payment_mode) !== MODE || !BANK_ACCOUNTS.has(str(p.account_id))) {
    return deny(409, 'تغيّرت هذه الدفعة في زوهو ولم تعد تحويلاً إلى أحد البنوك. راجعها في زوهو.');
  }
  if ((p.payment_refunds || []).length > 0) return deny(409, 'للدفعة استرداد مسجّل في زوهو.');
  // التحويل المحصّل لا يُحذف حتى يُتراجع عن تحصيله من صفحته (اختيار ZEKRI يوم 24/11/2026)
  if (str(p.custom_field_hash?.cf_5d7197) === STATUS.COLLECTED) {
    return deny(409, user.role === 'admin'
      ? 'هذا التحويل محصّل. تراجع عن تحصيله أولاً من صفحته، ثم احذفه.'
      : 'هذا التحويل محصّل، فلا يُحذف. أخبر المدير.');
  }
  if (await collectUnsettled(env, pid)) return deny(409, 'تحصيل هذا التحويل لم تُعرف نتيجته. يحسمه المدير من تبويب «التحقق» أولاً.');

  // 2. الحذف. لا إعادة تلقائية بعد الطلب
  let d;
  try {
    d = await zohoRequest(env, 'DELETE', `/customerpayments/${pid}`, { timeoutMs: 30_000 });
  } catch {
    await audit(env, user, 'undo.transfer', 'error', target, UNDO_NO_RETRY);
    throw new HttpError(504, UNDO_NO_RETRY);
  }
  if (!d.data) {
    await audit(env, user, 'undo.transfer', 'error', target, UNDO_NO_RETRY);
    throw new HttpError(504, UNDO_NO_RETRY);
  }
  if (d.data.code !== 0) return deny(502, `زوهو رفض الحذف: ${str(d.data.message || d.data.code).slice(0, 200)}`);
  await markDeleted(`حُذف التحويل (${user.display_name})`);
  await env.DB.prepare('DELETE FROM cache WHERE key = ?').bind(CACHE_KEY).run();
  await audit(env, user, 'undo.transfer', 'ok', target, `${row.customer || ''}: ${Number(p.amount) || 0}`);
  return json({ ok: true, message: `حُذف تحويل ${row.customer || ''} من زوهو، فعادت فواتيره غير مدفوعة.` });
}
