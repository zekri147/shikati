import type { Env, User } from '../env';
import { HttpError, json, readJson } from '../http';
import { zohoGet, zohoRequest, zohoUpload, ZohoTimeout } from '../zoho';
import { audit } from '../audit';
import { ACCOUNT_CHEQUES_IN_HAND, ACCOUNT_ENDORSED, CACHE_KEY, DESTINATIONS, LOCATIONS, STATUS, todayAlgiers } from './constants';
import { canRegister, decodeBase64, type Allocation } from './register';
import { parseImage } from './ocr';
import { findVendorPayment } from './undo';
import { chequeNumber, isoDate } from './fields';

// تعديل الشيك بعد تسجيله، بموافقة ZEKRI يوم 2/11/2026: الرقم والمبلغ والتاريخ والموقع والوجهة والصورة.
// العميل لا يُعدَّل: يُحذف التسجيل بالتراجع ثم يُسجَّل من جديد.
// يُسمح ما دام الشيك «في الحوزة» دون إيداع ولا تظهير. تغيير المبلغ يعيد توزيعه آلياً على أقدم الفواتير.
// المدير يعدّل أي شيك، حتى ما سُجّل قبل التطبيق، والمودِع ما سجّله هو فقط. لا إعادة تلقائية بعد الحفظ.

const ID_RE = /^\d{10,25}$/;
const CHEQUE_RE = /^\d{7}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const ENDORSED_DEST = 'Autre Fournisseur';

interface PaymentInvoice { invoice_id?: string; invoice_payment_id?: string; invoice_number?: string; date?: string; amount_applied?: number; balance?: number }
interface Payment {
  payment_id: string;
  customer_id?: string;
  customer_name?: string;
  amount?: number;
  date?: string;
  account_id?: string;
  location_id?: string;
  location_name?: string;
  description?: string;
  updated_time?: string;
  last_modified_time?: string;
  invoices?: PaymentInvoice[];
  deposit_details?: { deposit_id?: string; account_name?: string }[];
  payment_refunds?: unknown[];
  custom_field_hash?: Record<string, string>;
}

const str = (v: unknown) => String(v ?? '').trim();
const version = (p: Payment) => str(p.updated_time || p.last_modified_time);

async function readPayment(env: Env, pid: string): Promise<Payment> {
  let r;
  try {
    r = await zohoRequest<{ payment?: Payment }>(env, 'GET', `/customerpayments/${pid}`, { timeoutMs: 15_000 });
  } catch (e) {
    if (e instanceof ZohoTimeout) throw new HttpError(504, 'زوهو لم يرد. لم يتغيّر شيء.');
    throw e;
  }
  if (r.status === 404 || r.data?.code === 1002) throw new HttpError(404, 'هذا الشيك غير موجود في زوهو.');
  if (!r.data || r.data.code !== 0 || !r.data.payment) throw new HttpError(502, 'تعذّرت قراءة الشيك من زوهو.');
  return r.data.payment;
}

// المدير يعدّل أي شيك، والمودِع ما سجّله هو من التطبيق
async function ownsOrAdmin(env: Env, user: User, pid: string): Promise<boolean> {
  if (!canRegister(env, user)) return false;
  if (user.role === 'admin') return true;
  const row = await env.DB.prepare("SELECT user_id FROM registrations WHERE payment_id = ? AND state = 'done'")
    .bind(pid).first<{ user_id: number | null }>();
  return row?.user_id === user.id;
}

// هل يمكن تعديل الشيك الآن؟ يعيد السبب إن لم يمكن
async function editBlocker(env: Env, p: Payment): Promise<string | null> {
  const status = str(p.custom_field_hash?.cf_5d7197);
  if (status !== STATUS.IN_HAND) return `حالة الشيك «${status || 'فارغة'}». يُعدَّل الشيك «${STATUS.IN_HAND}» فقط.`;
  if ((p.deposit_details || []).length) return 'للشيك إيداع في زوهو. تراجع عن الإيداع أولاً.';
  if ((p.payment_refunds || []).length) return 'للدفعة استرداد مسجّل في زوهو.';
  if (p.account_id !== ACCOUNT_CHEQUES_IN_HAND && p.account_id !== ACCOUNT_ENDORSED) return 'الشيك في حساب غير حساب الشيكات.';
  const locks = await env.DB.prepare(
    "SELECT 'deposit' AS k FROM deposits WHERE payment_id = ?1 AND state IN ('pending', 'unknown') " +
    "UNION ALL SELECT 'endorse' FROM endorsements WHERE payment_id = ?1 AND state IN ('pending', 'unknown')",
  ).bind(p.payment_id).all<{ k: string }>();
  if (locks.results.length) return 'عملية سابقة على هذا الشيك لم تُعرف نتيجتها. تحقق منها أولاً.';
  if (p.account_id === ACCOUNT_ENDORSED && (await findVendorPayment(env, p))) return 'للشيك دفعة مورد. تراجع عن التظهير أولاً.';
  return null;
}

// لصفحة التفاصيل: هل يظهر زر «تعديل» لهذا المستخدم؟
export async function editForDetail(env: Env, user: User, p: Payment): Promise<{ allowed: boolean; blocker: string | null; version: string } | null> {
  if (!(await ownsOrAdmin(env, user, p.payment_id))) return null;
  const status = str(p.custom_field_hash?.cf_5d7197);
  if (status !== STATUS.IN_HAND) return null;
  let blocker: string | null;
  try {
    blocker = await editBlocker(env, p);
  } catch {
    blocker = 'تعذّر التحقق من الشيك في زوهو.';
  }
  return { allowed: !blocker, blocker, version: version(p) };
}

// التوزيع الجديد: الفواتير التي يسدّدها الشيك الآن (برصيدها قبله) مع فواتير العميل غير المدفوعة، الأقدم أولاً
async function reallocate(env: Env, p: Payment, amount: number): Promise<{ lines: Allocation[]; unused: number }> {
  const customerId = str(p.customer_id);
  const data = await zohoGet<{ invoices?: { invoice_id: string; invoice_number: string; date: string; balance: number; customer_id?: string }[] }>(
    env, '/invoices', { customer_id: customerId, filter_by: 'Status.Unpaid', sort_column: 'date', sort_order: 'A', per_page: 200 },
  );
  const pool = new Map<string, { number: string; date: string; cents: number }>();
  for (const inv of data.invoices || []) {
    if (inv.customer_id && inv.customer_id !== customerId) continue;
    pool.set(inv.invoice_id, { number: inv.invoice_number, date: isoDate(inv.date), cents: Math.round((Number(inv.balance) || 0) * 100) });
  }
  for (const inv of p.invoices || []) {
    const id = str(inv.invoice_id);
    if (!id) continue;
    const applied = Math.round((Number(inv.amount_applied) || 0) * 100);
    const cur = pool.get(id);
    if (cur) cur.cents += applied;
    else pool.set(id, { number: str(inv.invoice_number), date: isoDate(inv.date), cents: Math.round((Number(inv.balance) || 0) * 100) + applied });
  }
  const sorted = [...pool.entries()].sort((a, b) => a[1].date.localeCompare(b[1].date) || a[1].number.localeCompare(b[1].number));
  let rest = Math.round(amount * 100);
  const lines: Allocation[] = [];
  for (const [id, inv] of sorted) {
    if (rest <= 0) break;
    if (inv.cents <= 0) continue;
    const give = Math.min(inv.cents, rest);
    lines.push({ invoice_id: id, number: inv.number, date: inv.date, balance: inv.cents / 100, applied: give / 100 });
    rest -= give;
  }
  return { lines, unused: rest / 100 };
}

interface EditBody {
  payment_id?: string;
  version?: string;
  cheque_number?: string;
  amount?: number;
  date?: string;
  location?: string;
  destination?: string;
  image?: string;
}

interface Change { label: string; from: string; to: string }

// يتحقق من المدخلات ويحسب الفروق، دون أي كتابة
async function plan(env: Env, user: User, b: EditBody) {
  const pid = str(b.payment_id);
  if (!ID_RE.test(pid)) throw new HttpError(400, 'معرّف الدفعة غير صالح.');
  if (!(await ownsOrAdmin(env, user, pid))) {
    throw new HttpError(403, 'يعدّل المودِع الشيكات التي سجّلها هو من التطبيق فقط. اطلب ذلك من المدير.');
  }
  const p = await readPayment(env, pid);
  if (str(b.version) && str(b.version) !== version(p)) throw new HttpError(409, 'تغيّر الشيك في زوهو بعد فتح النموذج. حدّث الصفحة.');
  const blocker = await editBlocker(env, p);
  if (blocker) throw new HttpError(409, blocker);

  const cf = p.custom_field_hash || {};
  const old = {
    chq: chequeNumber(cf.cf_n_cheque),
    amount: Math.round((Number(p.amount) || 0) * 100) / 100,
    date: isoDate(p.date),
    loc: str(p.location_name).toUpperCase(),
    dest: str(cf.cf_d_pos_vers),
  };
  const chq = str(b.cheque_number);
  const amount = Math.round(Number(b.amount) * 100) / 100;
  const date = str(b.date);
  const locKey = str(b.location);
  const dest = str(b.destination);
  if (!CHEQUE_RE.test(chq) || chq === '0000000') throw new HttpError(400, 'رقم الشيك يجب أن يكون 7 أرقام.');
  if (!Number.isFinite(amount) || amount <= 0 || amount > 1e9) throw new HttpError(400, 'المبلغ غير صالح.');
  if (!DATE_RE.test(date) || date > todayAlgiers()) throw new HttpError(400, 'تاريخ الاستلام غير صالح.');
  if (!LOCATIONS[locKey]) throw new HttpError(400, 'اختر الموقع.');
  if (!(DESTINATIONS as readonly string[]).includes(dest)) throw new HttpError(400, 'اختر وجهة الشيك.');
  const image = b.image ? parseImage(b.image) : null;

  const changes: Change[] = [];
  if (chq !== old.chq) changes.push({ label: 'رقم الشيك', from: old.chq || '—', to: chq });
  if (Math.abs(amount - old.amount) > 0.005) changes.push({ label: 'المبلغ', from: String(old.amount), to: String(amount) });
  if (date !== old.date) changes.push({ label: 'تاريخ الاستلام', from: old.date || '—', to: date });
  if (locKey !== old.loc) changes.push({ label: 'الموقع', from: LOCATIONS[old.loc]?.label || old.loc || '—', to: LOCATIONS[locKey].label });
  if (dest !== old.dest) changes.push({ label: 'الوجهة', from: old.dest || '—', to: dest });
  if (image) changes.push({ label: 'الصورة', from: '', to: 'صورة جديدة' });
  if (!changes.length) throw new HttpError(400, 'لم يتغيّر شيء.');

  // رقم الشيك الجديد مسجّل لهذا العميل في دفعة أخرى؟
  if (chq !== old.chq) {
    const dup = await zohoGet<{ customerpayments?: { payment_id: string; cf_n_cheque?: string }[] }>(env, '/customerpayments', {
      customer_id: str(p.customer_id), filter_by: 'PaymentMode.Check', per_page: 200,
    });
    if ((dup.customerpayments || []).some((x) => x.payment_id !== pid && str(x.cf_n_cheque) === chq)) {
      throw new HttpError(409, 'شيك بهذا الرقم مسجّل من قبل لهذا العميل في زوهو.');
    }
  }

  const amountChanged = changes.some((c) => c.label === 'المبلغ');
  const alloc = amountChanged ? await reallocate(env, p, amount) : null;
  return { p, pid, old, chq, amount, date, locKey, dest, image, changes, alloc };
}

export async function handleEditPreview(req: Request, env: Env, user: User): Promise<Response> {
  const r = await plan(env, user, await readJson<EditBody>(req));
  return json({ changes: r.changes, allocation: r.alloc });
}

export async function handleEdit(req: Request, env: Env, user: User): Promise<Response> {
  const b = await readJson<EditBody>(req);
  let r;
  try {
    r = await plan(env, user, b);
  } catch (e) {
    if (e instanceof HttpError) await audit(env, user, 'edit', 'denied', str(b.payment_id), e.publicMessage);
    throw e;
  }
  const { p, pid, chq, amount, date, locKey, dest, image, changes, alloc } = r;
  const cf = p.custom_field_hash || {};
  const fieldChanges = changes.filter((c) => c.label !== 'الصورة');
  const summary = changes.map((c) => (c.from ? `${c.label} ${c.from} ← ${c.to}` : c.to)).join('، ');
  const target = `${pid} / ${chq}`;

  // 1. تحديث الدفعة. المبلغ والفواتير يُرسلان فقط إن تغيّر المبلغ: زوهو يرفض إعادة إرسال
  // الفواتير الحالية كما هي («المبلغ أكبر من باقي الفواتير»)، ويُبقي التوزيع إن لم تُرسل.
  if (fieldChanges.length) {
    const logOld = str(cf.cf_fffaad);
    const logLine = `${todayAlgiers()} — تعديل من تطبيق شيكاتي (${user.display_name}): ${fieldChanges.map((c) => `${c.label} ${c.from} ← ${c.to}`).join('، ')}`;
    const oldChq = r.old.chq;
    let description = str(p.description);
    if (oldChq && chq !== oldChq && description.includes(oldChq)) description = description.split(oldChq).join(chq);
    const body: Record<string, unknown> = {
      date,
      reference_number: chq,
      account_id: dest === ENDORSED_DEST ? ACCOUNT_ENDORSED : ACCOUNT_CHEQUES_IN_HAND,
      location_id: LOCATIONS[locKey].id,
      custom_fields: [
        { api_name: 'cf_n_cheque', value: chq },
        { api_name: 'cf_d_pos_vers', value: dest },
        { api_name: 'cf_fffaad', value: logOld ? `${logOld}\n${logLine}` : logLine },
      ],
    };
    if (description) body.description = description;
    if (alloc) {
      Object.assign(body, {
        customer_id: p.customer_id,
        payment_mode: 'Check',
        amount,
        // معرّف التطبيق الحالي على الفاتورة: دونه يعدّه زوهو تطبيقاً جديداً على فاتورة مسدّدة فيرفضه
        // (جُرّب على زوهو يوم 2/11/2026)
        invoices: alloc.lines.map((l) => {
          const cur = (p.invoices || []).find((i) => str(i.invoice_id) === l.invoice_id && str(i.invoice_payment_id));
          return cur
            ? { invoice_id: l.invoice_id, invoice_payment_id: str(cur.invoice_payment_id), amount_applied: l.applied }
            : { invoice_id: l.invoice_id, amount_applied: l.applied };
        }),
      });
    }

    const NO_RETRY = 'لم يصل رد واضح من زوهو بعد حفظ التعديل. لا تعد المحاولة: حدّث الصفحة بعد دقيقة وتحقق، ثم أخبر المدير.';
    let up;
    try {
      up = await zohoRequest(env, 'PUT', `/customerpayments/${pid}`, { body, timeoutMs: 30_000 });
    } catch {
      await audit(env, user, 'edit', 'error', target, `unknown: ${summary}`);
      throw new HttpError(504, NO_RETRY);
    }
    if (!up.data) {
      await audit(env, user, 'edit', 'error', target, `unknown: ${summary}`);
      throw new HttpError(504, NO_RETRY);
    }
    if (up.data.code !== 0) {
      const raw = str(up.data.message || up.data.code);
      const msg = `زوهو رفض التعديل: ${/more than the balance due/i.test(raw) ? 'المبلغ الموزّع أكبر من باقي الفواتير.' : raw.slice(0, 200)}`;
      await audit(env, user, 'edit', 'denied', target, msg);
      throw new HttpError(502, msg);
    }
    // قفل التكرار في القاعدة يتبع الرقم الجديد
    await env.DB.prepare("UPDATE registrations SET cheque_number = ?, amount = ? WHERE payment_id = ? AND state = 'done'")
      .bind(chq, amount, pid).run();
  }

  // 2. الصورة الجديدة مرفقاً إضافياً. الصفحة تعرض أحدث صورة. فشلها لا يلغي التعديل.
  let warning: string | undefined;
  if (image) {
    try {
      const ext = image.type === 'image/png' ? 'png' : image.type === 'image/webp' ? 'webp' : 'jpg';
      const upl = await zohoUpload(env, `/customerpayments/${pid}/attachment`, 'attachment', {
        name: `cheque-${chq}-${Date.now()}.${ext}`, type: image.type, bytes: decodeBase64(image.data),
      });
      if (!upl.data || upl.data.code !== 0) warning = fieldChanges.length ? 'حُفظ التعديل، لكن تعذّر رفع الصورة الجديدة.' : 'تعذّر رفع الصورة الجديدة.';
    } catch {
      warning = 'لم يصل رد واضح عند رفع الصورة الجديدة. تحقق منها في صفحة الشيك.';
    }
  }

  await env.DB.prepare('DELETE FROM cache WHERE key = ?').bind(CACHE_KEY).run();
  await audit(env, user, 'edit', warning && !fieldChanges.length ? 'error' : 'ok', target, warning ? `${summary} — ${warning}` : summary);
  return json({ ok: true, message: 'حُفظ التعديل.', warning });
}
