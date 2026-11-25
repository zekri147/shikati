import type { Env, User } from '../env';
import { HttpError, json, readJson } from '../http';
import { zohoGet, zohoRequest, zohoUpload } from '../zoho';
import { audit } from '../audit';
import { ACCOUNT_CHEQUES_IN_HAND, CACHE_KEY, DEST, LOCATIONS, STATUS, todayAlgiers } from './constants';
import { collectUnsettled } from './cashin';
import { DEPOSIT_DATE_FIELD } from './depositdate';
import { parseImage } from './ocr';
import { allocate, decodeBase64, requireRegister, type Allocation } from './register';

// التحويل البنكي من عميل: دفعة عميل بطريقة «تحويل بنكي» موزّعة على أقدم فواتيره.
// منذ 25/11/2026 (بطلب ZEKRI وموافقته): كما تُسجَّل التحويلات في زوهو منذ سبتمبر، وكما تفرض قاعدة التحقق
// («تحويل بنكي نحو ELONAC أو ROSTOMIA: يجب أن يُسجّل في Cheques in Hand»): الدفعة في حساب الشيكات في الحوزة،
// ثم إيداع فوري منه إلى البنك المختار مربوط بالدفعة، ثم الحالة «مودع في البنك». إن رفض زوهو الإيداع صراحةً
// تُحذف الدفعة التي أُنشئت للتو، فلا يبقى شيء. لا عهدة له، ولا يظهر في قوائم الشيكات (طريقته ليست «شيك»).
// قبل 25/11/2026 كان يدخل حساب البنك مباشرة، فيبقى التطبيق يتعرّف على ذلك الشكل أيضاً.
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
const BANK_LABELS = new Map(Object.values(TRANSFER_BANKS).map((b) => [b.account, b.label]));

// دفعة تحويل بنكي في أحد بنوك التحويل؟ يعيد اسم البنك، وإلا فارغاً.
// الشكل الحالي: في الحوزة ومودعة في أحد البنوك (من deposit_details في قراءة الدفعة الكاملة).
// والشكل القديم قبل 25/11/2026: في حساب البنك مباشرة.
export function transferBankLabel(p: {
  payment_mode?: string; account_id?: string; deposit_details?: { deposit_bank_id?: string }[];
}): string {
  if (str(p.payment_mode) !== MODE) return '';
  const acc = str(p.account_id);
  const direct = BANK_LABELS.get(acc);
  if (direct) return direct;
  if (acc !== ACCOUNT_CHEQUES_IN_HAND) return '';
  const deps = p.deposit_details || [];
  return deps.length === 1 ? BANK_LABELS.get(str(deps[0].deposit_bank_id)) || '' : '';
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
  payment_number?: string; currency_id?: string; txn_posting_date?: string; invoices?: { apply_date?: string }[];
  deposit_details?: { deposit_id?: string; deposit_bank_id?: string }[];
  custom_field_hash?: Record<string, string>;
}

const ID_OK = (v: unknown) => ID_RE.test(str(v));

// حذف دفعة العميل في زوهو: نعم أو لا أو «لا نعرف» (انقطع الرد). لا إعادة تلقائية
async function deletePayment(env: Env, pid: string): Promise<'ok' | 'no' | 'unknown'> {
  try {
    const d = await zohoRequest(env, 'DELETE', `/customerpayments/${pid}`, { timeoutMs: 30_000 });
    if (!d.data) return 'unknown';
    return d.data.code === 0 ? 'ok' : 'no';
  } catch {
    return 'unknown';
  }
}

async function deleteDeposit(env: Env, tid: string): Promise<'ok' | 'no' | 'unknown'> {
  try {
    const d = await zohoRequest(env, 'DELETE', `/banktransactions/${tid}`, { timeoutMs: 30_000 });
    if (!d.data) return 'unknown';
    return d.data.code === 0 ? 'ok' : 'no';
  } catch {
    return 'unknown';
  }
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
  // التحويل إلى هذا البنك: في حسابه مباشرة (الشكل القديم)، أو في الحوزة (الشكل الحالي، وبنكه لا يظهر في القائمة)
  let lines: Allocation[];
  try {
    const dup = await zohoGet<{ customerpayments?: ZPayment[] }>(env, '/customerpayments', {
      customer_id: customerId, filter_by: 'PaymentMode.BankTransfer', per_page: 200,
    });
    const near = (dup.customerpayments || []).filter((p) => [bank.account, ACCOUNT_CHEQUES_IN_HAND].includes(str(p.account_id)));
    if (reference && near.some((p) => normRef(p.reference_number) === reference)) {
      return fail(409, `تحويل بالمرجع ${reference} مسجّل من قبل لهذا العميل في زوهو.`);
    }
    // دون مرجع: التحويل بالمبلغ والتاريخ نفسيهما يُعدّ مكرراً. المرجع يميّز تحويلين متشابهين
    if (!reference && near.some((p) => str(p.date) === date && Math.abs((Number(p.amount) || 0) - amount) < 0.005)) {
      return fail(409, 'تحويل بهذا المبلغ وهذا التاريخ مسجّل من قبل لهذا العميل. إن كان تحويلاً آخر فاكتب رقم مرجعه.');
    }
    lines = (await allocate(env, customerId, amount)).lines;
  } catch (e) {
    if (e instanceof HttpError) {
      if (e.status === 409) throw e;
      return fail(e.status, e.publicMessage + ' لم يُسجَّل شيء.');
    }
    return fail(502, 'تعذّر الاتصال بزوهو. لم يُسجَّل شيء، ويمكنك المحاولة مجدداً.');
  }

  // 4. إنشاء الدفعة في الحوزة بحالة «في الحوزة»، حتى يُسجَّل إيداعها. بعد هذا الطلب لا إعادة تلقائية أبداً.
  const payment = {
    customer_id: customerId,
    payment_mode: MODE,
    amount,
    date,
    reference_number: reference || '',
    account_id: ACCOUNT_CHEQUES_IN_HAND,
    location_id: loc.id,
    description: `تحويل بنكي إلى ${bank.label}${reference ? ` (${reference})` : ''} — سجّله ${user.display_name} من تطبيق ميداني`,
    custom_fields: [
      { api_name: 'cf_n_cheque', value: NO_CHEQUE },
      { api_name: 'cf_d_pos_vers', value: bank.dest },
      { api_name: 'cf_5d7197', value: STATUS.IN_HAND },
    ],
    invoices: lines.map((l) => ({ invoice_id: l.invoice_id, amount_applied: l.applied })),
  };

  // المندوب لا يفتح زوهو، فرسالته تقول ماذا يفعل دون ذكره (نص index.ts العام يذكر رقم الشيك)
  const admin = user.role === 'admin';
  const NO_RETRY = admin
    ? 'لم يصل رد واضح من زوهو بعد إرسال التحويل. لا تعد المحاولة: تحقق من دفعات العميل في زوهو بعد دقيقة.'
    : 'لم يصل رد واضح، فلا نعرف هل سُجّل التحويل. لا تعد المحاولة: أخبر المدير باسم العميل والمبلغ.';
  const unknown = async (message: string, pid: string | null): Promise<never> => {
    await finish('unknown', message, pid);
    throw new HttpError(504, message);
  };
  let created;
  try {
    created = await zohoRequest<{ payment?: ZPayment }>(env, 'POST', '/customerpayments', { body: payment, timeoutMs: 30_000 });
  } catch {
    return unknown(NO_RETRY, null);
  }
  if (!created.data) return unknown(NO_RETRY, null);
  if (created.data.code !== 0) {
    // زوهو رفض الطلب برمز خطأ صريح (قاعدة تحقق مثلاً)، فلم تُنشأ أي دفعة
    return fail(502, `زوهو رفض التحويل: ${str(created.data.message || created.data.code).slice(0, 200)}`);
  }
  const made = created.data.payment;
  const pid = str(made?.payment_id);
  if (!ID_OK(pid)) return unknown(NO_RETRY, null);

  // 5. الإيداع من الحوزة إلى البنك المختار، مربوطاً بالدفعة، كما في deposit.ts.
  // تاريخه تاريخ التحويل، إلا إن كان قبل تاريخ ترحيل الدفعة أو تطبيقها على الفواتير، فزوهو يرفض ما قبلهما
  const posted = [str(made?.txn_posting_date), ...(made?.invoices || []).map((i) => str(i.apply_date))]
    .map((d) => d.slice(0, 10)).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d) && d <= today).sort().pop() || '';
  const depositDate = posted > date ? posted : date;
  const DEP_UNKNOWN = admin
    ? 'أُنشئ التحويل في الحوزة، ولم يصل رد واضح عند إيداعه في البنك. لا تعد المحاولة: تحقق في زوهو هل له إيداع، ثم احسمه من تبويب «التحقق».'
    : 'لم يصل رد واضح عند إيداع التحويل في البنك. لا تعد المحاولة: أخبر المدير باسم العميل والمبلغ.';
  // رفض صريح قبل أن يتم الإيداع: نحذف الدفعة التي أنشأناها للتو، فلا يبقى شيء في زوهو
  const rollback = async (why: string): Promise<never> => {
    const del = await deletePayment(env, pid);
    if (del === 'ok') return fail(502, `${why} فحُذفت الدفعة، ولم يُسجَّل شيء.`);
    return unknown(admin
      ? `${why} وتعذّر حذف الدفعة التي أُنشئت في الحوزة (${made?.payment_number || pid}). احذفها في زوهو، ثم احسم التحويل من تبويب «التحقق».`
      : `${why} وبقيت دفعة في زوهو. لا تعد المحاولة: أخبر المدير باسم العميل والمبلغ.`, pid);
  };
  const deposit: Record<string, unknown> = {
    transaction_type: 'deposit',
    to_account_id: bank.account,
    date: depositDate,
    currency_id: made?.currency_id,
    description: `إيداع تحويل بنكي إلى ${bank.label} — دفعة ${made?.payment_number ?? ''} — من تطبيق ميداني (${user.display_name})`,
    location_id: loc.id,
    line_items: [{
      from_account_id: ACCOUNT_CHEQUES_IN_HAND,
      amount,
      payment_mode: MODE,
      customer_id: customerId,
      transaction_id: pid,
      transaction_type: lines.length > 0 ? 'invoice_payment' : 'customer_payment',
    }],
  };
  if (reference) deposit.reference_number = reference;
  let dep;
  try {
    dep = await zohoRequest<{ banktransaction?: { transaction_id?: string } }>(env, 'POST', '/banktransactions', { body: deposit, timeoutMs: 30_000 });
  } catch {
    return unknown(DEP_UNKNOWN, pid);
  }
  if (!dep.data) return unknown(DEP_UNKNOWN, pid);
  if (dep.data.code !== 0) {
    return rollback(`زوهو رفض إيداع التحويل في ${bank.label}: ${str(dep.data.message || dep.data.code).slice(0, 200)}.`);
  }
  const tid = str(dep.data.banktransaction?.transaction_id);
  if (!ID_OK(tid)) return unknown(DEP_UNKNOWN, pid);

  // التحقق من أن الإيداع مربوط فعلاً بالدفعة، وإلا نحذفه ثم نحذف الدفعة
  let linked = false;
  try {
    const c = await zohoRequest<{ banktransaction?: { line_items?: { transaction_id?: string }[] } }>(env, 'GET', `/banktransactions/${tid}`);
    if (!c.data || c.data.code !== 0) return unknown(DEP_UNKNOWN, pid);
    linked = (c.data.banktransaction?.line_items || []).some((x) => str(x.transaction_id) === pid);
  } catch {
    return unknown(DEP_UNKNOWN, pid);
  }
  if (!linked) {
    const del = await deleteDeposit(env, tid);
    if (del !== 'ok') {
      return unknown(admin
        ? 'أُنشئ إيداع للتحويل غير مربوط بدفعته، وتعذّر حذفه. احذف الإيداع والدفعة في زوهو، ثم احسم التحويل من تبويب «التحقق».'
        : DEP_UNKNOWN, pid);
    }
    return rollback('لم يُربط الإيداع بالدفعة فأُلغي،');
  }

  // 6. الحالة «مودع في البنك» وتاريخ الإيداع وسطر في السجل. فشله لا يلغي التسجيل
  const logLine = `${today} — تسجيل تحويل بنكي وإيداعه في ${bank.label}${depositDate !== today ? ` بتاريخ ${depositDate}` : ''} من تطبيق ميداني (${user.display_name})`;
  let warning: string | null = null;
  try {
    const up = await zohoRequest(env, 'PUT', `/customerpayments/${pid}`, {
      body: {
        custom_fields: [
          { api_name: 'cf_5d7197', value: STATUS.DEPOSITED },
          { api_name: DEPOSIT_DATE_FIELD, value: depositDate },
          { api_name: 'cf_fffaad', value: logLine },
        ],
      },
    });
    if (!up.data || up.data.code !== 0) warning = `سُجّل التحويل وأُودع في ${bank.label}، لكن تعذّر تحديث حالته في زوهو إلى «${STATUS.DEPOSITED}».`;
  } catch {
    warning = `سُجّل التحويل وأُودع في ${bank.label}، لكن لم يصل رد واضح عند تحديث حالته إلى «${STATUS.DEPOSITED}».`;
  }
  if (warning) warning += admin ? ' حدّثها يدوياً في زوهو.' : ' أخبر المدير.';

  // 7. صورة إشعار التحويل مرفقاً على الدفعة. فشلها لا يلغي التسجيل.
  {
    let upWarn: string | null = null;
    try {
      const ext = image.type === 'image/png' ? 'png' : image.type === 'image/webp' ? 'webp' : 'jpg';
      const up = await zohoUpload(env, `/customerpayments/${pid}/attachment`, 'attachment', {
        name: `virement-${date}.${ext}`, type: image.type, bytes: decodeBase64(image.data),
      });
      if (!up.data || up.data.code !== 0) {
        console.error('transfer attachment failed', up.status, up.data?.code, up.data?.message);
        upWarn = 'تعذّر رفع صورة الإشعار إلى زوهو.';
      }
    } catch {
      upWarn = 'لم يصل رد واضح عند رفع صورة الإشعار.';
    }
    if (upWarn) warning = warning ? `${warning} و${upWarn}` : `سُجّل التحويل، لكن ${upWarn}`;
  }

  await finish('done', warning || 'تم التسجيل والإيداع', pid);
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

// ——— لصفحة التحويل: «احذف التحويل» في «المزيد» (بطلب ZEKRI يوم 25/11/2026، كالحذف والتراجع في صفحة الشيك) ———
// للتحويل الذي سجّله التطبيق، لصاحبه وللمدير. المنع الظاهر هنا للتحصيل وحده، والخادم يعيد كل الفحوص عند الحذف
export async function transferDeleteForDetail(env: Env, user: User, pid: string, status: string): Promise<{ allowed: boolean; blocker: string | null; effect: string } | null> {
  const row = await env.DB.prepare("SELECT user_id FROM transfers WHERE payment_id = ? AND state = 'done'").bind(pid).first<{ user_id: number | null }>();
  if (!row || (user.role !== 'admin' && row.user_id !== user.id)) return null;
  const effect = 'يُحذف إيداع التحويل ثم دفعته من زوهو، فتعود فواتير العميل غير مدفوعة.';
  let blocker: string | null = null;
  if (status === STATUS.COLLECTED) {
    blocker = user.role === 'admin' ? 'التحويل محصّل. تراجع عن تحصيله أولاً، ثم احذفه.' : 'التحويل محصّل، فلا يُحذف. أخبر المدير.';
  } else if (await collectUnsettled(env, pid)) {
    blocker = 'تحصيل هذا التحويل لم تُعرف نتيجته. يحسمه المدير من تبويب «التحقق» أولاً.';
  }
  return { allowed: !blocker, blocker, effect };
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
  // الشكل الحالي في الحوزة (مع إيداعه أو دونه إن انقطع التسجيل)، أو الشكل القديم في حساب البنك
  const acc = str(p.account_id);
  if (str(p.payment_mode) !== MODE || !(acc === ACCOUNT_CHEQUES_IN_HAND || BANK_LABELS.has(acc))) {
    return deny(409, 'تغيّرت هذه الدفعة في زوهو ولم تعد تحويلاً بنكياً. راجعها في زوهو.');
  }
  if ((p.payment_refunds || []).length > 0) return deny(409, 'للدفعة استرداد مسجّل في زوهو.');
  // التحويل المحصّل لا يُحذف حتى يُتراجع عن تحصيله من صفحته (اختيار ZEKRI يوم 24/11/2026)
  if (str(p.custom_field_hash?.cf_5d7197) === STATUS.COLLECTED) {
    return deny(409, user.role === 'admin'
      ? 'هذا التحويل محصّل. تراجع عن تحصيله أولاً من صفحته، ثم احذفه.'
      : 'هذا التحويل محصّل، فلا يُحذف. أخبر المدير.');
  }
  if (await collectUnsettled(env, pid)) return deny(409, 'تحصيل هذا التحويل لم تُعرف نتيجته. يحسمه المدير من تبويب «التحقق» أولاً.');

  // 2. الإيداع أولاً (الشكل الحالي): زوهو لا يحذف دفعة مودعة. يُفحص كما في التراجع عن إيداع الشيك
  const deps = acc === ACCOUNT_CHEQUES_IN_HAND ? (p.deposit_details || []) : [];
  if (deps.length > 1) return deny(409, 'لهذا التحويل أكثر من إيداع في زوهو. راجعه هناك.');
  if (deps.length === 1) {
    const tid = str(deps[0].deposit_id);
    if (!ID_OK(tid)) return deny(502, 'تعذّر تحديد إيداع التحويل في زوهو.');
    const t = await zohoRequest<{ banktransaction?: { line_items?: { transaction_id?: string }[]; imported_transactions?: unknown[]; status?: string } }>(
      env, 'GET', `/banktransactions/${tid}`, { timeoutMs: 15_000 },
    );
    const bt = t.data?.banktransaction;
    if (!t.data || t.data.code !== 0 || !bt) return deny(502, 'تعذّرت قراءة إيداع التحويل من زوهو.');
    const ls = bt.line_items || [];
    if (ls.length !== 1 || str(ls[0].transaction_id) !== pid) return deny(409, 'إيداع هذا التحويل يضم دفعات أخرى. راجعه في زوهو.');
    if ((bt.imported_transactions || []).length > 0 || ['matched', 'reconciled'].includes(str(bt.status))) {
      return deny(409, 'إيداع هذا التحويل مطابَق مع كشف البنك، فلا يُحذف من التطبيق.');
    }
    const del = await deleteDeposit(env, tid);
    if (del === 'unknown') {
      await audit(env, user, 'undo.transfer', 'error', target, `deposit ${tid}: ${UNDO_NO_RETRY}`);
      throw new HttpError(504, UNDO_NO_RETRY);
    }
    if (del === 'no') return deny(502, 'زوهو رفض حذف إيداع التحويل، فلم يُحذف شيء. راجعه في زوهو.');
    await audit(env, user, 'undo.transfer', 'ok', target, `deposit ${tid} deleted`);
  }

  // 3. حذف الدفعة. لا إعادة تلقائية بعد الطلب
  const del = await deletePayment(env, pid);
  if (del !== 'ok') {
    const msg = del === 'unknown' ? UNDO_NO_RETRY : 'زوهو رفض حذف دفعة التحويل.';
    const after = deps.length ? (user.role === 'admin'
      ? ' حُذف إيداعه، فالدفعة الآن في الحوزة دون إيداع. احذفها في زوهو أو أعد المحاولة بعد التحقق.'
      : ' حُذف إيداعه وبقيت دفعته. أخبر المدير.') : '';
    await audit(env, user, 'undo.transfer', del === 'unknown' ? 'error' : 'denied', target, msg + after);
    await env.DB.prepare('DELETE FROM cache WHERE key = ?').bind(CACHE_KEY).run();
    throw new HttpError(del === 'unknown' ? 504 : 502, msg + after);
  }
  await markDeleted(`حُذف التحويل (${user.display_name})`);
  await env.DB.prepare('DELETE FROM cache WHERE key = ?').bind(CACHE_KEY).run();
  await audit(env, user, 'undo.transfer', 'ok', target, `${row.customer || ''}: ${Number(p.amount) || 0}`);
  return json({ ok: true, message: `حُذف تحويل ${row.customer || ''} من زوهو، فعادت فواتيره غير مدفوعة.` });
}
