import type { Env, User } from '../env';
import { HttpError, json, readJson } from '../http';
import { audit } from '../audit';
import { todayAlgiers } from './constants';
import { getSnapshot, needsReview, normRep } from './collect';
import { ACK_REASONS, ackCommentText, postAckComment, type CommentResult } from './collcomment';

// إقرار الدين (8/11/2026، بطلب ZEKRI)، بدل المراجعة الأسبوعية:
// - كل 14 يوماً من السبت تُؤخذ صورة لديون العملاء المدينين لكل مندوب (debt_snapshot)، ولا تتغير طوال الدورة.
//   تُؤخذ في أول مهمة مجدولة في الدورة، أو عند أول طلب قبلها. الديون الجديدة تدخل الصورة التالية.
// - المندوب يمر على عملائه عميلاً بعد عميل: «الدين صحيح» يُحفظ في التطبيق وحده،
//   و«فيه خطأ» بسبب يُكتب تعليقاً على العميل في زوهو (collcomment.ts، بموافقة ZEKRI يوم 8/11/2026).
// - التطبيق مقفل على المندوب حتى ينهي إقراره، إلا تسجيل الشيك (القفل في الواجهة). المدير لا يُقفل عليه.

const ANCHOR = '2026-11-07';   // سبت بداية الدورة الأولى
const CYCLE_DAYS = 14;
const DAY = 86_400_000;
const ID_RE = /^\d{10,25}$/;
const NOTE_MAX = 400;
// أقل رصيد يدخل الصورة (بطلب ZEKRI يوم 8/11/2026): ما دونه لا يحتاج إقراراً
export const MIN_BALANCE = 1000;

const addDays = (iso: string, n: number) => new Date(Date.parse(iso + 'T12:00:00Z') + n * DAY).toISOString().slice(0, 10);

// سبت بداية الدورة التي فيها اليوم (بتوقيت الجزائر)
export function cycleOf(today: string): string {
  const days = Math.round((Date.parse(today + 'T12:00:00Z') - Date.parse(ANCHOR + 'T12:00:00Z')) / DAY);
  return addDays(ANCHOR, Math.floor(days / CYCLE_DAYS) * CYCLE_DAYS);
}
export const nextCycle = (cycle: string) => addDays(cycle, CYCLE_DAYS);
const prevCycle = (cycle: string) => addDays(cycle, -CYCLE_DAYS);

export interface CycleState { cycle: string; next: string; state: 'ready' | 'pending' | 'error'; taken_at: string | null }

// صورة الدورة: تُؤخذ مرة واحدة. القفل في debt_cycles يمنع أخذها مرتين، ويُحرَّر بعد دقيقتين إن توقف من أخذه.
export async function ensureSnapshot(env: Env, today = todayAlgiers()): Promise<CycleState> {
  const cycle = cycleOf(today);
  const base = { cycle, next: nextCycle(cycle) };
  const row = await env.DB.prepare('SELECT ready, taken_at FROM debt_cycles WHERE cycle = ?').bind(cycle).first<{ ready: number; taken_at: string | null }>();
  if (row?.ready) return { ...base, state: 'ready', taken_at: row.taken_at };
  const claim = await env.DB.prepare(
    "INSERT INTO debt_cycles (cycle) VALUES (?) ON CONFLICT(cycle) DO UPDATE SET claimed_at = datetime('now') " +
    "WHERE debt_cycles.ready = 0 AND debt_cycles.claimed_at < datetime('now', '-2 minutes')",
  ).bind(cycle).run();
  if (!claim.meta.changes) return { ...base, state: 'pending', taken_at: null };
  try {
    const snap = await getSnapshot(env, true);
    const rows = snap.customers.filter((c) => needsReview(c) && c.balance >= MIN_BALANCE);
    const stmts = [env.DB.prepare('DELETE FROM debt_snapshot WHERE cycle = ?').bind(cycle)];
    // عشرة عملاء في كل أمر: حد المتغيرات في الأمر الواحد
    for (let i = 0; i < rows.length; i += 10) {
      const part = rows.slice(i, i + 10);
      stmts.push(env.DB.prepare('INSERT INTO debt_snapshot (cycle, customer_id, rep, customer_name, balance, late, invoices) VALUES '
        + part.map(() => '(?, ?, ?, ?, ?, ?, ?)').join(', '))
        .bind(...part.flatMap((c) => [cycle, c.id, c.owner, c.name, c.balance, c.late, c.invoices.length])));
    }
    stmts.push(env.DB.prepare("UPDATE debt_cycles SET ready = 1, taken_at = datetime('now') WHERE cycle = ?").bind(cycle));
    await env.DB.batch(stmts);
    const t = await env.DB.prepare('SELECT taken_at FROM debt_cycles WHERE cycle = ?').bind(cycle).first<{ taken_at: string }>();
    return { ...base, state: 'ready', taken_at: t?.taken_at || null };
  } catch (e) {
    console.error('debt snapshot', e instanceof Error ? e.message : e);
    // يُحرَّر القفل، فتُؤخذ الصورة في الطلب التالي
    try { await env.DB.prepare("UPDATE debt_cycles SET claimed_at = datetime('now', '-1 hour') WHERE cycle = ? AND ready = 0").bind(cycle).run(); } catch { /* لا شيء */ }
    return { ...base, state: 'error', taken_at: null };
  }
}

interface AckRow {
  cycle: string; customer_id: string; rep: string; customer_name: string; balance: number; late: number | null; invoices: number;
  answer: string | null; reason: string | null; note: string; username: string | null; answered_at: string | null;
  zoho_state: string; zoho_error: string | null;
}
const COLS = 'cycle, customer_id, rep, customer_name, balance, late, invoices, answer, reason, note, username, answered_at, zoho_state, zoho_error';

async function takenAt(env: Env, cycle: string): Promise<string> {
  const r = await env.DB.prepare('SELECT taken_at FROM debt_cycles WHERE cycle = ?').bind(cycle).first<{ taken_at: string | null }>();
  return r?.taken_at || '';
}

// ——— المندوب: حالته في الدورة (للقفل والإشعار)، وقائمته ———

async function counts(env: Env, cycle: string, rep: string) {
  const r = await env.DB.prepare(
    "SELECT COUNT(*) AS total, COUNT(answer) AS done, COALESCE(SUM(answer = 'dispute'), 0) AS disputes FROM debt_snapshot WHERE cycle = ? AND rep = ?",
  ).bind(cycle, rep).first<{ total: number; done: number; disputes: number }>();
  return { total: r?.total || 0, done: r?.done || 0, disputes: r?.disputes || 0 };
}

export async function ackStatus(env: Env, user: User): Promise<Response> {
  const own = normRep(user.rep_code);
  const cs = await ensureSnapshot(env);
  if (!own || cs.state !== 'ready') return json({ ...cs, total: 0, done: 0, disputes: 0 });
  return json({ ...cs, ...(await counts(env, cs.cycle, own)) });
}

// قائمة المندوب في الصورة، الأكبر ديناً أولاً، مع رصيد كل عميل في الصورة السابقة
export async function ackList(env: Env, user: User): Promise<Response> {
  const own = normRep(user.rep_code);
  const cs = await ensureSnapshot(env);
  if (!own || cs.state !== 'ready') return json({ ...cs, can_ack: !!own, had_prev: false, rows: [] });
  const prev = prevCycle(cs.cycle);
  const [{ results }, had, now] = await Promise.all([
    env.DB.prepare(
      'SELECT s.customer_id AS id, s.customer_name AS name, s.balance AS balance, s.late AS late, s.invoices AS invoices, '
      + 's.answer AS answer, s.reason AS reason, s.note AS note, s.answered_at AS at, s.zoho_state AS zoho, s.zoho_error AS error, p.balance AS prev '
      + 'FROM debt_snapshot s LEFT JOIN debt_snapshot p ON p.cycle = ? AND p.customer_id = s.customer_id '
      + 'WHERE s.cycle = ? AND s.rep = ? ORDER BY s.balance DESC, s.customer_name',
    ).bind(prev, cs.cycle, own).all(),
    env.DB.prepare('SELECT ready FROM debt_cycles WHERE cycle = ?').bind(prev).first<{ ready: number }>(),
    // الرصيد الآن وفواتيره، ليتحقق المندوب قبل أن يقرّ (من أرصدة التحصيل المحفوظة، دون طلب جديد غالباً)
    getSnapshot(env, false).catch(() => null),
  ]);
  const cur = new Map((now?.customers || []).map((c) => [c.id, c]));
  const rows = (results || []).map((r) => {
    const c = cur.get(String(r.id));
    return { ...r, now: c ? c.balance : 0, opening: c ? c.opening : 0, inv: c ? c.invoices : [] };
  });
  return json({ ...cs, can_ack: true, rep: own, had_prev: !!had?.ready, now_ok: !!now, rows });
}

// ——— الجواب: إقرار أو اعتراض ———

// الاعتراض المرسل إلى زوهو (أو المنقطع) لا يُغيَّر. الإقرار يصير اعتراضاً متى شاء المندوب في الدورة نفسها.
const CHANGEABLE = "(answer IS NULL OR answer = 'ok' OR zoho_state IN ('none', 'failed'))";

export async function saveAck(req: Request, env: Env, user: User): Promise<Response> {
  const b = await readJson<{ cycle?: string; customer_id?: string; answer?: string; reason?: string; note?: string }>(req);
  const id = String(b.customer_id || '');
  if (!ID_RE.test(id)) throw new HttpError(400, 'العميل غير صالح.');
  const own = normRep(user.rep_code);
  if (!own) throw new HttpError(403, 'الإقرار للمندوب صاحب العميل فقط.');
  const cycle = cycleOf(todayAlgiers());
  // الشاشة فُتحت في دورة سابقة: لا يُسجَّل جواب على صورة لم يرها المندوب
  if (b.cycle && b.cycle !== cycle) throw new HttpError(409, 'بدأت صورة دين جديدة. أعد فتح شاشة الإقرار.');
  const row = await env.DB.prepare('SELECT rep, customer_name FROM debt_snapshot WHERE cycle = ? AND customer_id = ?').bind(cycle, id).first<{ rep: string; customer_name: string }>();
  if (!row || row.rep !== own) throw new HttpError(403, 'هذا العميل ليس في صورة دين عملائك لهذه الدورة.');
  const busy = () => new HttpError(409, 'اعتراضك على هذا العميل أُرسل إلى زوهو، فلا يُغيَّر. إن كان خطأ، أبلغ المدير.');

  if (b.answer === 'ok') {
    const r = await env.DB.prepare(
      "UPDATE debt_snapshot SET answer = 'ok', reason = NULL, note = '', user_id = ?, username = ?, answered_at = datetime('now'), zoho_state = 'skip', zoho_error = NULL "
      + `WHERE cycle = ? AND customer_id = ? AND ${CHANGEABLE}`,
    ).bind(user.id, user.username, cycle, id).run();
    if (!r.meta.changes) throw busy();
    return json({ ok: true, answer: 'ok' });
  }
  // التراجع عن الإقرار (بطلب ZEKRI يوم 8/11/2026): يعود العميل «لم يُجب» في الدورة نفسها، فيعود القفل حتى يجيب.
  // الإقرار وحده: الاعتراض المكتوب في زوهو لا يُتراجع عنه من التطبيق.
  if (b.answer === 'clear') {
    const r = await env.DB.prepare(
      "UPDATE debt_snapshot SET answer = NULL, reason = NULL, note = '', user_id = NULL, username = NULL, answered_at = NULL, zoho_state = 'skip', zoho_error = NULL "
      + "WHERE cycle = ? AND customer_id = ? AND answer = 'ok'",
    ).bind(cycle, id).run();
    if (!r.meta.changes) throw new HttpError(409, 'لا إقرار تتراجع عنه لهذا العميل.');
    await audit(env, user, 'coll.ack.undo', 'ok', row.customer_name);
    return json({ ok: true, answer: null });
  }
  if (b.answer !== 'dispute') throw new HttpError(400, 'الجواب غير صالح.');
  const reason = String(b.reason || '');
  if (!ACK_REASONS[reason]) throw new HttpError(400, 'اختر سبب الاعتراض.');
  const note = String(b.note ?? '').replace(/\s+/g, ' ').trim().slice(0, NOTE_MAX);
  if (reason === 'other' && !note) throw new HttpError(400, 'اكتب سبب الاعتراض في الملاحظة.');
  const r = await env.DB.prepare(
    "UPDATE debt_snapshot SET answer = 'dispute', reason = ?, note = ?, user_id = ?, username = ?, answered_at = datetime('now'), zoho_state = 'none', zoho_error = NULL "
    + `WHERE cycle = ? AND customer_id = ? AND ${CHANGEABLE}`,
  ).bind(reason, note, user.id, user.username, cycle, id).run();
  if (!r.meta.changes) throw busy();
  await audit(env, user, 'coll.dispute', 'ok', row.customer_name, reason);
  const sent = await sendDispute(env, user, cycle, id);
  return json({ ok: true, answer: 'dispute', zoho: sent.state, error: sent.error });
}

// إرسال الاعتراض تعليقاً على العميل في زوهو. القفل: الصف يصير «pending» بتحديث ذري، فلا يُرسل تعليقان.
async function sendDispute(env: Env, actor: User, cycle: string, id: string): Promise<{ state: string; error?: string }> {
  const lock = await env.DB.prepare(
    "UPDATE debt_snapshot SET zoho_state = 'pending', zoho_error = NULL WHERE cycle = ? AND customer_id = ? AND answer = 'dispute' AND zoho_state IN ('none', 'failed')",
  ).bind(cycle, id).run();
  if (!lock.meta.changes) throw new HttpError(409, 'هذا الاعتراض أُرسل إلى زوهو أو قيد الإرسال.');
  const row = await env.DB.prepare(`SELECT ${COLS} FROM debt_snapshot WHERE cycle = ? AND customer_id = ?`).bind(cycle, id).first<AckRow>();
  if (!row) throw new HttpError(404, 'الاعتراض غير موجود.');
  let result: CommentResult;
  try {
    result = await postAckComment(env, { ...row, reason: row.reason || '', taken_at: await takenAt(env, cycle) });
  } catch (e) {
    // خطأ قبل الإرسال (رمز الوصول مثلاً): زوهو لم يستقبل شيئاً
    result = { state: 'failed', error: e instanceof HttpError ? e.publicMessage : 'تعذّر الاتصال بزوهو' };
  }
  if (result.state === 'done') {
    await env.DB.prepare("UPDATE debt_snapshot SET zoho_state = 'done', zoho_comment_id = ?, zoho_error = NULL WHERE cycle = ? AND customer_id = ?")
      .bind(result.comment_id, cycle, id).run();
  } else {
    await env.DB.prepare('UPDATE debt_snapshot SET zoho_state = ?, zoho_error = ? WHERE cycle = ? AND customer_id = ?')
      .bind(result.state, result.error, cycle, id).run();
  }
  await audit(env, actor, 'coll.dispute.comment', result.state === 'done' ? 'ok' : 'error', row.customer_name,
    result.state === 'done' ? undefined : `${result.state}: ${result.error}`);
  return result.state === 'done' ? { state: 'done' } : { state: result.state, error: result.error };
}

// ——— لقائمة التحصيل: جواب كل عميل في صورة الدورة ———

export async function ackItems(env: Env, cycle: string, rep?: string) {
  const sql = 'SELECT customer_id, answer, reason, note, answered_at, username, zoho_state FROM debt_snapshot WHERE cycle = ?' + (rep ? ' AND rep = ?' : '');
  const stmt = rep ? env.DB.prepare(sql).bind(cycle, rep) : env.DB.prepare(sql).bind(cycle);
  const { results } = await stmt.all<{ customer_id: string; answer: string | null; reason: string | null; note: string; answered_at: string | null; username: string | null; zoho_state: string }>();
  const out: Record<string, { answer: string | null; reason: string | null; note: string; at: string | null; by: string | null; zoho: string }> = {};
  for (const r of results || []) out[r.customer_id] = { answer: r.answer, reason: r.reason, note: r.note, at: r.answered_at, by: r.username, zoho: r.zoho_state };
  return out;
}

// ——— للمدير: تقدّم كل مندوب، والاعتراضات، وما لم يصل إلى زوهو، والدورات الماضية ———

export async function ackAdmin(env: Env, cycle: string) {
  const [prog, disputes, unsent, hist] = await Promise.all([
    env.DB.prepare(
      "SELECT rep, COUNT(*) AS total, COUNT(answer) AS done, COALESCE(SUM(answer = 'dispute'), 0) AS disputes, MAX(answered_at) AS last "
      + 'FROM debt_snapshot WHERE cycle = ? GROUP BY rep ORDER BY rep',
    ).bind(cycle).all<{ rep: string; total: number; done: number; disputes: number; last: string | null }>(),
    // الاعتراضات المفتوحة من كل الدورات، حتى يعلّمها المدير «عولج»
    env.DB.prepare(
      `SELECT ${COLS} FROM debt_snapshot WHERE answer = 'dispute' AND resolved_at IS NULL ORDER BY cycle DESC, answered_at DESC LIMIT 200`,
    ).all<AckRow>(),
    env.DB.prepare(
      `SELECT ${COLS} FROM debt_snapshot WHERE answer = 'dispute' AND zoho_state != 'done' ORDER BY cycle DESC, answered_at DESC LIMIT 200`,
    ).all<AckRow>(),
    env.DB.prepare(
      "SELECT cycle, rep, COUNT(*) AS total, COUNT(answer) AS done, COALESCE(SUM(answer = 'dispute'), 0) AS disputes "
      + 'FROM debt_snapshot WHERE cycle < ? GROUP BY cycle, rep ORDER BY cycle DESC, rep LIMIT 60',
    ).bind(cycle).all<{ cycle: string; rep: string; total: number; done: number; disputes: number }>(),
  ]);
  const taken = new Map<string, string>();
  for (const r of unsent.results || []) if (!taken.has(r.cycle)) taken.set(r.cycle, await takenAt(env, r.cycle));
  const cycles = new Map<string, { cycle: string; reps: { rep: string; total: number; done: number; disputes: number }[] }>();
  for (const r of hist.results || []) {
    const c = cycles.get(r.cycle) || { cycle: r.cycle, reps: [] };
    c.reps.push({ rep: r.rep, total: r.total, done: r.done, disputes: r.disputes });
    cycles.set(r.cycle, c);
  }
  return {
    progress: prog.results || [],
    disputes: (disputes.results || []).map((r) => ({ cycle: r.cycle, id: r.customer_id, name: r.customer_name, rep: r.rep, balance: r.balance, reason: r.reason, note: r.note, at: r.answered_at, zoho: r.zoho_state })),
    unsent: (unsent.results || []).map((r) => ({
      cycle: r.cycle, id: r.customer_id, name: r.customer_name, rep: r.rep, state: r.zoho_state, error: r.zoho_error,
      text: ackCommentText({ ...r, reason: r.reason || '', taken_at: taken.get(r.cycle) || '' }),
    })),
    history: [...cycles.values()].slice(0, 6),
  };
}

function adminTarget(b: { cycle?: string; customer_id?: string }) {
  const cycle = String(b.cycle || '');
  const id = String(b.customer_id || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(cycle) || !ID_RE.test(id)) throw new HttpError(400, 'الاعتراض غير صالح.');
  return { cycle, id };
}

// إرسال اعتراض لم يُرسل أو رفضه زوهو. لا يشمل «unknown»: يحتاج تحقق المدير أولاً.
export async function ackAdminSend(req: Request, env: Env, user: User): Promise<Response> {
  const { cycle, id } = adminTarget(await readJson(req));
  return json({ ok: true, ...(await sendDispute(env, user, cycle, id)) });
}

// بعد أن يتحقق المدير في زوهو من اعتراض انقطع رده: موجود (يُقفل) أو غير موجود (يصير قابلاً للإرسال)
export async function ackAdminResolve(req: Request, env: Env, user: User): Promise<Response> {
  const b = await readJson<{ cycle?: string; customer_id?: string; found?: boolean }>(req);
  const { cycle, id } = adminTarget(b);
  const r = await env.DB.prepare(
    "UPDATE debt_snapshot SET zoho_state = ?, zoho_error = ? WHERE cycle = ? AND customer_id = ? AND answer = 'dispute' AND zoho_state IN ('unknown', 'pending')",
  ).bind(b.found ? 'done' : 'failed', b.found ? null : 'تحقق المدير: غير موجود في زوهو', cycle, id).run();
  if (!r.meta.changes) throw new HttpError(409, 'هذا الاعتراض ليس بانتظار التحقق.');
  await audit(env, user, 'coll.dispute.resolve', 'ok', id, b.found ? 'found' : 'not_found');
  return json({ ok: true });
}

// «عولج»: المدير يغلق الاعتراض بعد تصحيحه، في التطبيق وحده
export async function ackAdminClose(req: Request, env: Env, user: User): Promise<Response> {
  const { cycle, id } = adminTarget(await readJson(req));
  const r = await env.DB.prepare(
    "UPDATE debt_snapshot SET resolved_at = datetime('now'), resolved_by = ? WHERE cycle = ? AND customer_id = ? AND answer = 'dispute' AND resolved_at IS NULL",
  ).bind(user.username, cycle, id).run();
  if (!r.meta.changes) throw new HttpError(409, 'هذا الاعتراض مغلق من قبل.');
  await audit(env, user, 'coll.dispute.close', 'ok', id);
  return json({ ok: true });
}

// ——— للإشعارات (src/notify.ts): كم بقي لكل مندوب دون إقرار في صورة الدورة ———

export async function ackLeftByRep(env: Env): Promise<{ cycle: string; taken_at: string | null; left: Map<string, number> }> {
  const cs = await ensureSnapshot(env);
  const left = new Map<string, number>();
  if (cs.state !== 'ready') return { cycle: cs.cycle, taken_at: null, left };
  const { results } = await env.DB.prepare('SELECT rep, COUNT(*) AS n FROM debt_snapshot WHERE cycle = ? AND answer IS NULL GROUP BY rep')
    .bind(cs.cycle).all<{ rep: string; n: number }>();
  for (const r of results || []) left.set(r.rep, r.n);
  return { cycle: cs.cycle, taken_at: cs.taken_at, left };
}
