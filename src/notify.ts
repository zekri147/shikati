import type { Env, User } from './env';
import { zohoGet } from './zoho';
import { getView } from './modules/cheques';
import { getNotifySettings, type NotifySettings } from './notifysettings';
import { STATUS, todayAlgiers } from './modules/constants';
import { lockStates } from './modules/deposit';
import { normRep } from './modules/collect';
import { ackLeftByRep, ensureSnapshot } from './modules/debtack';
import { hasSubscribers, notifySafe, notifyUsers, type PushMessage } from './push';

// ما يُرسل من إشعارات (8/11/2026، بطلب ZEKRI). النص يذكر اسم العميل والمبلغ (اختيار ZEKRI).
// - فوراً، من الخادم عند العملية: شيك سُلّم إليك (وحين يؤكد المستلم أو يرفض، يصل من سلّمه). التسليم لعدة شيكات بإشعار واحد.
// - صباحاً مع التأخر: تذكير المستلم بما سُلّم إليه ولم يؤكد استلامه، مرة في اليوم.
// - كل ساعة من 7:00 إلى 20:00 بتوقيت الجزائر (المهمة المجدولة في wrangler.toml):
//   · شيك صار «مرفوضاً»: للمدير، ولمندوب العميل (cf_owner)، ولمن سجّله، ولمن كان في عهدته.
//   · صباحاً (8:00 افتراضياً): لكل من في عهدته شيكات تأخر إيداعها (أكثر من 7 أيام افتراضياً)، وللمدير ملخص التنبيهات.
//   · أول مهمة في كل دورة (14 يوماً من السبت) تأخذ صورة الدين، حتى دون مشتركين في الإشعارات.
//   · 9:00 كل يوم إلا الجمعة: تذكير إقرار الدين لمن بقي له عملاء لم يُقرّ بدينهم، مرة في اليوم حتى يكمله
//     (بطلب ZEKRI يوم 8/11/2026، بدل تذكير المراجعة الأسبوعية).
// كل إشعار مجدول له مفتاح في notify_sent، فلا يتكرر إن تكررت المهمة. قراءة فقط من زوهو.

// المواعيد وتشغيل كل نوع وأيام التأخر من إعدادات المدير (src/notifysettings.ts، صفحة الإدارة)

// ——— النصوص ———

export function money(n: number): string {
  const [i, d] = (Math.round(n * 100) / 100).toFixed(2).split('.');
  return i.replace(/\B(?=(\d{3})+(?!\d))/g, ' ') + (d === '00' ? '' : ',' + d) + ' دج';
}
// العدد مع المعدود بالعربية: شيك واحد، شيكان، 3 شيكات، 11 شيكاً
function count(n: number, one: string, two: string, few: string, many: string): string {
  if (n === 1) return one;
  if (n === 2) return two;
  return `${n} ${n % 100 >= 3 && n % 100 <= 10 ? few : many}`;
}
const cheques = (n: number) => count(n, 'شيك واحد', 'شيكان', 'شيكات', 'شيكاً');
const customers = (n: number) => count(n, 'عميل واحد', 'عميلان', 'عملاء', 'عميلاً');
const days = (n: number) => count(n, 'يوم واحد', 'يومين', 'أيام', 'يوماً');
const chequeUrl = (id: string) => '/#cheques/c/' + id;

// ——— الوقت بتوقيت الجزائر ———

function algiersClock(now: Date): { hour: number; dow: number } {
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone: 'Africa/Algiers', hour: '2-digit', hourCycle: 'h23', weekday: 'short' }).formatToParts(now);
  const hour = Number(parts.find((p) => p.type === 'hour')?.value);
  const wd = parts.find((p) => p.type === 'weekday')?.value || '';
  return { hour, dow: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(wd) };
}

// يحجز مفتاح الإشعار: true للمرة الأولى فقط، حتى لو تزامنت مهمتان
async function claim(env: Env, key: string): Promise<boolean> {
  const r = await env.DB.prepare('INSERT OR IGNORE INTO notify_sent (key) VALUES (?)').bind(key).run();
  return r.meta.changes > 0;
}

interface UserRow { id: number; role: string; rep_code: string | null; display_name: string }
async function activeUsers(env: Env): Promise<UserRow[]> {
  const { results } = await env.DB.prepare('SELECT id, role, rep_code, display_name FROM users WHERE active = 1').all<UserRow>();
  return results;
}

// ——— فوراً: العهدة ———

// نص الشيكات في الإشعار: «شيك العميل بمبلغ…» لشيك واحد، و«3 شيكات مجموعها…» لأكثر،
// من قائمة الشيكات المخزّنة
async function chequesBrief(env: Env, pids: string[]): Promise<string> {
  try {
    const view = await getView(env, false);
    const list = pids.map((id) => view.all.find((x) => x.id === id)).filter((c): c is NonNullable<typeof c> => !!c);
    if (pids.length === 1 && list.length === 1) return `شيك ${list[0].customer} بمبلغ ${money(list[0].amount)}`;
    if (list.length === pids.length) return `${cheques(pids.length)} مجموعها ${money(list.reduce((t, c) => t + c.amount, 0))}`;
  } catch { /* نكمل بنص عام */ }
  return pids.length === 1 ? 'شيك' : cheques(pids.length);
}

// ‎items: الشيكات التي تمت عليها العملية، ومن سلّمها (لتأكيد الاستلام والرفض)
export async function notifyCustody(env: Env, actor: User, action: string, items: { pid: string; giver: number | null }[], to: number | null): Promise<void> {
  try {
    if (!items.length || !(await getNotifySettings(env)).handover) return;
    if (action === 'give' && to) {
      const one = items.length === 1;
      const brief = await chequesBrief(env, items.map((x) => x.pid));
      await notifySafe(env, [to], {
        title: one ? 'شيك سُلّم إليك' : 'شيكات سُلّمت إليك',
        body: `سلّمك ${actor.display_name} ${brief}. أكّد استلام${one ? 'ه' : 'ها'} في التطبيق إن كان${one ? '' : 'ت'} في يدك، ولا ${one ? 'يُودَع' : 'تُودَع'} قبل ذلك.`,
        url: '/#cheques/alerts', tag: 'custody-in',
      });
      return;
    }
    if (action !== 'accept' && action !== 'refuse') return;
    // لمن سلّمها: يعرف أن المستلم أكّد أو رفض. كل مسلِّم بإشعار يجمع شيكاته
    const byGiver = new Map<number, string[]>();
    for (const x of items) if (x.giver && x.giver !== actor.id) byGiver.set(x.giver, [...(byGiver.get(x.giver) || []), x.pid]);
    for (const [giver, pids] of byGiver) {
      const brief = await chequesBrief(env, pids);
      const one = pids.length === 1;
      await notifySafe(env, [giver], action === 'accept'
        ? { title: 'أُكّد الاستلام', body: `أكّد ${actor.display_name} استلام ${brief}، فصار${one ? '' : 'ت'} في عهدته.`, url: one ? chequeUrl(pids[0]) : '/#cheques', tag: 'custody-out' }
        : { title: 'رُفض الاستلام', body: `رفض ${actor.display_name} استلام ${brief}، فبقي${one ? '' : 'ت'} في عهدتك.`, url: one ? chequeUrl(pids[0]) : '/#cheques', tag: 'custody-out' });
    }
  } catch (e) {
    console.error('notify custody', e instanceof Error ? e.message : e);
  }
}

// ——— كل صباح: تسليم ينتظر تأكيد المستلم (بطلب ZEKRI يوم 23/11/2026) ———

async function notifyHandoverPending(env: Env, today: string): Promise<void> {
  // ما سُلّم قبل ساعة على الأقل، فلا يصل تذكير بعد التسليم بدقائق
  const { results } = await env.DB.prepare(
    "SELECT payment_id, to_id FROM custody WHERE to_id IS NOT NULL AND since <= datetime('now', '-1 hour')",
  ).all<{ payment_id: string; to_id: number }>();
  if (!results.length) return;
  const view = await getView(env, false);
  const inHand = new Map(view.all.filter((c) => c.status === STATUS.IN_HAND).map((c) => [c.id, c]));
  const byUser = new Map<number, { amount: number }[]>();
  for (const r of results) {
    const c = inHand.get(r.payment_id);
    if (c) byUser.set(r.to_id, [...(byUser.get(r.to_id) || []), c]);
  }
  for (const [uid, list] of byUser) {
    if (!(await claim(env, `handover:${today}:${uid}`))) continue;
    const one = list.length === 1;
    await notifyUsers(env, [uid], {
      title: 'استلام ينتظر تأكيدك',
      body: `${one ? 'سُلّم' : 'سُلّمت'} إليك ${cheques(list.length)} ${one ? 'بمبلغ' : 'مجموعها'} ${money(list.reduce((t, c) => t + c.amount, 0))} ولم تؤكد استلام${one ? 'ه' : 'ها'}. لا ${one ? 'يُودَع' : 'تُودَع'} قبل التأكيد.`,
      url: '/#cheques/alerts', tag: 'custody-in',
    });
  }
}

// ——— كل ساعة: الشيكات المرفوضة ———

async function customerOwner(env: Env, customerId: string | undefined): Promise<string> {
  if (!customerId) return '';
  try {
    const r = await zohoGet<{ contact?: { cf_owner?: string; custom_field_hash?: Record<string, string> } }>(env, `/contacts/${customerId}`);
    return normRep(r.contact?.cf_owner ?? r.contact?.custom_field_hash?.cf_owner);
  } catch (e) {
    console.error('notify owner', e instanceof Error ? e.message : e);
    return '';
  }
}

async function notifyRejected(env: Env, users: UserRow[], send: boolean): Promise<void> {
  const view = await getView(env, false);
  const rejected = view.all.filter((c) => c.status === STATUS.REJECTED);
  // أول تشغيل: الشيكات المرفوضة من قبل لا تُرسل، فلا يصل سيل إشعارات قديمة
  if (!(await env.DB.prepare("SELECT 1 FROM notify_sent WHERE key = 'seed:rejected'").first())) {
    await env.DB.batch([
      ...rejected.map((c) => env.DB.prepare('INSERT OR IGNORE INTO notify_sent (key) VALUES (?)').bind('rejected:' + c.id)),
      env.DB.prepare("INSERT OR IGNORE INTO notify_sent (key) VALUES ('seed:rejected')"),
    ]);
    return;
  }
  const admins = users.filter((u) => u.role === 'admin').map((u) => u.id);
  for (const c of rejected) {
    if (!(await claim(env, 'rejected:' + c.id)) || !send) continue;
    const to = new Set(admins);
    const owner = await customerOwner(env, c.customer_id);
    if (owner) for (const u of users) if (normRep(u.rep_code) === owner) to.add(u.id);
    const reg = await env.DB.prepare("SELECT user_id FROM registrations WHERE payment_id = ? AND state = 'done'").bind(c.id).first<{ user_id: number | null }>();
    if (reg?.user_id) to.add(reg.user_id);
    const held = await env.DB.prepare('SELECT holder_id FROM custody WHERE payment_id = ?').bind(c.id).first<{ holder_id: number | null }>();
    if (held?.holder_id) to.add(held.holder_id);
    await notifyUsers(env, to, {
      title: 'شيك مرفوض',
      body: `رُفض شيك ${c.customer}${c.cheque_number ? ' رقم ' + c.cheque_number : ''} بمبلغ ${money(c.amount)}. تابعه مع العميل.`,
      url: chequeUrl(c.id), tag: 'rejected-' + c.id,
    });
  }
}

// ——— 8:00: الشيكات التي تأخر إيداعها، لكل من هي في عهدته ———

async function notifyLate(env: Env, users: UserRow[], today: string, lateDays: number): Promise<void> {
  const view = await getView(env, false);
  const late = view.all.filter((c) => c.status === STATUS.IN_HAND && c.days > lateDays);
  if (!late.length) return;
  const { results } = await env.DB.prepare('SELECT payment_id, holder_id FROM custody WHERE holder_id IS NOT NULL').all<{ payment_id: string; holder_id: number }>();
  const holder = new Map(results.map((r) => [r.payment_id, r.holder_id]));
  for (const u of users) {
    const mine = late.filter((c) => holder.get(c.id) === u.id).sort((a, b) => b.days - a.days);
    if (!mine.length || !(await claim(env, `late:${today}:${u.id}`))) continue;
    const total = mine.reduce((s, c) => s + c.amount, 0);
    const msg: PushMessage = mine.length === 1
      ? { title: 'شيك تأخر إيداعه', body: `شيك ${mine[0].customer} بمبلغ ${money(mine[0].amount)} في عهدتك منذ ${days(mine[0].days)} ولم يُودَع.`, url: chequeUrl(mine[0].id) }
      : { title: 'شيكات تأخر إيداعها', body: `في عهدتك ${cheques(mine.length)} تأخر إيداعها، مجموعها ${money(total)}. أقدمها: ${mine[0].customer} منذ ${days(mine[0].days)}.`, url: '/#cheques' };
    await notifyUsers(env, [u.id], { ...msg, tag: 'late' });
  }
}

// ——— 8:00: ملخص تنبيهات المدير ———

const ADMIN_LINES: [string, string][] = [
  ['unknown_lock', 'إيداع بانتظار التحقق'],
  ['rejected', 'شيكات مرفوضة'],
  ['endorse_incomplete', 'تظهير لم يكتمل'],
  ['collect_late', 'مودعة في AGB ولم تُحصَّل'],
  ['late', 'في الحوزة منذ أكثر من 7 أيام'],
  ['wrong_account', 'في حساب خطأ في زوهو'],
  ['box', 'صندوق غير مطابق'],
  ['reviews', 'مراجعات لم تصل إلى زوهو'],
];

async function notifyAdmin(env: Env, users: UserRow[], today: string): Promise<void> {
  const admins = users.filter((u) => u.role === 'admin');
  if (!admins.length) return;
  const view = await getView(env, false);
  const ids = new Map<string, Set<string>>();
  const add = (k: string, id: string) => { if (!ids.has(k)) ids.set(k, new Set()); ids.get(k)!.add(id); };
  for (const a of view.alerts) add(a.kind, a.id);
  for (const [id, state] of Object.entries(await lockStates(env))) if (state === 'unknown') add('unknown_lock', id);
  const unsent = await env.DB.prepare("SELECT COUNT(*) AS n FROM coll_reviews WHERE zoho_state != 'done'").first<{ n: number }>();
  const lines = ADMIN_LINES
    .map(([k, label]) => [label, k === 'reviews' ? unsent?.n || 0 : ids.get(k)?.size || 0] as const)
    .filter(([, n]) => n > 0)
    .map(([label, n]) => `${label}: ${n}`);
  if (!lines.length) return;
  for (const a of admins) {
    if (!(await claim(env, `admin:${today}:${a.id}`))) continue;
    await notifyUsers(env, [a.id], { title: 'تنبيهات اليوم', body: lines.join('\n'), url: '/#cheques/alerts', tag: 'admin-daily' });
  }
}

// ——— كل يوم إلا الجمعة: تذكير إقرار الدين حتى يكمله ———

async function notifyAck(env: Env, users: UserRow[], today: string): Promise<void> {
  const reps = users.filter((u) => normRep(u.rep_code));
  if (!reps.length) return;
  const { taken_at, left } = await ackLeftByRep(env);
  if (!taken_at) return;
  for (const u of reps) {
    const n = left.get(normRep(u.rep_code)) || 0;
    // مرة واحدة في اليوم لكل مندوب، ما دام له عملاء دون إقرار
    if (!n || !(await claim(env, `ack:${today}:${u.id}`))) continue;
    await notifyUsers(env, [u.id], {
      title: 'إقرار الدين',
      body: u.role === 'admin'
        ? `صورة ديون عملائك جاهزة: بقي ${customers(n)} دون إقرار.`
        : `صورة ديون عملائك جاهزة: بقي ${customers(n)} دون إقرار. أكمله لتفتح باقي التطبيق.`,
      url: '/#coll/ack', tag: 'ack',
    });
  }
}

// ——— المهمة المجدولة ———

async function step(name: string, fn: () => Promise<void>) {
  try { await fn(); } catch (e) { console.error('notify ' + name, e instanceof Error ? e.message : e); }
}

export async function runScheduled(env: Env, now = new Date()): Promise<void> {
  // صورة الدين: في أول مهمة من الدورة، فتكون الصورة نفسها لكل المندوبين
  await step('snapshot', async () => { await ensureSnapshot(env, todayAlgiers(now)); });
  // سجل العمليات: يُحفظ سنة واحدة (24/11/2026)، حتى لا يكبر دون حد
  await step('audit', async () => { await env.DB.prepare("DELETE FROM audit_log WHERE at < datetime('now', '-365 days')").run(); });
  // لا طلبات أخرى إلى زوهو ما دام لم يفعّل أحد الإشعارات
  if (!(await hasSubscribers(env))) return;
  const { hour, dow } = algiersClock(now);
  const today = todayAlgiers(now);
  const users = await activeUsers(env);
  const cfg: NotifySettings = await getNotifySettings(env);
  // المرفوض يُفحص دائماً: إن كان متوقفاً تُحفظ مفاتيحه دون إرسال، فلا يصل سيل قديم عند تشغيله
  await step('rejected', () => notifyRejected(env, users, cfg.rejected));
  // «بعد الساعة» لا «في الساعة»: إن فاتت مهمة، تُرسل في التي بعدها، والمفتاح يمنع التكرار
  if (hour >= cfg.morning_hour) {
    if (cfg.late) await step('late', () => notifyLate(env, users, today, cfg.late_days));
    if (cfg.admin_daily) await step('admin', () => notifyAdmin(env, users, today));
    if (cfg.handover_remind) await step('handover', () => notifyHandoverPending(env, today));
  }
  if (cfg.review && cfg.review_days.includes(dow) && hour >= cfg.review_hour) await step('ack', () => notifyAck(env, users, today));
  // تنظيف المفاتيح القديمة
  await step('cleanup', async () => { await env.DB.prepare("DELETE FROM notify_sent WHERE at < datetime('now', '-120 days') AND key NOT LIKE 'seed:%' AND key NOT LIKE 'rejected:%'").run(); });
}
