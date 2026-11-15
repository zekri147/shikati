import type { Env } from '../env';
import { HttpError, json } from '../http';
import { buildXlsx, type Cell } from '../xlsx';
import { ACK_REASONS } from './collcomment';
import { getSnapshot } from './collect';
import { ensureSnapshot, nextCycle, prevCycle, snapLeft } from './debtack';

// تقرير إقرار الدين للمدير (14/11/2026، بطلب ZEKRI): تبويب «الإقرار» في الإدارة، وملف إكسل للدورة نفسها.
// قراءة فقط من قاعدة التطبيق (debt_snapshot)، ومن أرصدة التحصيل المحفوظة لحساب ما حُصّل من دين الصورة حتى الآن.

const CYCLE_RE = /^\d{4}-\d{2}-\d{2}$/;
const r2 = (n: number) => Math.round(n * 100) / 100;

export interface RepSum {
  rep: string; name: string; total: number; ok: number; disputes: number; open: number; left: number;
  debt: number; remaining: number | null; collected: number | null; last: string | null;
}
export interface AckRow {
  id: string; name: string; rep: string; balance: number; prev: number | null; late: number | null; invoices: number;
  remaining: number | null; answer: string | null; reason: string | null; note: string; by: string | null; at: string | null;
  zoho: string; resolved_at: string | null; resolved_by: string | null;
}
export interface AckReport {
  cycle: string; next: string; taken_at: string; current: boolean;
  cycles: { cycle: string; taken_at: string }[];
  // أرصدة التحصيل التي حُسب منها «الباقي الآن»، أو null إن تعذّرت القراءة
  balances_at: number | null;
  reps: RepSum[]; rows: AckRow[];
}

async function buildReport(env: Env, asked: string | null): Promise<AckReport | null> {
  // صورة الدورة الحالية تُؤخذ هنا إن لم تُؤخذ بعد، كما في التحصيل
  const cs = await ensureSnapshot(env);
  const { results: cycles } = await env.DB.prepare(
    'SELECT cycle, taken_at FROM debt_cycles WHERE ready = 1 ORDER BY cycle DESC LIMIT 52',
  ).all<{ cycle: string; taken_at: string }>();
  if (!cycles?.length) return null;
  const pick = asked && CYCLE_RE.test(asked) ? cycles.find((c) => c.cycle === asked) : cycles[0];
  if (!pick) throw new HttpError(404, 'لا صورة دين لهذه الدورة.');
  const cycle = pick.cycle;

  const [{ results }, users, snap] = await Promise.all([
    env.DB.prepare(
      'SELECT s.customer_id, s.customer_name, s.rep, s.balance, s.late, s.invoices, s.answer, s.reason, s.note, s.username, s.answered_at, '
      + 's.zoho_state, s.resolved_at, s.resolved_by, p.balance AS prev '
      + 'FROM debt_snapshot s LEFT JOIN debt_snapshot p ON p.cycle = ? AND p.customer_id = s.customer_id '
      + 'WHERE s.cycle = ? ORDER BY s.rep, s.balance DESC, s.customer_name',
    ).bind(prevCycle(cycle), cycle).all<{
      customer_id: string; customer_name: string; rep: string; balance: number; late: number | null; invoices: number;
      answer: string | null; reason: string | null; note: string; username: string | null; answered_at: string | null;
      zoho_state: string; resolved_at: string | null; resolved_by: string | null; prev: number | null;
    }>(),
    env.DB.prepare('SELECT username, display_name, role, rep_code FROM users').all<{ username: string; display_name: string; role: string; rep_code: string | null }>(),
    // الأرصدة المحفوظة (دون طلب جديد إلى زوهو إن كانت حديثة). تعذّرها لا يمنع التقرير
    getSnapshot(env, false).catch(() => null),
  ]);

  const nameOf = new Map<string, string>();
  const repName = new Map<string, string>();
  for (const u of users.results || []) {
    nameOf.set(u.username, u.display_name);
    const code = (u.rep_code || '').trim().toUpperCase();
    // المندوب أولى من المدير إن تشارك الاثنان الرمز نفسه
    if (code && (!repName.has(code) || u.role === 'rep')) repName.set(code, u.display_name);
  }
  const leftOf = snap ? snapLeft(snap.customers, pick.taken_at) : null;

  const rows: AckRow[] = (results || []).map((r) => ({
    id: r.customer_id, name: r.customer_name, rep: r.rep, balance: r.balance, prev: r.prev, late: r.late, invoices: r.invoices,
    remaining: leftOf ? r2(leftOf(r.customer_id, r.balance)) : null,
    answer: r.answer, reason: r.reason, note: r.note || '', by: r.username ? nameOf.get(r.username) || r.username : null, at: r.answered_at,
    zoho: r.zoho_state, resolved_at: r.resolved_at, resolved_by: r.resolved_by ? nameOf.get(r.resolved_by) || r.resolved_by : null,
  }));

  const sums = new Map<string, RepSum>();
  for (const r of rows) {
    const s = sums.get(r.rep) || { rep: r.rep, name: repName.get(r.rep) || r.rep, total: 0, ok: 0, disputes: 0, open: 0, left: 0, debt: 0, remaining: leftOf ? 0 : null, collected: leftOf ? 0 : null, last: null };
    s.total++;
    if (r.answer === 'ok') s.ok++;
    else if (r.answer === 'dispute') { s.disputes++; if (!r.resolved_at) s.open++; }
    else s.left++;
    s.debt = r2(s.debt + r.balance);
    if (s.remaining !== null && r.remaining !== null) { s.remaining = r2(s.remaining + r.remaining); s.collected = r2(s.debt - s.remaining); }
    if (r.at && (!s.last || r.at > s.last)) s.last = r.at;
    sums.set(r.rep, s);
  }

  return {
    cycle, next: nextCycle(cycle), taken_at: pick.taken_at, current: cycle === cs.cycle,
    cycles: cycles.map((c) => ({ cycle: c.cycle, taken_at: c.taken_at })),
    balances_at: snap ? snap.at * 1000 : null,
    reps: [...sums.values()], rows,
  };
}

// GET /api/admin/ack?cycle=YYYY-MM-DD
export async function ackReport(env: Env, url: URL): Promise<Response> {
  const r = await buildReport(env, url.searchParams.get('cycle'));
  return json(r || { cycle: null, cycles: [], reps: [], rows: [] });
}

// ——— ملف إكسل ———

const ANSWER: Record<string, string> = { ok: 'أقرّ', dispute: 'اعترض' };
const ZOHO: Record<string, string> = { done: 'وصل إلى زوهو', failed: 'رفضه زوهو', unknown: 'بانتظار التحقق', pending: 'قيد الإرسال', none: 'لم يُرسل' };
const dmy = (iso: string) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}`;

// وقت القاعدة بتوقيت غرينتش، يُكتب بتوقيت الجزائر: DD/MM/YYYY HH:MM
function algiers(utc: string | null): string {
  if (!utc) return '';
  const d = new Date(utc.replace(' ', 'T') + 'Z');
  if (Number.isNaN(d.getTime())) return utc;
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Africa/Algiers', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(d).map((x) => [x.type, x.value]));
  return `${p.day}/${p.month}/${p.year} ${p.hour}:${p.minute}`;
}

const money = (v: number | null): Cell => (v === null ? '' : { v, f: 'money' });
const pct = (part: number | null, whole: number): Cell => (part === null || !whole ? '' : { v: Math.round((part / whole) * 1000) / 1000, f: 'pct' });

// GET /api/admin/ack/xlsx?cycle=YYYY-MM-DD
export async function ackReportXlsx(env: Env, url: URL): Promise<Response> {
  const r = await buildReport(env, url.searchParams.get('cycle'));
  if (!r) throw new HttpError(404, 'لا صورة دين بعد.');
  const at = r.balances_at ? algiers(new Date(r.balances_at).toISOString().slice(0, 19).replace('T', ' ')) : '';

  const sumHead = ['المندوب', 'الرمز', 'العملاء', 'أقرّ', 'اعترض', 'منها مفتوح', 'لم يُجب', 'دين الصورة', 'الباقي منه الآن', 'حُصّل', 'نسبة التحصيل', 'آخر جواب'];
  const t = r.reps.reduce((a, s) => ({
    total: a.total + s.total, ok: a.ok + s.ok, disputes: a.disputes + s.disputes, open: a.open + s.open, left: a.left + s.left,
    debt: r2(a.debt + s.debt), remaining: a.remaining === null || s.remaining === null ? null : r2(a.remaining + s.remaining),
  }), { total: 0, ok: 0, disputes: 0, open: 0, left: 0, debt: 0, remaining: r.balances_at ? 0 : null as number | null });
  const tCollected = t.remaining === null ? null : r2(t.debt - t.remaining);
  const summary: Cell[][] = [
    [{ v: `تقرير إقرار الدين: دورة السبت ${dmy(r.cycle)}`, bold: true }],
    [`صورة الدين يوم ${algiers(r.taken_at)}، والدورة التالية يوم السبت ${dmy(r.next)}.`],
    [at ? `«الباقي منه الآن» من أرصدة زوهو المحفوظة في ${at}.` : 'تعذّرت قراءة الأرصدة الآن، فلا «باقٍ» ولا «حُصّل» في هذا الملف.'],
    [],
    sumHead,
    ...r.reps.map((s): Cell[] => [s.name, s.rep, s.total, s.ok, s.disputes, s.open, s.left, money(s.debt), money(s.remaining), money(s.collected), pct(s.collected, s.debt), algiers(s.last)]),
    ['المجموع', '', t.total, t.ok, t.disputes, t.open, t.left, money(t.debt), money(t.remaining), money(tCollected), pct(tCollected, t.debt), ''],
  ];

  const detail: Cell[][] = [
    ['المندوب', 'الرمز', 'العميل', 'دين الصورة', 'دين الدورة السابقة', 'الباقي منه الآن', 'حُصّل', 'الجواب', 'سبب الاعتراض', 'الملاحظة', 'أجاب', 'وقت الجواب', 'زوهو', 'المعالجة', 'أيام التأخر', 'الفواتير'],
    ...r.rows.map((x): Cell[] => [
      r.reps.find((s) => s.rep === x.rep)?.name || x.rep, x.rep, x.name, money(x.balance), money(x.prev), money(x.remaining),
      money(x.remaining === null ? null : r2(x.balance - x.remaining)),
      x.answer ? ANSWER[x.answer] || x.answer : 'لم يُجب',
      x.answer === 'dispute' ? ACK_REASONS[x.reason || ''] || x.reason || '' : '', x.note, x.by || '', algiers(x.at),
      x.answer === 'dispute' ? ZOHO[x.zoho] || x.zoho : '',
      x.answer === 'dispute' ? (x.resolved_at ? `عولج ${algiers(x.resolved_at)}${x.resolved_by ? ' (' + x.resolved_by + ')' : ''}` : 'مفتوح') : '',
      x.late, x.invoices,
    ]),
  ];

  const file = buildXlsx([
    { name: 'الملخص', header: 5, bold: [summary.length], widths: [18, 14, 9, 8, 8, 11, 9, 16, 16, 16, 13, 18], rows: summary },
    { name: 'العملاء', header: 1, widths: [16, 14, 32, 16, 18, 16, 16, 10, 18, 36, 14, 18, 16, 26, 11, 9], rows: detail },
  ]);
  const name = `إقرار-الدين-${r.cycle}.xlsx`;
  return new Response(file, {
    headers: {
      'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'Content-Disposition': `attachment; filename="ack-${r.cycle}.xlsx"; filename*=UTF-8''${encodeURIComponent(name)}`,
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
    },
  });
}
