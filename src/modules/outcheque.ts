import type { Env, User } from '../env';
import { HttpError, json, readJson } from '../http';
import { zohoGet, zohoRequest, zohoUpload } from '../zoho';
import { audit } from '../audit';
import { LOCATIONS, todayAlgiers } from './constants';
import { parseImage } from './ocr';
import { allocateBills, canEndorse, type BillLine } from './endorse';
import { decodeBase64 } from './register';

// شيك الشركة الصادر لمورد: دفعة مورد بطريقة «شيك» من حساب البنك، موزّعة على أقدم فواتير المورد.
// للمدير وحده، من شاشة التسجيل. بطلب ZEKRI وموافقته يوم 8/11/2026، وليس تظهيراً لشيك عميل.
// القواعد نفسها: قفل في القاعدة قبل أي طلب، ولا إعادة تلقائية بعد إرسال طلب الإنشاء.

const ID_RE = /^\d{10,25}$/;
const REQUEST_RE = /^[a-zA-Z0-9-]{16,64}$/;
const CHEQUE_RE = /^\d{7}$/;
const VENDOR_STATUS = 'سُلّم للمورد';

// البنوك التي تُسحب منها شيكات الشركة: الحساب في زوهو، وقيمة حقل «البنك المسحوب عليه» (cf_0370c8)
export const OUT_BANKS: Record<string, { account: string; field: string; label: string }> = {
  AGB: { account: '7418406000000261404', field: 'Bank – AGB', label: 'بنك AGB' },
  CPA: { account: '7418406000000261410', field: 'Bank – CPA', label: 'بنك CPA' },
  ROSTOMIA: { account: '7418406000000903878', field: 'Bank Ammar Rostomia (AGB)', label: 'الرستمية' },
};

export const outBankOptions = () => Object.entries(OUT_BANKS).map(([key, b]) => ({ key, label: b.label }));

interface OutBody {
  request_id?: string;
  vendor_id?: string;
  vendor?: string;
  amount?: number;
  cheque_number?: string;
  bank?: string;
  location?: string;
  image?: string;
  date?: string;
}

const LOCK_MESSAGES: Record<string, string> = {
  pending: 'تسجيل هذا الشيك قيد التنفيذ الآن. انتظر قليلاً ثم تحقق في زوهو.',
  done: 'شيك بهذا الرقم من هذا البنك مسجّل من قبل من التطبيق.',
  unknown: 'محاولة سابقة لتسجيل هذا الشيك لم تُعرف نتيجتها. تحقق من دفعات الموردين في زوهو قبل أي محاولة.',
};

interface VendorPayment { payment_id: string; paid_through_account_id?: string; cf_n_cheque?: string | number; reference_number?: string }

export async function handleOutCheque(req: Request, env: Env, user: User): Promise<Response> {
  if (!canEndorse(user)) throw new HttpError(403, 'تسجيل شيكات الشركة للموردين للمدير وحده.');
  const b = await readJson<OutBody>(req);

  // 1. التحقق من المدخلات
  const requestId = String(b.request_id || '');
  const vendorId = String(b.vendor_id || '');
  const vendor = String(b.vendor || '').trim().slice(0, 200);
  const amount = Math.round(Number(b.amount) * 100) / 100;
  const chq = String(b.cheque_number || '').trim();
  const bankKey = String(b.bank || '');
  const bank = OUT_BANKS[bankKey];
  const loc = LOCATIONS[String(b.location || '')];
  if (!REQUEST_RE.test(requestId)) throw new HttpError(400, 'طلب غير صالح. أعد فتح الشاشة.');
  if (!ID_RE.test(vendorId) || !vendor) throw new HttpError(400, 'اختر المورد.');
  if (!Number.isFinite(amount) || amount <= 0 || amount > 1e9) throw new HttpError(400, 'المبلغ غير صالح.');
  if (!CHEQUE_RE.test(chq) || chq === '0000000') throw new HttpError(400, 'رقم الشيك يجب أن يكون 7 أرقام.');
  if (!bank) throw new HttpError(400, 'اختر البنك.');
  if (!loc) throw new HttpError(400, 'اختر الموقع.');
  const image = b.image ? parseImage(b.image) : null;
  const today = todayAlgiers();
  const date = String(b.date || today).trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || date > today) throw new HttpError(400, 'تاريخ التسليم غير صالح: لا يكون بعد اليوم.');

  // 2. القفل: إدخال ذرّي قبل أي طلب إلى زوهو
  try {
    await env.DB.prepare(
      'INSERT INTO out_cheques (request_id, state, user_id, username, display_name, vendor_id, vendor, bank, cheque_number, amount) ' +
      "VALUES (?, 'pending', ?, ?, ?, ?, ?, ?, ?, ?)",
    ).bind(requestId, user.id, user.username, user.display_name, vendorId, vendor, bankKey, chq, amount).run();
  } catch {
    const same = await env.DB.prepare('SELECT state, vendor_payment_id FROM out_cheques WHERE request_id = ?')
      .bind(requestId).first<{ state: string; vendor_payment_id: string | null }>();
    if (same?.state === 'done') return json({ ok: true, vendor_payment_id: same.vendor_payment_id, repeated: true });
    const other = await env.DB.prepare("SELECT state FROM out_cheques WHERE bank = ? AND cheque_number = ? AND state != 'failed'")
      .bind(bankKey, chq).first<{ state: string }>();
    const state = same?.state || other?.state || 'pending';
    await audit(env, user, 'outcheque', 'denied', `${bankKey} / ${chq}`, `locked:${state}`);
    throw new HttpError(409, LOCK_MESSAGES[state] || LOCK_MESSAGES.pending);
  }

  const finish = async (state: 'done' | 'failed' | 'unknown', message: string, vpid: string | null = null) => {
    await env.DB.prepare(
      "UPDATE out_cheques SET state = ?, message = ?, vendor_payment_id = COALESCE(?, vendor_payment_id), finished_at = datetime('now') WHERE request_id = ?",
    ).bind(state, message, vpid, requestId).run();
    const result = state === 'done' ? 'ok' : state === 'failed' ? 'denied' : 'error';
    await audit(env, user, 'outcheque', result, `${vpid || vendorId} / ${bankKey} ${chq}`, `${state}: ${vendor}: ${message}`);
  };
  const fail = async (status: number, message: string): Promise<never> => {
    await finish('failed', message);
    throw new HttpError(status, message);
  };

  // 3. هل الشيك مسجّل في زوهو من قبل لهذا المورد (من خارج التطبيق)؟ ثم التوزيع على الفواتير
  let lines: BillLine[];
  try {
    const dup = await zohoGet<{ vendorpayments?: VendorPayment[] }>(env, '/vendorpayments', {
      vendor_id: vendorId, filter_by: 'PaymentMode.Check', per_page: 200,
    });
    const same = (dup.vendorpayments || []).some((p) => p.paid_through_account_id === bank.account
      && (String(p.cf_n_cheque ?? '').trim() === String(Number(chq)) || String(p.reference_number || '').trim() === chq));
    if (same) return fail(409, `شيك ${chq} من ${bank.label} مسجّل من قبل لهذا المورد في زوهو.`);
    lines = (await allocateBills(env, vendorId, amount)).lines;
  } catch (e) {
    if (e instanceof HttpError) {
      if (e.status === 409) throw e;
      return fail(e.status, e.publicMessage + ' لم يُسجَّل شيء.');
    }
    return fail(502, 'تعذّر الاتصال بزوهو. لم يُسجَّل شيء، ويمكنك المحاولة مجدداً.');
  }

  // 4. دفعة المورد. بعد هذا الطلب لا إعادة تلقائية أبداً.
  const body = {
    vendor_id: vendorId,
    payment_mode: 'Check',
    amount,
    date,
    reference_number: chq,
    paid_through_account_id: bank.account,
    location_id: loc.id,
    description: `شيك ${chq} من ${bank.field} — سجّله ${user.display_name} من تطبيق ميداني`,
    bills: lines.map((l) => ({ bill_id: l.bill_id, amount_applied: l.applied })),
    custom_fields: [
      { api_name: 'cf_n_cheque', value: Number(chq) },
      { api_name: 'cf_0370c8', value: bank.field },
      { api_name: 'cf_5d7197', value: VENDOR_STATUS },
    ],
  };

  const NO_RETRY = 'لم يصل رد واضح من زوهو بعد إرسال دفعة المورد. لا تعد المحاولة: تحقق من دفعات الموردين في زوهو بعد دقيقة.';
  let created;
  try {
    created = await zohoRequest<{ vendorpayment?: { payment_id?: string } }>(env, 'POST', '/vendorpayments', { body, timeoutMs: 30_000 });
  } catch {
    await finish('unknown', NO_RETRY);
    throw new HttpError(504, NO_RETRY);
  }
  if (!created.data) {
    await finish('unknown', NO_RETRY);
    throw new HttpError(504, NO_RETRY);
  }
  if (created.data.code !== 0) {
    // زوهو رفض الطلب برمز خطأ صريح، فلم تُنشأ أي دفعة
    return fail(502, `زوهو رفض دفعة المورد: ${String(created.data.message || created.data.code).slice(0, 200)}`);
  }
  const vpid = String(created.data.vendorpayment?.payment_id || '');
  if (!ID_RE.test(vpid)) {
    await finish('unknown', NO_RETRY);
    throw new HttpError(504, NO_RETRY);
  }

  // 5. صورة الشيك مرفقاً على دفعة المورد. فشلها لا يلغي التسجيل.
  let warning: string | null = null;
  if (image) {
    try {
      const ext = image.type === 'image/png' ? 'png' : image.type === 'image/webp' ? 'webp' : 'jpg';
      const up = await zohoUpload(env, `/vendorpayments/${vpid}/attachment`, 'attachment', {
        name: `cheque-${chq}.${ext}`, type: image.type, bytes: decodeBase64(image.data),
      });
      if (!up.data || up.data.code !== 0) {
        console.error('vendor attachment failed', up.status, up.data?.code, up.data?.message);
        warning = 'سُجّلت دفعة المورد، لكن تعذّر رفع صورة الشيك إلى زوهو. أرفقها من زوهو.';
      }
    } catch {
      warning = 'سُجّلت دفعة المورد، لكن لم يصل رد واضح عند رفع صورة الشيك. تحقق منها في زوهو.';
    }
  }

  await finish('done', warning || 'تم التسجيل', vpid);
  return json({ ok: true, vendor_payment_id: vpid, warning, allocated: lines.length });
}
