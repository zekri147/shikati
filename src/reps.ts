// إضافة المندوبين من زوهو (10/11/2026، بطلب ZEKRI): رموز الحقل «Owner» (cf_owner) على العملاء
// تُقرأ من أرصدة التحصيل (صلاحية قراءة العملاء الموجودة)، وكل رمز ليس له مستخدم يُعرض للمدير.
// الإنشاء في قاعدة التطبيق وحدها، لا كتابة في زوهو. الرمز السري يولّده الخادم ويُعرض للمدير مرة واحدة.
import type { Env, User } from './env';
import { HttpError, json, readJson } from './http';
import { hashPassword } from './crypto';
import { audit } from './audit';
import { getSnapshot, normRep } from './modules/collect';

// رموز لا يُنشأ لها مندوب (اختيار ZEKRI يوم 10/11/2026): رمزه هو، وبدر أولى. «بدون مالك» ليس رمزاً لاتينياً فيُستبعد وحده.
const EXCLUDED = new Set(['ZEKRI BEN HADJ', 'BADR AOULA']);
const REP_CODE_RE = /^[A-Z][A-Z0-9 _-]{1,31}$/;
// الاسم الظاهر بالعربية للرموز المعروفة، وإلا الرمز نفسه
const NAMES: Record<string, string> = { AMINE: 'أمين', ZAKARIA: 'زكرياء', SMAIL: 'إسماعيل', YACINE: 'ياسين', BRAHIM: 'إبراهيم' };
// حروف لا تختلط ببعضها عند القراءة (لا 0 وO ولا 1 وl وI)
const PW_CHARS = 'abcdefghjkmnpqrstuvwxyz23456789';

export interface MissingRep { code: string; display_name: string; username: string; customers: number }

function genPassword(len = 10): string {
  const bytes = crypto.getRandomValues(new Uint8Array(len));
  // 256 ليس مضاعفاً لـ 31، فالانحياز ضئيل جداً ولا يضر رمزاً يغيّره المدير متى شاء
  return [...bytes].map((b) => PW_CHARS[b % PW_CHARS.length]).join('');
}

async function missingReps(env: Env): Promise<MissingRep[]> {
  const snap = await getSnapshot(env, false);
  const counts = new Map<string, number>();
  for (const c of snap.customers) {
    const code = normRep(c.owner);
    if (!code || !REP_CODE_RE.test(code) || EXCLUDED.has(code)) continue;
    counts.set(code, (counts.get(code) || 0) + 1);
  }
  const { results } = await env.DB.prepare('SELECT username, rep_code FROM users').all<{ username: string; rep_code: string | null }>();
  const haveCode = new Set((results || []).map((u) => normRep(u.rep_code)).filter(Boolean));
  const taken = new Set((results || []).map((u) => u.username));
  const out: MissingRep[] = [];
  for (const [code, customers] of [...counts].sort((a, b) => b[1] - a[1])) {
    if (haveCode.has(code)) continue;
    const base = code.toLowerCase().replace(/[^a-z0-9]+/g, '.').replace(/^\.|\.$/g, '').slice(0, 30) || 'rep';
    let username = base;
    for (let i = 2; taken.has(username); i++) username = `${base}${i}`;
    taken.add(username);
    out.push({ code, display_name: NAMES[code] || code, username, customers });
  }
  return out;
}

// GET /api/admin/reps
export async function listMissingReps(env: Env): Promise<Response> {
  try {
    return json({ reps: await missingReps(env) });
  } catch (e) {
    console.error('missing reps', e instanceof Error ? e.message : e);
    throw new HttpError(502, 'تعذّرت قراءة المندوبين من زوهو. حاول بعد دقيقة.');
  }
}

// POST /api/admin/reps { codes } — ينشئ الرموز المطلوبة التي ما زالت بلا مستخدم فقط، فلا تكرار مع الضغط المزدوج
export async function importReps(req: Request, env: Env, admin: User): Promise<Response> {
  const b = await readJson<{ codes?: unknown }>(req);
  const asked = new Set((Array.isArray(b.codes) ? b.codes : []).map(normRep));
  if (!asked.size) throw new HttpError(400, 'لا مندوبين للإضافة.');
  let missing: MissingRep[];
  try {
    missing = (await missingReps(env)).filter((r) => asked.has(r.code));
  } catch {
    throw new HttpError(502, 'تعذّرت قراءة المندوبين من زوهو. لم يُضف أحد، حاول بعد دقيقة.');
  }
  const created: (MissingRep & { password: string })[] = [];
  for (const r of missing) {
    const password = genPassword();
    const pw = await hashPassword(password);
    try {
      await env.DB.prepare(
        "INSERT INTO users (username, display_name, role, rep_code, pw_hash, pw_salt, pw_iter) VALUES (?, ?, 'rep', ?, ?, ?, ?)",
      ).bind(r.username, r.display_name, r.code, pw.hash, pw.salt, pw.iter).run();
    } catch {
      continue; // اسم الدخول أُخذ للتو في طلب آخر: يبقى في القائمة ويُضاف في المرة التالية
    }
    await audit(env, admin, 'user.create', 'ok', r.username, `rep ${r.code} (من زوهو)`);
    created.push({ ...r, password });
  }
  return json({ created });
}
