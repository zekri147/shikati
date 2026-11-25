// التحصيل اليدوي لشيكات ELONAC المودعة في بنك AGB، للمدير وحده (بطلب ZEKRI وموافقته يوم 24/11/2026):
// تحصيلها الآلي من رسائل البنك (دالة encaisser_cheque_sms_agb في زوهو) لا يعمل حالياً.
// يكتب ما تكتبه تلك الدالة للشيك المودع: الحالة «محصّل» وسطر في سجل الدفعة، باسم المدير وبتاريخ التحصيل.
// لا إيداع ولا معاملة بنكية: الشيك مودع من قبل. والرستمية لا تتحوّل إلى «محصّل».
// التراجع عنه في undo.ts (النوع collect): الحالة تعود «مودع في البنك»، للتحصيل اليدوي وحده.
// ومنذ 24/11/2026 (بطلب ZEKRI) التحويل البنكي من عميل أيضاً: يُسجَّل «مودع في البنك» في حساب البنك مباشرة،
// في AGB أو CPA أو الرستمية، دون إيداع، فيُحصَّل هنا بالكتابة نفسها.
// لا إعادة تلقائية بعد طلب الكتابة: إن انقطع الرد صار السجل «unknown» حتى يحسمه المدير في «التحقق».
import type { Env, User } from '../env';
import { HttpError, json, readJson } from '../http';
import { zohoRequest, ZohoTimeout } from '../zoho';
import { audit } from '../audit';
import { fieldDate } from './depositdate';
import { isoDate } from './fields';
import { CACHE_KEY, DEST, NO_RETRY_PREFIX, STATUS, todayAlgiers } from './constants';
import { transferBankLabel } from './transfer';

const STALE_PENDING_SEC = 300;
const PAYMENT_ID_RE = /^\d{10,25}$/;

// سطر السجل: «YYYY-MM-DD — تحصيل يدوي [بتاريخ YYYY-MM-DD] من تطبيق ميداني (الاسم)».
// يقرؤه التراجع ليعرف أن آخر تحصيل يدوي، لا من رسالة البنك
export const MANUAL_LINE_RE = /^\d{4}-\d{2}-\d{2}\s*—\s*تحصيل يدوي(?:\s|$)/m;
export const MANUAL_UNDO_TEXT = 'تراجع عن التحصيل اليدوي';

export type CollectState = 'pending' | 'done' | 'failed' | 'unknown';

const str = (v: unknown) => String(v ?? '').trim();

interface Payment {
  payment_id: string;
  customer_name?: string;
  amount?: number;
  date?: string;
  payment_mode?: string;
  account_id?: string;
  deposit_details?: { date?: string; deposit_date?: string; deposit_bank_id?: string }[];
  custom_field_hash?: Record<string, string>;
}

// حالات القفل لقائمة «بانتظار التحصيل»: الشيك المقفل لا يُحدَّد
export async function collectLocks(env: Env): Promise<Record<string, CollectState>> {
  const { results } = await env.DB.prepare(
    "SELECT payment_id, state, (state = 'pending' AND started_at < datetime('now', ?)) AS stale FROM collections WHERE state IN ('pending', 'unknown')",
  ).bind(`-${STALE_PENDING_SEC} seconds`).all<{ payment_id: string; state: CollectState; stale: number }>();
  const out: Record<string, CollectState> = {};
  for (const r of results) out[r.payment_id] = r.stale ? 'unknown' : r.state;
  return out;
}

// تحصيل أو تراجع عنه لم تُعرف نتيجته: لا كتابة جديدة على هذا الشيك حتى يحسمه المدير
export async function collectUnsettled(env: Env, pid: string): Promise<boolean> {
  return !!(await env.DB.prepare("SELECT 1 FROM collections WHERE payment_id = ? AND state IN ('pending', 'unknown')").bind(pid).first());
}

const LOCKED: Record<string, string> = {
  pending: 'تحصيل هذا الشيك قيد التنفيذ الآن. انتظر قليلاً ثم حدّث الصفحة.',
  unknown: 'محاولة سابقة لتحصيل هذا الشيك لم تُعرف نتيجتها. تحقق في زوهو، ثم احسمها في الإدارة من تبويب «التحقق».',
  done: 'سُجّل تحصيل هذا الشيك من قبل في التطبيق.',
};

export async function handleCollect(req: Request, env: Env, user: User): Promise<Response> {
  if (user.role !== 'admin') throw new HttpError(403, 'التحصيل اليدوي للمدير وحده.');
  const b = await readJson<{ payment_id?: string; date?: string }>(req);
  const pid = str(b.payment_id);
  if (!PAYMENT_ID_RE.test(pid)) throw new HttpError(400, 'معرّف الدفعة غير صالح.');
  const today = todayAlgiers();
  const date = str(b.date || today);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || date > today) throw new HttpError(400, 'تاريخ التحصيل غير صالح: لا يكون بعد اليوم.');

  // 1. القفل: إدخال ذرّي، لا ينجح إلا إن لم يوجد سطر، أو كان السابق «فشل» (أو تُرُوجع عنه) أو «تم».
  // «تم» يُعاد أخذه لأن الحالة تُقرأ من زوهو قبل الكتابة: إن أُرجعت فيه يدوياً إلى «مودع في البنك» صحّ التحصيل من جديد،
  // وإلا رُفض بـ«محصّل من قبل». الحماية من اللمسة المزدوجة هي «قيد التنفيذ»
  const lock = await env.DB.prepare(
    "INSERT INTO collections (payment_id, state, user_id, username, display_name, collect_date) VALUES (?, 'pending', ?, ?, ?, ?) " +
    "ON CONFLICT(payment_id) DO UPDATE SET state = 'pending', user_id = excluded.user_id, username = excluded.username, " +
    "display_name = excluded.display_name, collect_date = excluded.collect_date, started_at = datetime('now'), " +
    "finished_at = NULL, message = NULL WHERE collections.state IN ('failed', 'done')",
  ).bind(pid, user.id, user.username, user.display_name, date).run();
  if (!lock.meta.changes) {
    const row = await env.DB.prepare(
      "SELECT state, (state = 'pending' AND started_at < datetime('now', ?)) AS stale FROM collections WHERE payment_id = ?",
    ).bind(`-${STALE_PENDING_SEC} seconds`, pid).first<{ state: string; stale: number }>();
    const state = row?.stale ? 'unknown' : row?.state || 'pending';
    await audit(env, user, 'collect', 'denied', pid, `locked:${state}`);
    throw new HttpError(409, LOCKED[state] || LOCKED.pending);
  }

  let info: { customer?: string; cheque?: string; amount?: number } = {};
  const finish = async (state: CollectState, message: string) => {
    await env.DB.prepare(
      "UPDATE collections SET state = ?, message = ?, customer = ?, cheque_number = ?, amount = ?, finished_at = datetime('now') WHERE payment_id = ?",
    ).bind(state, message, info.customer ?? null, info.cheque ?? null, info.amount ?? null, pid).run();
    await env.DB.prepare('DELETE FROM cache WHERE key = ?').bind(CACHE_KEY).run();
    await audit(env, user, 'collect', state === 'done' ? 'ok' : state === 'failed' ? 'denied' : 'error',
      `${pid} / ${info.cheque ?? ''}`, `${state}: ${date}: ${message}`);
  };
  const fail = async (status: number, message: string): Promise<never> => {
    await finish('failed', message);
    throw new HttpError(status, message);
  };

  // 2. قراءة الشيك من زوهو، والتحقق من أنه مودع في AGB ولم يُحصَّل
  let pr;
  try {
    pr = await zohoRequest<{ payment?: Payment }>(env, 'GET', `/customerpayments/${pid}`, { timeoutMs: 15_000 });
  } catch (e) {
    if (e instanceof ZohoTimeout) return fail(504, 'زوهو لم يرد. لم يتغيّر شيء، ويمكنك المحاولة مجدداً.');
    await finish('failed', 'خطأ قبل التحصيل');
    throw e;
  }
  const p = pr.data?.payment;
  if (!pr.data || pr.data.code !== 0 || !p) return fail(502, 'تعذّرت قراءة الشيك من زوهو. لم يتغيّر شيء.');
  const cf = p.custom_field_hash || {};
  const status = str(cf.cf_5d7197);
  const chq = str(cf.cf_n_cheque);
  info = { customer: str(p.customer_name), cheque: chq, amount: Number(p.amount) || 0 };

  // التحويل البنكي: إيداعه سُجّل معه (تاريخه في الحقل)، أو في حساب البنك مباشرة (الشكل القديم، تاريخه يوم وصوله)
  const transfer = !!transferBankLabel(p);
  const what = transfer ? 'التحويل' : 'الشيك';
  if (transfer) info.cheque = '';

  if (status === STATUS.COLLECTED) return fail(409, `هذا ${what} محصّل من قبل.`);
  if (status !== STATUS.DEPOSITED) return fail(409, `حالة ${what} «${status || 'فارغة'}» وليست «${STATUS.DEPOSITED}».`);
  let depositDate: string;
  if (transfer) {
    depositDate = fieldDate(cf) || isoDate(p.date);
  } else {
    if (str(cf.cf_d_pos_vers) !== DEST.AGB) return fail(409, 'التحصيل اليدوي لشيكات ELONAC في بنك AGB وحدها.');
    const deposits = p.deposit_details || [];
    if (!deposits.length) return fail(409, 'لا إيداع لهذا الشيك في زوهو، فلا يُحصَّل قبل إيداعه.');
    depositDate = fieldDate(cf) || isoDate(deposits[0].date ?? deposits[0].deposit_date);
  }
  if (depositDate && date < depositDate) {
    return fail(400, `تاريخ التحصيل قبل تاريخ ${transfer ? 'التحويل' : 'الإيداع'} (${depositDate.split('-').reverse().join('/')}). صحّحه.`);
  }

  // 3. الكتابة: الحالة وسطر السجل معاً، مرة واحدة
  const old = str(cf.cf_fffaad);
  const line = `${today} — تحصيل يدوي${date !== today ? ` بتاريخ ${date}` : ''} من تطبيق ميداني (${user.display_name})`;
  let up;
  try {
    up = await zohoRequest(env, 'PUT', `/customerpayments/${pid}`, {
      body: { custom_fields: [
        { api_name: 'cf_5d7197', value: STATUS.COLLECTED },
        { api_name: 'cf_fffaad', value: old ? `${old}\n${line}` : line },
      ] },
    });
  } catch (e) {
    if (!(e instanceof ZohoTimeout)) { await finish('unknown', 'خطأ بعد إرسال التحصيل'); throw e; }
    up = null;
  }
  if (!up || !up.data) {
    const msg = `${NO_RETRY_PREFIX} طلب التحصيل. لا تعد المحاولة: افتح ${what} في زوهو، فإن كانت حالته «${STATUS.COLLECTED}» فقد تم، ثم احسمه في الإدارة من تبويب «التحقق».`;
    await finish('unknown', msg);
    throw new HttpError(504, msg);
  }
  if (up.data.code !== 0) return fail(502, `زوهو رفض التحصيل: ${str(up.data.message || up.data.code).slice(0, 200)}. لم يتغيّر شيء.`);

  await finish('done', 'تم التحصيل');
  return json({ ok: true, message: `حُصّل ${transfer ? 'تحويل' : 'شيك'} ${info.customer}، وصارت حالته «${STATUS.COLLECTED}».` });
}
