import type { Env, User } from '../env';
import { HttpError, json, readJson } from '../http';
import { audit } from '../audit';
import { notifyCustody } from '../notify';

// العهدة (المرحلة الثانية من خطة التحصيل، بموافقة ZEKRI يوم 7/11/2026): من يحمل الشيك فعلياً.
// قاعدة التطبيق وحدها، ولا كتابة في زوهو. تخص الشيكات «في الحوزة» فقط.
// - التسجيل من التطبيق يجعل الشيك في عهدة من سجّله.
// - «هو في عهدتي» لشيك عهدته غير محددة. والمدير يأخذ أي شيك، لتصحيح الأخطاء.
// - «سلّمته إلى…» من الحامل أو المدير، ثم يؤكد المستلم أو يرفض. المسلِّم أو الحامل يلغي ما لم يُؤكَّد.
// - الإيداع: المندوب يودع ما في عهدته وحده، دون تسليم معلّق منه (بطلب ZEKRI يوم 9/11/2026، الفحص في deposit.ts).
//   المدير يودع أي شيك، ويرى تنبيهاً في بطاقة التأكيد إن لم يكن عنده.

const ID_RE = /^\d{10,25}$/;
export type CustodyAction = 'take' | 'give' | 'accept' | 'refuse' | 'cancel';

interface Row { payment_id: string; holder_id: number | null; to_id: number | null; by_id: number | null; since: string | null }

// ما يُعرض عن العهدة لكل شيك، بالنسبة إلى المستخدم الحالي
export interface CustodyInfo {
  holder: string | null;     // اسم الحامل، أو null إن كانت غير محددة
  mine: boolean;             // في عهدتي
  to: string | null;         // تسليم معلّق إلى…
  incoming: boolean;         // التسليم المعلّق إليّ أنا
  outgoing: boolean;         // أنا من سلّمه وينتظر التأكيد
  from: string | null;       // من سلّمه، في التسليم المعلّق
}

async function names(env: Env): Promise<Map<number, string>> {
  const { results } = await env.DB.prepare('SELECT id, display_name FROM users').all<{ id: number; display_name: string }>();
  return new Map(results.map((u) => [u.id, u.display_name]));
}

function info(r: Row | undefined, user: User, n: Map<number, string>): CustodyInfo {
  const name = (id: number | null | undefined) => (id ? n.get(id) || 'مستخدم محذوف' : null);
  return {
    holder: name(r?.holder_id),
    mine: !!r && r.holder_id === user.id,
    to: name(r?.to_id),
    incoming: !!r && r.to_id === user.id,
    outgoing: !!r && !!r.to_id && r.by_id === user.id,
    from: r?.to_id ? name(r.by_id) : null,
  };
}

// عهدة كل الشيكات، لقائمة الشيكات (تُقرأ في كل طلب، لا من التخزين المؤقت)
export async function custodyMap(env: Env, user: User): Promise<Map<string, CustodyInfo>> {
  const [{ results }, n] = await Promise.all([
    env.DB.prepare('SELECT payment_id, holder_id, to_id, by_id, since FROM custody').all<Row>(),
    names(env),
  ]);
  return new Map(results.map((r) => [r.payment_id, info(r, user, n)]));
}

// عهدة شيك واحد وما يستطيع المستخدم فعله بها، لصفحة التفاصيل
export async function custodyForDetail(env: Env, user: User, pid: string, inHand: boolean) {
  if (!inHand) return null;
  const r = await env.DB.prepare('SELECT payment_id, holder_id, to_id, by_id, since FROM custody WHERE payment_id = ?').bind(pid).first<Row>();
  const c = info(r ?? undefined, user, await names(env));
  const admin = user.role === 'admin';
  const actions: CustodyAction[] = [];
  if (c.incoming) actions.push('accept', 'refuse');
  if (r?.to_id && (c.outgoing || c.mine || admin)) actions.push('cancel');
  if (!r?.to_id && (c.mine || admin)) actions.push('give');
  if (!c.mine && !c.incoming && ((!r?.holder_id && !r?.to_id) || admin)) actions.push('take');
  return { ...c, since: r?.since || null, actions };
}

// من يمكن التسليم إليه: كل المستخدمين النشطين غيري
export async function custodyPeople(env: Env, user: User): Promise<Response> {
  const { results } = await env.DB.prepare(
    "SELECT id, display_name, role FROM users WHERE active = 1 AND id != ? ORDER BY role = 'admin', display_name",
  ).bind(user.id).all<{ id: number; display_name: string; role: string }>();
  return json({ people: results });
}

// بعد تسجيل شيك من التطبيق: في عهدة من سجّله
export async function custodyOnRegister(env: Env, user: User, pid: string): Promise<void> {
  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO custody (payment_id, holder_id, since) VALUES (?, ?, datetime('now')) " +
      "ON CONFLICT(payment_id) DO UPDATE SET holder_id = excluded.holder_id, to_id = NULL, by_id = NULL, since = excluded.since, updated_at = datetime('now')",
    ).bind(pid, user.id),
    env.DB.prepare("INSERT INTO custody_log (payment_id, action, user_id, to_id) VALUES (?, 'register', ?, ?)").bind(pid, user.id, user.id),
  ]);
}

const DONE: Record<CustodyAction, string> = {
  take: 'صار الشيك في عهدتك.',
  give: 'سُلّم الشيك، وينتظر تأكيد المستلم.',
  accept: 'استلمت الشيك، وصار في عهدتك.',
  refuse: 'رفضت الاستلام، وبقي الشيك عند من سلّمه.',
  cancel: 'أُلغي التسليم.',
};

// POST /custody { payment_id, action, to? }. كل تحديث مشروط بالحالة الحالية، فلا يتغلّب ضغطان متزامنان
export async function handleCustody(req: Request, env: Env, user: User, inHand: (pid: string) => Promise<boolean>): Promise<Response> {
  const b = await readJson<{ payment_id?: string; action?: string; to?: number }>(req);
  const pid = String(b.payment_id || '');
  const action = String(b.action || '') as CustodyAction;
  if (!ID_RE.test(pid)) throw new HttpError(400, 'معرّف الدفعة غير صالح.');
  if (!(action in DONE)) throw new HttpError(400, 'إجراء غير معروف.');
  if (!(await inHand(pid))) throw new HttpError(409, 'الشيك ليس في الحوزة، فلا عهدة له. حدّث الصفحة.');
  const admin = user.role === 'admin';
  const cur = await env.DB.prepare('SELECT payment_id, holder_id, to_id, by_id, since FROM custody WHERE payment_id = ?').bind(pid).first<Row>();
  const stale = () => new HttpError(409, 'تغيّرت عهدة الشيك قبل لحظات. حدّث الصفحة.');
  let to: number | null = null;
  let ok = false;

  if (action === 'take') {
    if (cur?.holder_id === user.id) throw new HttpError(409, 'الشيك في عهدتك من قبل.');
    if (cur?.holder_id && !admin) throw new HttpError(403, 'الشيك في عهدة غيرك. اطلب منه أن يسلّمه إليك من التطبيق.');
    if (cur?.to_id && !admin) throw new HttpError(409, 'للشيك تسليم ينتظر تأكيد المستلم.');
    const r = await env.DB.prepare(
      "INSERT INTO custody (payment_id, holder_id, since) VALUES (?, ?, datetime('now')) " +
      "ON CONFLICT(payment_id) DO UPDATE SET holder_id = excluded.holder_id, to_id = NULL, by_id = NULL, since = excluded.since, updated_at = datetime('now') " +
      'WHERE custody.holder_id IS ? AND custody.to_id IS ?',
    ).bind(pid, user.id, cur?.holder_id ?? null, cur?.to_id ?? null).run();
    ok = r.meta.changes > 0;
  } else if (action === 'give') {
    to = Number(b.to);
    if (!Number.isInteger(to) || to <= 0) throw new HttpError(400, 'اختر من سلّمته الشيك.');
    if (to === user.id) throw new HttpError(400, 'لا تسلّم الشيك لنفسك.');
    const target = await env.DB.prepare('SELECT id FROM users WHERE id = ? AND active = 1').bind(to).first();
    if (!target) throw new HttpError(400, 'المستلم غير موجود أو موقوف.');
    if (cur?.to_id) throw new HttpError(409, 'للشيك تسليم ينتظر التأكيد. ألغه أولاً.');
    if (cur?.holder_id !== user.id && !admin) throw new HttpError(403, 'تسلّم الشيك الذي في عهدتك فقط.');
    const r = await env.DB.prepare(
      "INSERT INTO custody (payment_id, holder_id, to_id, by_id, since) VALUES (?, NULL, ?, ?, datetime('now')) " +
      "ON CONFLICT(payment_id) DO UPDATE SET to_id = excluded.to_id, by_id = excluded.by_id, since = excluded.since, updated_at = datetime('now') " +
      'WHERE custody.to_id IS NULL AND custody.holder_id IS ?',
    ).bind(pid, to, user.id, cur?.holder_id ?? null).run();
    ok = r.meta.changes > 0;
  } else if (action === 'accept') {
    if (cur?.to_id !== user.id) throw stale();
    const r = await env.DB.prepare(
      "UPDATE custody SET holder_id = to_id, to_id = NULL, by_id = NULL, since = datetime('now'), updated_at = datetime('now') WHERE payment_id = ? AND to_id = ?",
    ).bind(pid, user.id).run();
    ok = r.meta.changes > 0;
  } else {
    // refuse للمستلم، وcancel لمن سلّمه أو للمدير
    if (!cur?.to_id) throw stale();
    if (action === 'refuse' && cur.to_id !== user.id) throw stale();
    if (action === 'cancel' && cur.by_id !== user.id && cur.holder_id !== user.id && !admin) throw new HttpError(403, 'يلغي التسليمَ من سلّمه أو حامل الشيك أو المدير.');
    to = cur.to_id;
    const r = await env.DB.prepare(
      "UPDATE custody SET to_id = NULL, by_id = NULL, updated_at = datetime('now') WHERE payment_id = ? AND to_id = ?",
    ).bind(pid, cur.to_id).run();
    ok = r.meta.changes > 0;
  }
  if (!ok) throw stale();

  await env.DB.prepare('INSERT INTO custody_log (payment_id, action, user_id, from_id, to_id) VALUES (?, ?, ?, ?, ?)')
    .bind(pid, action, user.id, cur?.holder_id ?? null, action === 'take' || action === 'accept' ? user.id : to).run();
  await audit(env, user, `custody.${action}`, 'ok', pid, to ? String(to) : null);
  // إشعار الهاتف: للمستلم عند التسليم، ولمن سلّمه إن رُفض. لا يُفشل العملية أبداً
  await notifyCustody(env, user, action, pid, to, cur?.by_id ?? null);
  return json({ ok: true, message: DONE[action] });
}
