import type { Env, User } from '../env';
import { HttpError, json } from '../http';
import { cacheGet, cachePut, zohoRequest, ZohoTimeout } from '../zoho';
import { chequeNumber, isoDate, wrongAccountText } from './fields';
import { canEndorse as endorseAllowed, endorseBlocker } from './endorse';
import { undoForDetail } from './undo';
import { editForDetail } from './edit';
import { depositDateFor } from './depositdate';
import { custodyForDetail } from './custody';
import { STATUS } from './constants';
import { transferBankLabel } from './transfer';

// صفحة تفاصيل الشيك: قراءة فقط. تُقرأ الدفعة من زوهو مباشرة في كل مرة،
// ثم يُضاف إليها ما سجّله التطبيق نفسه (قفل الإيداع وسجل العمليات).

const LOCATIONS: Record<string, string> = { ALGER: 'الجزائر', 'EL EULMA': 'العلمة' };
const IMAGE_TYPES = ['jpg', 'jpeg', 'png', 'webp', 'gif', 'heic'];
// رابط صورة الشيك في غوغل درايف، كما كان يكتبه بوت تيليجرام
const DRIVE_RE = /^https:\/\/(drive|docs)\.google\.com\/[^\s"'<>]+$/;
// السطر الآلي الذي كان البوت يضعه في أول سجل العمليات، مثل [END|123|456]
const BOT_TAG_RE = /^\[(PEND|END|NONE)(\|[^\]]*)?\]$/;
const STALE_PENDING_SEC = 300;
const OWNER_TTL = 6 * 3600;
const REP_RE = /^[A-Z][A-Z0-9 _-]{1,31}$/;

// مندوب العميل: الحقل «Owner» (cf_owner) على العميل في زوهو، محفوظ ست ساعات.
// يُعرض باسم المستخدم الذي له الرمز نفسه في التطبيق، وإلا بالرمز. أي خطأ لا يمنع عرض الصفحة.
async function customerRep(env: Env, customerId: string): Promise<string> {
  if (!/^\d{10,25}$/.test(customerId)) return '';
  const key = `owner:${customerId}`;
  let code = await cacheGet(env, key);
  if (code === null) {
    try {
      const r = await zohoRequest<{ code?: number; contact?: { cf_owner?: string; custom_field_hash?: Record<string, string> } }>(env, 'GET', `/contacts/${customerId}`);
      if (!r.data || r.data.code !== 0 || !r.data.contact) return '';
      const c = r.data.contact;
      code = str(c.cf_owner ?? c.custom_field_hash?.cf_owner).trim().toUpperCase();
      if (!REP_RE.test(code)) code = '';
      await cachePut(env, key, code, OWNER_TTL);
    } catch {
      return '';
    }
  }
  if (!code) return '';
  const u = await env.DB.prepare('SELECT display_name FROM users WHERE rep_code = ? AND active = 1 ORDER BY id LIMIT 1')
    .bind(code).first<{ display_name: string }>();
  return u?.display_name || code;
}

interface ZohoDetail {
  payment_id: string;
  payment_number?: string;
  customer_id?: string;
  customer_name?: string;
  amount?: number;
  date?: string;
  account_id?: string;
  account_name?: string;
  payment_mode?: string;
  location_name?: string;
  description?: string;
  created_by?: string;
  created_by_name?: string;
  created_time?: string;
  unused_amount?: number;
  invoices?: { invoice_number?: string; date?: string; amount_applied?: number; total?: number; balance?: number }[];
  deposit_details?: Record<string, unknown>[];
  payment_refunds?: unknown[];
  documents?: { file_type?: string }[];
  custom_field_hash?: Record<string, string>;
}

const str = (v: unknown) => String(v ?? '').trim();

export async function handleChequeDetail(env: Env, user: User, pid: string): Promise<Response> {
  let r;
  try {
    r = await zohoRequest<{ payment?: ZohoDetail }>(env, 'GET', `/customerpayments/${pid}`, { timeoutMs: 15_000 });
  } catch (e) {
    if (e instanceof ZohoTimeout) throw new HttpError(504, 'زوهو لم يرد في الوقت المحدد. حاول مرة أخرى.');
    throw e;
  }
  if (r.status === 404 || r.data?.code === 1002) throw new HttpError(404, 'هذا الشيك غير موجود في زوهو، ربما حُذفت دفعته.');
  const p = r.data?.payment;
  if (!r.data || r.data.code !== 0 || !p) throw new HttpError(502, 'تعذّرت قراءة الشيك من زوهو.');

  const cf = p.custom_field_hash || {};
  const drive = str(cf.cf_drive);
  const log = str(cf.cf_fffaad).split('\n').map((l) => l.trim()).filter((l) => l && !BOT_TAG_RE.test(l));

  const lock = await env.DB.prepare(
    "SELECT state, display_name, message, started_at, finished_at, " +
    "(state = 'pending' AND started_at < datetime('now', ?)) AS stale FROM deposits WHERE payment_id = ?",
  ).bind(`-${STALE_PENDING_SEC} seconds`, pid).first<{
    state: string; display_name: string | null; message: string | null; started_at: string; finished_at: string | null; stale: number;
  }>();
  const endorsement = await env.DB.prepare(
    "SELECT state, vendor, display_name, vendor_payment_id, message, started_at FROM endorsements WHERE payment_id = ?",
  ).bind(pid).first<{ state: string; vendor: string | null; display_name: string | null; vendor_payment_id: string | null; message: string | null; started_at: string }>();
  // إتمام التظهير: الشيك في حساب الشيكات المظهّرة ووجهته «مورد آخر» وحالته «في الحوزة»، ولا تظهير معلّق
  const canEndorse = endorseAllowed(user) && !endorseBlocker(p)
    && !(endorsement && ['pending', 'done', 'unknown'].includes(endorsement.state));
  const { results: history } = await env.DB.prepare(
    // «target LIKE 'pid /%'» كمدى بين «pid /» و«pid 0» (الحرف بعد «/»)، فيستعمل فهرس audit_target
    "SELECT at, username, action, result, details FROM audit_log WHERE target = ? OR (target >= ? AND target < ?) ORDER BY id DESC LIMIT 20",
  ).bind(pid, `${pid} /`, `${pid} 0`).all<{ at: string; username: string | null; action: string; result: string; details: string | null }>();

  const isAdmin = user.role === 'admin';
  // التحويل البنكي من عميل: في الحوزة مع إيداعه (منذ 25/11/2026)، أو في حساب البنك مباشرة. لا «حساب خطأ» له
  const transfer = transferBankLabel(p);
  const deposits = p.deposit_details || [];
  const depositDate = deposits.length
    ? await depositDateFor(env, pid, cf as Record<string, unknown>, str(deposits[0].deposit_id))
    : '';
  const undo = await undoForDetail(env, user, p as Parameters<typeof undoForDetail>[2]);
  const edit = await editForDetail(env, user, p as Parameters<typeof editForDetail>[2]);
  const rep = await customerRep(env, str(p.customer_id));
  const custody = await custodyForDetail(env, user, pid, str(cf.cf_5d7197) === STATUS.IN_HAND);
  // من سجّله: كل ما يُسجَّل من التطبيق يصل زوهو باسم مستخدم الربط (admin)، فالاسم الصحيح
  // من قاعدة التطبيق (بطلب ZEKRI يوم 24/11/2026). الشيك المسجّل في زوهو مباشرة يبقى باسم زوهو.
  const registeredBy = await env.DB.prepare(
    "SELECT display_name, username FROM registrations WHERE payment_id = ? AND state IN ('done', 'unknown') ORDER BY started_at DESC LIMIT 1",
  ).bind(pid).first<{ display_name: string | null; username: string | null }>();
  // ثم وصف الدفعة الذي يكتبه التسجيل في زوهو: «شيك … — سجّله أمين من تطبيق ميداني» (أو «شيكاتي» قبل تغيير الاسم)
  const appRegistrant = (d: string) => (d.match(/سجّله\s+(.+?)\s+من تطبيق (?:ميداني|شيكاتي)/)?.[1] || '').trim();
  return json({
    id: p.payment_id,
    number: str(p.payment_number),
    customer: str(p.customer_name),
    rep,
    amount: Number(p.amount) || 0,
    unused_amount: Number(p.unused_amount) || 0,
    date: isoDate(p.date),
    status: str(cf.cf_5d7197),
    destination: str(cf.cf_d_pos_vers),
    cheque_number: chequeNumber(cf.cf_n_cheque),
    account: str(p.account_name),
    wrong_account: transfer ? '' : wrongAccountText(str(p.account_id), str(p.account_name), str(cf.cf_d_pos_vers)),
    transfer: transfer || null,
    location: LOCATIONS[str(p.location_name).toUpperCase()] || str(p.location_name),
    deposit_date: depositDate,
    location_key: str(p.location_name).toUpperCase(),
    created_by: str(registeredBy?.display_name || registeredBy?.username) || appRegistrant(str(p.description)) || str(p.created_by_name || p.created_by),
    captured_at: str(cf.cf_3e4e94_unformatted || cf.cf_3e4e94),
    description: str(p.description),
    has_image: (p.documents || []).some((d) => IMAGE_TYPES.includes(str(d.file_type).toLowerCase())),
    drive_url: DRIVE_RE.test(drive) ? drive : '',
    invoices: (p.invoices || []).map((i) => ({
      number: str(i.invoice_number),
      date: isoDate(i.date),
      applied: Number(i.amount_applied) || 0,
      total: Number(i.total) || 0,
      balance: Number(i.balance) || 0,
    })),
    deposits: (p.deposit_details || []).map((d) => ({
      date: isoDate(d.date ?? d.deposit_date),
      account: str(d.account_name ?? d.deposit_bank_name ?? d.to_account_name),
      amount: Number(d.amount) || null,
    })),
    refunds: Array.isArray(p.payment_refunds) ? p.payment_refunds.length : 0,
    log,
    // ما يخص المدير وحده: الملف الجبائي وتنبيه الصندوق
    fiscal: isAdmin ? str(cf.cf_023de7) : undefined,
    box_alert: isAdmin ? str(cf.cf_51a7f5) : undefined,
    app: {
      lock: lock ? { state: lock.stale ? 'unknown' : lock.state, by: lock.display_name, message: lock.message, started_at: lock.started_at, finished_at: lock.finished_at } : null,
      history: isAdmin ? history : [],
      endorsement: endorsement || null,
    },
    // التسليم الذي لم يُؤكَّد يقفل التظهير، وسببه في قسم العهدة
    can_endorse: canEndorse && !custody?.to,
    custody,
    undo,
    edit,
  });
}
