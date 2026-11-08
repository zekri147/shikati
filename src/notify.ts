import type { Env, User } from './env';
import { zohoGet } from './zoho';
import { getView, LATE_DAYS } from './modules/cheques';
import { STATUS, todayAlgiers } from './modules/constants';
import { lockStates } from './modules/deposit';
import { normRep, reviewLeftByRep } from './modules/collect';
import { hasSubscribers, notifySafe, notifyUsers, type PushMessage } from './push';

// ما يُرسل من إشعارات (8/11/2026، بطلب ZEKRI). النص يذكر اسم العميل والمبلغ (اختيار ZEKRI).
// - فوراً، من الخادم عند العملية: شيك سُلّم إليك (وإن رفض المستلم، يصل من سلّمه).
// - كل ساعة من 7:00 إلى 20:00 بتوقيت الجزائر (المهمة المجدولة في wrangler.toml):
//   · شيك صار «مرفوضاً»: للمدير، ولمندوب العميل (cf_owner)، ولمن سجّله، ولمن كان في عهدته.
//   · 8:00 كل يوم: لكل من في عهدته شيكات تأخر إيداعها (أكثر من 7 أيام)، وللمدير ملخص التنبيهات.
//   · الأربعاء 18:00 والخميس 9:00: تذكير المراجعة الأسبوعية لمن بقي له عملاء لم يراجعهم.
// كل إشعار مجدول له مفتاح في notify_sent، فلا يتكرر إن تكررت المهمة. قراءة فقط من زوهو.

const MORNING_HOUR = 8;
const WED_HOUR = 18;
const THU_HOUR = 9;

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

// اسم العميل ومبلغ الشيك لنص الإشعار: من قائمة الشيكات المخزّنة، وإلا من زوهو
async function chequeBrief(env: Env, pid: string): Promise<string> {
  try {
    const view = await getView(env, false);
    const c = view.all.find((x) => x.id === pid);
    if (c) return `شيك ${c.customer} بمبلغ ${money(c.amount)}`;
  } catch { /* نكمل بنص عام */ }
  return 'شيك';
}

export async function notifyCustody(env: Env, actor: User, action: string, pid: string, to: number | null, giver: number | null): Promise<void> {
  try {
    if (action === 'give' && to) {
      const brief = await chequeBrief(env, pid);
      await notifySafe(env, [to], {
        title: 'شيك سُلّم إليك',
        body: `سلّمك ${actor.display_name} ${brief}. افتحه لتأكيد الاستلام أو رفضه.`,
        url: chequeUrl(pid), tag: 'custody-' + pid,
      });
    } else if (action === 'refuse' && giver && giver !== actor.id) {
      const brief = await chequeBrief(env, pid);
      await notifySafe(env, [giver], {
        title: 'رُفض استلام الشيك',
        body: `رفض ${actor.display_name} استلام ${brief}، فبقي عند من كان معه.`,
        url: chequeUrl(pid), tag: 'custody-' + pid,
      });
    }
  } catch (e) {
    console.error('notify custody', e instanceof Error ? e.message : e);
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

async function notifyRejected(env: Env, users: UserRow[]): Promise<void> {
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
    if (!(await claim(env, 'rejected:' + c.id))) continue;
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

async function notifyLate(env: Env, users: UserRow[], today: string): Promise<void> {
  const view = await getView(env, false);
  const late = view.all.filter((c) => c.status === STATUS.IN_HAND && c.days > LATE_DAYS);
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

// ——— الأربعاء والخميس: تذكير المراجعة الأسبوعية ———

async function notifyReview(env: Env, users: UserRow[], when: 'wed' | 'thu', now: Date, today: string): Promise<void> {
  const reps = users.filter((u) => normRep(u.rep_code));
  if (!reps.length) return;
  const { week, deadline, left } = await reviewLeftByRep(env, today);
  if (now.getTime() > deadline) return;
  for (const u of reps) {
    const n = left.get(normRep(u.rep_code)) || 0;
    if (!n || !(await claim(env, `review:${week}:${when}:${u.id}`))) continue;
    await notifyUsers(env, [u.id], {
      title: 'المراجعة الأسبوعية',
      body: `بقي لك ${customers(n)} دون مراجعة هذا الأسبوع. الأجل ${when === 'wed' ? 'غداً الخميس' : 'اليوم'} الساعة 12:00.`,
      url: '/#coll/review', tag: 'review',
    });
  }
}

// ——— المهمة المجدولة ———

async function step(name: string, fn: () => Promise<void>) {
  try { await fn(); } catch (e) { console.error('notify ' + name, e instanceof Error ? e.message : e); }
}

export async function runScheduled(env: Env, now = new Date()): Promise<void> {
  // لا طلبات إلى زوهو ما دام لم يفعّل أحد الإشعارات
  if (!(await hasSubscribers(env))) return;
  const { hour, dow } = algiersClock(now);
  const today = todayAlgiers(now);
  const users = await activeUsers(env);
  await step('rejected', () => notifyRejected(env, users));
  // «بعد الساعة» لا «في الساعة»: إن فاتت مهمة، تُرسل في التي بعدها، والمفتاح يمنع التكرار
  if (hour >= MORNING_HOUR) {
    await step('late', () => notifyLate(env, users, today));
    await step('admin', () => notifyAdmin(env, users, today));
  }
  if (dow === 3 && hour >= WED_HOUR) await step('review', () => notifyReview(env, users, 'wed', now, today));
  if (dow === 4 && hour >= THU_HOUR) await step('review', () => notifyReview(env, users, 'thu', now, today));
  // تنظيف المفاتيح القديمة
  await step('cleanup', async () => { await env.DB.prepare("DELETE FROM notify_sent WHERE at < datetime('now', '-120 days') AND key NOT LIKE 'seed:%' AND key NOT LIKE 'rejected:%'").run(); });
}
