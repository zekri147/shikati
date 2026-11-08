import type { Env, Role, User } from '../env';
import { HttpError, json, readJson } from '../http';
import { zohoGet, zohoRequest, zohoUpload, ZohoTimeout } from '../zoho';
import { audit } from '../audit';
import {
  ACCOUNT_CHEQUES_IN_HAND, ACCOUNT_ENDORSED, CACHE_KEY, DESTINATIONS, LOCATIONS, parseRoles, STATUS, todayAlgiers,
} from './constants';
import { parseImage, readCheque, readerConfigured, readOrientation } from './ocr';
import { allocateBills, canEndorse, endorseCheque } from './endorse';
import { custodyOnRegister } from './custody';
import { outBankOptions } from './outcheque';

// تسجيل شيك جديد من التطبيق: دفعة عميل بطريقة «شيك»، موزّعة على أقدم فواتير العميل.
// هذا ثاني مكان يكتب في زوهو بعد الإيداع، بموافقة ZEKRI (الإنشاء مباشرة دون اعتماد).
// القواعد نفسها: قفل في القاعدة قبل أي طلب، ولا إعادة تلقائية بعد إرسال طلب الإنشاء.

const ID_RE = /^\d{10,25}$/;
const REQUEST_RE = /^[a-zA-Z0-9-]{16,64}$/;
const CHEQUE_RE = /^\d{7}$/;
const UNPAID_FILTER = 'Status.Unpaid';

// كل مندوب يسجّل شيكاً لأي عميل (بطلب ZEKRI يوم 7/11/2026)
export function registerRoles(env: Env): Role[] {
  return parseRoles(env.REGISTER_ROLES, 'admin,rep');
}
export const canRegister = (env: Env, user: User) => registerRoles(env).includes(user.role);

export function requireRegister(env: Env, user: User) {
  if (!canRegister(env, user)) throw new HttpError(403, 'ليست لديك صلاحية تسجيل الشيكات.');
}

// ——— قراءة فقط: الخيارات، والعملاء، والقراءة الآلية، ومعاينة التوزيع ———

export function registerOptions(env: Env, user: User): Response {
  return json({
    can_register: canRegister(env, user),
    reader: readerConfigured(env),
    // وجهة «مورد آخر» تظهّر الشيك فور تسجيله، والتظهير للمدير وحده
    destinations: DESTINATIONS.filter((d) => d !== 'Autre Fournisseur' || canEndorse(user)),
    locations: Object.entries(LOCATIONS).map(([key, v]) => ({ key, label: v.label })),
    // شيك الشركة الصادر لمورد: للمدير وحده، مثل التظهير
    out_banks: canEndorse(user) ? outBankOptions() : null,
  });
}

interface Contact { contact_id: string; contact_name: string; contact_type?: string; status?: string }

// زوهو يتجاهل نوع جهة الاتصال حين يجتمع مع البحث بالاسم، فيعيد العملاء والموردين معاً. نصفّي هنا.
export async function searchContacts(env: Env, type: 'customer' | 'vendor', q: string): Promise<{ id: string; name: string }[]> {
  const term = q.trim().slice(0, 60);
  if (term.length < 2) return [];
  const data = await zohoGet<{ contacts?: Contact[] }>(env, '/contacts', {
    contact_type: type, filter_by: 'Status.Active', search_text: term, per_page: 30,
  });
  return (data.contacts || [])
    .filter((c) => c.contact_type === type)
    .map((c) => ({ id: c.contact_id, name: c.contact_name }));
}

export async function searchCustomers(env: Env, user: User, q: string): Promise<Response> {
  requireRegister(env, user);
  return json({ customers: await searchContacts(env, 'customer', q) });
}

export async function handleRead(req: Request, env: Env, user: User): Promise<Response> {
  requireRegister(env, user);
  const body = await readJson<{ image?: string }>(req);
  const reading = await readCheque(env, parseImage(body.image), user.role === 'admin');
  await audit(env, user, 'register.read', 'ok', reading.cheque_number, reading.note);
  return json({ reading });
}

interface Invoice { invoice_id: string; invoice_number: string; date: string; balance: number; customer_id?: string }
export interface Allocation { invoice_id: string; number: string; date: string; balance: number; applied: number }

export async function allocate(env: Env, customerId: string, amount: number): Promise<{ lines: Allocation[]; unused: number }> {
  const data = await zohoGet<{ invoices?: Invoice[] }>(env, '/invoices', {
    customer_id: customerId, filter_by: UNPAID_FILTER, sort_column: 'date', sort_order: 'A', per_page: 200,
  });
  let rest = Math.round(amount * 100);
  const lines: Allocation[] = [];
  for (const inv of data.invoices || []) {
    if (inv.customer_id && inv.customer_id !== customerId) continue;
    const bal = Math.round((Number(inv.balance) || 0) * 100);
    if (rest <= 0) break;
    if (bal <= 0) continue;
    const give = Math.min(bal, rest);
    lines.push({ invoice_id: inv.invoice_id, number: inv.invoice_number, date: inv.date, balance: bal / 100, applied: give / 100 });
    rest -= give;
  }
  return { lines, unused: rest / 100 };
}

export async function handlePreview(req: Request, env: Env, user: User): Promise<Response> {
  requireRegister(env, user);
  const b = await readJson<{ customer_id?: string; amount?: number; vendor_id?: string }>(req);
  const customerId = String(b.customer_id || '');
  const amount = Number(b.amount);
  if (!ID_RE.test(customerId)) throw new HttpError(400, 'اختر العميل.');
  if (!Number.isFinite(amount) || amount <= 0) throw new HttpError(400, 'المبلغ غير صالح.');
  const customer = await allocate(env, customerId, amount);
  // الشيك المظهّر لمورد: توزيعه أيضاً على أقدم فواتير المورد
  const vendorId = String(b.vendor_id || '');
  const vendor = ID_RE.test(vendorId) && canEndorse(user) ? await allocateBills(env, vendorId, amount) : null;
  return json({ ...customer, vendor });
}

// اتجاه صورة جديدة فقط (صورة بديلة عند تعديل الشيك)
export async function handleOrient(req: Request, env: Env, user: User): Promise<Response> {
  requireRegister(env, user);
  const body = await readJson<{ image?: string }>(req);
  return json({ rotation: (await readOrientation(env, parseImage(body.image))) ?? 0 });
}

// ——— الكتابة: إنشاء الدفعة ———

interface RegisterBody {
  request_id?: string;
  customer_id?: string;
  customer?: string;
  amount?: number;
  cheque_number?: string;
  destination?: string;
  location?: string;
  image?: string;
  vendor_id?: string;
  vendor?: string;
  // تاريخ الاستلام: اليوم افتراضياً، ويُغيَّر إن استُلم الشيك في يوم سابق
  date?: string;
}

const LOCK_MESSAGES: Record<string, string> = {
  pending: 'تسجيل هذا الشيك قيد التنفيذ الآن. انتظر قليلاً ثم افتح «كل الشيكات».',
  done: 'هذا الشيك مسجّل من قبل لنفس العميل.',
  unknown: 'محاولة سابقة لتسجيل هذا الشيك لم تُعرف نتيجتها. تحقق في «كل الشيكات» قبل أي محاولة، وأخبر المدير.',
};

export function decodeBase64(data: string): Uint8Array {
  const bin = atob(data);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export async function handleRegister(req: Request, env: Env, user: User): Promise<Response> {
  requireRegister(env, user);
  const b = await readJson<RegisterBody>(req);

  // 1. التحقق من المدخلات بنفس قواعد التحقق في زوهو
  const requestId = String(b.request_id || '');
  const customerId = String(b.customer_id || '');
  const customer = String(b.customer || '').trim().slice(0, 200);
  const amount = Math.round(Number(b.amount) * 100) / 100;
  const chq = String(b.cheque_number || '').trim();
  const dest = String(b.destination || '');
  const loc = LOCATIONS[String(b.location || '')];
  if (!REQUEST_RE.test(requestId)) throw new HttpError(400, 'طلب غير صالح. أعد فتح الشاشة.');
  if (!ID_RE.test(customerId)) throw new HttpError(400, 'اختر العميل.');
  if (!Number.isFinite(amount) || amount <= 0 || amount > 1e9) throw new HttpError(400, 'المبلغ غير صالح.');
  if (!CHEQUE_RE.test(chq) || chq === '0000000') throw new HttpError(400, 'رقم الشيك يجب أن يكون 7 أرقام.');
  if (!(DESTINATIONS as readonly string[]).includes(dest)) throw new HttpError(400, 'اختر وجهة الشيك.');
  if (!loc) throw new HttpError(400, 'اختر الموقع.');
  const endorsed = dest === 'Autre Fournisseur';
  if (endorsed && !canEndorse(user)) throw new HttpError(403, 'التظهير لمورد للمدير وحده. سجّل الشيك لبنك AGB أو الرستمية.');
  const vendorId = String(b.vendor_id || '');
  const vendorName = String(b.vendor || '').trim().slice(0, 200);
  if (endorsed && (!ID_RE.test(vendorId) || !vendorName)) throw new HttpError(400, 'اختر المورد الذي سُلّم له الشيك.');
  const image = b.image ? parseImage(b.image) : null;
  const today = todayAlgiers();
  const date = String(b.date || today).trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || date > today) throw new HttpError(400, 'تاريخ الاستلام غير صالح: لا يكون بعد اليوم.');

  // 2. القفل: إدخال ذرّي. يرفض الطلب نفسه مرتين، والشيك نفسه لنفس العميل ما دام تسجيله السابق لم يفشل.
  try {
    await env.DB.prepare(
      'INSERT INTO registrations (request_id, state, user_id, username, display_name, customer_id, customer, cheque_number, amount) ' +
      "VALUES (?, 'pending', ?, ?, ?, ?, ?, ?, ?)",
    ).bind(requestId, user.id, user.username, user.display_name, customerId, customer, chq, amount).run();
  } catch {
    const same = await env.DB.prepare('SELECT state, payment_id FROM registrations WHERE request_id = ?')
      .bind(requestId).first<{ state: string; payment_id: string | null }>();
    if (same?.state === 'done') return json({ ok: true, payment_id: same.payment_id, repeated: true });
    const other = await env.DB.prepare(
      "SELECT state FROM registrations WHERE customer_id = ? AND cheque_number = ? AND state != 'failed'",
    ).bind(customerId, chq).first<{ state: string }>();
    const state = same?.state || other?.state || 'pending';
    await audit(env, user, 'register', 'denied', `${customerId} / ${chq}`, `locked:${state}`);
    throw new HttpError(409, LOCK_MESSAGES[state] || LOCK_MESSAGES.pending);
  }

  const finish = async (state: 'done' | 'failed' | 'unknown', message: string, paymentId: string | null = null) => {
    await env.DB.prepare(
      "UPDATE registrations SET state = ?, message = ?, payment_id = COALESCE(?, payment_id), finished_at = datetime('now') WHERE request_id = ?",
    ).bind(state, message, paymentId, requestId).run();
    await env.DB.prepare('DELETE FROM cache WHERE key = ?').bind(CACHE_KEY).run();
    const result = state === 'done' ? 'ok' : state === 'failed' ? 'denied' : 'error';
    await audit(env, user, 'register', result, paymentId ? `${paymentId} / ${chq}` : `${customerId} / ${chq}`, `${state}: ${message}`);
  };
  const fail = async (status: number, message: string): Promise<never> => {
    await finish('failed', message);
    throw new HttpError(status, message);
  };

  // 3. هل الشيك مسجّل في زوهو من قبل (من خارج التطبيق)؟ وتوزيع المبلغ على الفواتير
  let lines: Allocation[];
  try {
    const dup = await zohoGet<{ customerpayments?: { payment_id: string; cf_n_cheque?: string }[] }>(env, '/customerpayments', {
      customer_id: customerId, filter_by: 'PaymentMode.Check', per_page: 200,
    });
    if ((dup.customerpayments || []).some((p) => String(p.cf_n_cheque || '').trim() === chq)) {
      return fail(409, 'شيك بهذا الرقم مسجّل من قبل لهذا العميل في زوهو.');
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
  // تاريخ الدفعة هو تاريخ الاستلام، فيصير تاريخ ترحيلها وتطبيقها على الفواتير أيضاً
  const logLine = `${today} — تسجيل الشيك${date !== today ? ` (استُلم ${date})` : ''} من تطبيق ميداني (${user.display_name})`;
  const payment = {
    customer_id: customerId,
    payment_mode: 'Check',
    amount,
    date,
    reference_number: chq,
    account_id: dest === 'Autre Fournisseur' ? ACCOUNT_ENDORSED : ACCOUNT_CHEQUES_IN_HAND,
    location_id: loc.id,
    description: `شيك ${chq} — سجّله ${user.display_name} من تطبيق ميداني`,
    custom_fields: [
      { api_name: 'cf_n_cheque', value: chq },
      { api_name: 'cf_d_pos_vers', value: dest },
      { api_name: 'cf_5d7197', value: STATUS.IN_HAND },
      { api_name: 'cf_fffaad', value: logLine },
    ],
    invoices: lines.map((l) => ({ invoice_id: l.invoice_id, amount_applied: l.applied })),
  };

  const NO_RETRY = 'لم يصل رد واضح من زوهو بعد إرسال التسجيل. لا تعد المحاولة: افتح «كل الشيكات» بعد دقيقة وتحقق، ثم أخبر المدير.';
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
    return fail(502, `زوهو رفض التسجيل: ${String(created.data.message || created.data.code).slice(0, 200)}`);
  }
  const pid = String(created.data.payment?.payment_id || '');
  if (!ID_RE.test(pid)) {
    await finish('unknown', NO_RETRY);
    throw new HttpError(504, NO_RETRY);
  }

  // 5. صورة الشيك مرفقاً على الدفعة. فشلها لا يلغي التسجيل.
  let warning: string | null = null;
  if (image) {
    try {
      const ext = image.type === 'image/png' ? 'png' : image.type === 'image/webp' ? 'webp' : 'jpg';
      const up = await zohoUpload(env, `/customerpayments/${pid}/attachment`, 'attachment', {
        name: `cheque-${chq}.${ext}`, type: image.type, bytes: decodeBase64(image.data),
      });
      if (!up.data || up.data.code !== 0) {
        console.error('attachment failed', up.status, up.data?.code, up.data?.message);
        warning = 'سُجّل الشيك، لكن تعذّر رفع صورته إلى زوهو.';
      }
    } catch {
      warning = 'سُجّل الشيك، لكن لم يصل رد واضح عند رفع صورته. تحقق منها في صفحة التفاصيل.';
    }
  } else {
    warning = 'سُجّل الشيك دون صورة.';
  }

  await finish('done', warning || 'تم التسجيل', pid);
  // العهدة: الشيك عند من سجّله. فشلها لا يمس التسجيل في زوهو
  if (!endorsed) await custodyOnRegister(env, user, pid).catch((e) => console.error('custody', e));

  // 6. الشيك المظهّر لمورد: دفعة المورد مباشرة بعد دفعة العميل. فشلها لا يلغي التسجيل،
  // والشيك يبقى «في الحوزة» في حساب الشيكات المظهّرة حتى يُتمّ تظهيره من صفحته.
  let endorse: { state: string; message: string; vendor_payment_id?: string } | null = null;
  if (endorsed) {
    const r = await endorseCheque(env, user, pid, vendorId, vendorName);
    endorse = { state: r.state, message: r.state === 'done' ? (r.warning || r.message) : r.message, vendor_payment_id: r.vendor_payment_id };
    if (r.state !== 'done') {
      const tail = r.state === 'unknown' ? r.message : `${r.message} أتمّ التظهير من صفحة الشيك.`;
      warning = `سُجّل الشيك، لكن لم يكتمل تظهيره للمورد: ${tail}`;
    } else if (r.warning) {
      warning = r.warning;
    }
  }
  return json({ ok: true, payment_id: pid, warning, allocated: lines.length, endorse });
}
