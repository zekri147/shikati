// العمليات «بانتظار التحقق» للمدير (بطلب ZEKRI يوم 24/11/2026، بعد المراجعة الشاملة):
// كل كتابة في زوهو لها سجل في القاعدة هو أيضاً قفلها. إن انقطع الرد بعد الإرسال صار السجل «unknown»،
// وإن توقف الخادم وسط الطلب بقي «pending». في الحالتين يبقى القفل حتى يحسمه المدير بعد التحقق في زوهو.
// قبل هذا كان للإيداع وحده زر تحرير، فبقي التسجيل والتظهير وشيك المورد والتحويل مقفلة دون طريق.
// في قاعدة التطبيق وحدها: لا طلب إلى زوهو، ولا إعادة لأي كتابة.
import type { Env, User } from '../env';
import { HttpError, json, readJson } from '../http';
import { audit } from '../audit';
import { CACHE_KEY } from './constants';

// القفل «قيد التنفيذ» أقدم من هذا يُعامل كالمنقطع، كما في الإيداع
const STALE_PENDING_SEC = 300;
const STALE = `-${STALE_PENDING_SEC} seconds`;

type Kind = 'deposit' | 'collect' | 'register' | 'endorse' | 'outcheque' | 'transfer';

interface KindDef {
  table: string;
  key: string;
  label: string;
  // ما يتحقق منه المدير في زوهو قبل الحسم
  check: string;
  // الأعمدة الموحّدة للعرض
  select: string;
  // «أُنشئ في زوهو» ممكن؟ الإيداع لا: سجله المنتهي يحتاج معرّف المعاملة البنكية
  canDone: boolean;
}

const KINDS: Record<Kind, KindDef> = {
  deposit: {
    table: 'deposits', key: 'payment_id', label: 'إيداع', canDone: false,
    check: 'افتح الدفعة في زوهو: هل لها إيداع في البنك؟ حرّر القفل فقط إن لم يُنشأ، أو بعد تصحيحه يدوياً.',
    select: "payment_id AS key, display_name, customer AS party, cheque_number AS ref, amount, message, state, started_at, payment_id",
  },
  // التحصيل اليدوي أو التراجع عنه: الحالة في زوهو تقول ما حدث
  collect: {
    table: 'collections', key: 'payment_id', label: 'تحصيل يدوي', canDone: true,
    check: 'افتح الشيك في زوهو: إن كانت حالته «محصّل» فاختر «وُجد في زوهو»، وإن كانت «مودع في البنك» فحرّر القفل.',
    select: "payment_id AS key, display_name, customer AS party, cheque_number AS ref, amount, message, state, started_at, payment_id",
  },
  register: {
    table: 'registrations', key: 'request_id', label: 'تسجيل شيك', canDone: true,
    check: 'ابحث في دفعات العميل في زوهو عن رقم الشيك: هل أُنشئت الدفعة؟',
    select: "request_id AS key, display_name, customer AS party, cheque_number AS ref, amount, message, state, started_at, payment_id",
  },
  endorse: {
    table: 'endorsements', key: 'payment_id', label: 'تظهير لمورد', canDone: true,
    check: 'ابحث في دفعات المورد في زوهو عن رقم الشيك والمبلغ: هل أُنشئت دفعة المورد؟ وهل حالة الشيك «سُلّم للمورد»؟',
    select: "payment_id AS key, display_name, vendor AS party, cheque_number AS ref, amount, message, state, started_at, payment_id",
  },
  outcheque: {
    table: 'out_cheques', key: 'request_id', label: 'شيك لمورد', canDone: true,
    check: 'ابحث في دفعات المورد في زوهو عن رقم الشيك: هل أُنشئت الدفعة؟',
    select: "request_id AS key, display_name, vendor AS party, cheque_number AS ref, amount, message, state, started_at, vendor_payment_id AS payment_id",
  },
  transfer: {
    table: 'transfers', key: 'request_id', label: 'تحويل بنكي', canDone: true,
    check: 'ابحث في دفعات العميل في زوهو عن التحويل بالمبلغ والتاريخ والمرجع: هل أُنشئت الدفعة؟',
    select: "request_id AS key, display_name, customer AS party, reference AS ref, amount, message, state, started_at, payment_id",
  },
};

const WHERE = "(state = 'unknown' OR (state = 'pending' AND started_at < datetime('now', ?)))";

interface Row {
  key: string; display_name: string | null; party: string | null; ref: string | null; amount: number | null;
  message: string | null; state: string; started_at: string; payment_id: string | null;
}

export async function listStuck(env: Env): Promise<Response> {
  const items: (Row & { kind: Kind; label: string; check: string; can_done: boolean })[] = [];
  for (const [kind, d] of Object.entries(KINDS) as [Kind, KindDef][]) {
    const { results } = await env.DB.prepare(`SELECT ${d.select} FROM ${d.table} WHERE ${WHERE} ORDER BY started_at DESC LIMIT 50`)
      .bind(STALE).all<Row>();
    for (const r of results || []) items.push({ ...r, kind, label: d.label, check: d.check, can_done: d.canDone });
  }
  items.sort((a, b) => (a.started_at < b.started_at ? 1 : -1));
  return json({ items });
}

// الحسم: «لم يُنشأ شيء» يحرّر القفل فتصح محاولة جديدة، و«أُنشئ في زوهو» يغلقه كعملية تمت فيبقى الشيك محمياً من التكرار
export async function resolveStuck(req: Request, env: Env, admin: User): Promise<Response> {
  const b = await readJson<{ kind?: string; key?: string; outcome?: string }>(req);
  const kind = String(b.kind || '') as Kind;
  const d = KINDS[kind];
  const key = String(b.key || '');
  const outcome = String(b.outcome || '');
  if (!d || !/^[A-Za-z0-9_-]{6,64}$/.test(key)) throw new HttpError(400, 'طلب غير صالح.');
  if (outcome !== 'failed' && !(outcome === 'done' && d.canDone)) throw new HttpError(400, 'طلب غير صالح.');

  const note = outcome === 'done'
    ? `حسمه ${admin.display_name}: وُجد في زوهو.`
    : `حسمه ${admin.display_name}: لم يُنشأ في زوهو، فحُرّر القفل.`;
  // الإيداع: حذف السجل كما كان التحرير من قبل. الباقي: تغيير الحالة مع بقاء السجل للتاريخ
  const res = kind === 'deposit'
    ? await env.DB.prepare(`DELETE FROM deposits WHERE payment_id = ? AND ${WHERE}`).bind(key, STALE).run()
    : await env.DB.prepare(`UPDATE ${d.table} SET state = ?, message = ?, finished_at = datetime('now') WHERE ${d.key} = ? AND ${WHERE}`)
      .bind(outcome, note, key, STALE).run();
  if (!res.meta.changes) throw new HttpError(409, 'لم تعد هذه العملية بانتظار التحقق. حدّث الصفحة.');
  await env.DB.prepare('DELETE FROM cache WHERE key = ?').bind(CACHE_KEY).run();
  await audit(env, admin, kind === 'deposit' ? 'deposit.release' : 'stuck.resolve', 'ok', `${d.table} / ${key}`, `${outcome}: ${note}`);
  return json({ ok: true });
}
