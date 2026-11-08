import type { Env, User } from './env';
import { HttpError, json, readJson } from './http';
import { audit } from './audit';
import { notifyUsers } from './push';

// إعدادات الإشعارات (8/11/2026، بطلب ZEKRI): المدير يشغّل كل نوع ويوقفه، ويحدد المواعيد وأيام التأخر،
// ويرسل إشعاراً يدوياً. تنطبق على كل المستخدمين معاً (اختيار ZEKRI). المهمة المجدولة تقرؤها في كل تشغيل.

export interface NotifySettings {
  handover: boolean;       // شيك سُلّم إليك، ورفض الاستلام
  rejected: boolean;       // شيك مرفوض
  late: boolean;           // شيكات تأخر إيداعها في العهدة
  review: boolean;         // تذكير إقرار الدين (كان تذكير المراجعة الأسبوعية)
  admin_daily: boolean;    // ملخص «تنبيهات اليوم» للمدير
  morning_hour: number;    // ساعة التأخر وملخص المدير، بتوقيت الجزائر
  review_hour: number;     // ساعة تذكير الإقرار
  review_days: number[];   // أيام التذكير: 0 الأحد ... 6 السبت
  late_days: number;       // الشيك متأخر بعد هذا العدد من الأيام في الحوزة
}

export const DEFAULTS: NotifySettings = {
  handover: true, rejected: true, late: true, review: true, admin_daily: true,
  morning_hour: 8, review_hour: 9, review_days: [6, 0, 1, 2, 3, 4], late_days: 7,
};
// المهمة المجدولة تعمل من 7:00 إلى 20:00 (wrangler.toml)، فلا ساعة خارجها
export const HOUR_MIN = 7;
export const HOUR_MAX = 20;
const BOOLS = ['handover', 'rejected', 'late', 'review', 'admin_daily'] as const;
const BODY_MAX = 200;

function clean(raw: Partial<NotifySettings>, base: NotifySettings): NotifySettings {
  const out = { ...base };
  for (const k of BOOLS) if (typeof raw[k] === 'boolean') out[k] = raw[k] as boolean;
  const hour = (v: unknown, d: number) => (Number.isInteger(v) && (v as number) >= HOUR_MIN && (v as number) <= HOUR_MAX ? (v as number) : d);
  out.morning_hour = hour(raw.morning_hour, base.morning_hour);
  out.review_hour = hour(raw.review_hour, base.review_hour);
  if (Array.isArray(raw.review_days)) out.review_days = [...new Set(raw.review_days.filter((d) => Number.isInteger(d) && d >= 0 && d <= 6))].sort();
  if (Number.isInteger(raw.late_days) && (raw.late_days as number) >= 1 && (raw.late_days as number) <= 60) out.late_days = raw.late_days as number;
  return out;
}

export async function getNotifySettings(env: Env): Promise<NotifySettings> {
  try {
    const row = await env.DB.prepare('SELECT value FROM notify_settings WHERE id = 1').first<{ value: string }>();
    return row ? clean(JSON.parse(row.value), DEFAULTS) : { ...DEFAULTS };
  } catch {
    return { ...DEFAULTS };
  }
}

// ‎/api/admin/notify…
export async function handleNotifyAdmin(req: Request, env: Env, admin: User, path: string): Promise<Response> {
  if (req.method === 'GET' && path === '/notify') {
    const [settings, log, people] = await Promise.all([
      getNotifySettings(env),
      env.DB.prepare(
        'SELECT m.id, m.at, m.body, m.devices, m.to_id, t.display_name AS to_name, b.display_name AS by_name FROM notify_manual m ' +
        'LEFT JOIN users t ON t.id = m.to_id LEFT JOIN users b ON b.id = m.by_id ORDER BY m.id DESC LIMIT 30',
      ).all(),
      env.DB.prepare(
        'SELECT u.id, u.display_name, u.role, (SELECT COUNT(*) FROM push_subs s WHERE s.user_id = u.id) AS devices FROM users u WHERE u.active = 1 ORDER BY u.role = \'admin\', u.display_name',
      ).all(),
    ]);
    return json({ settings, defaults: DEFAULTS, log: log.results, people: people.results, self_id: admin.id });
  }

  if (req.method === 'POST' && path === '/notify/settings') {
    const b = await readJson<Partial<NotifySettings>>(req);
    const next = clean(b, await getNotifySettings(env));
    if (!next.review_days.length && next.review) throw new HttpError(400, 'اختر يوماً واحداً على الأقل لتذكير الإقرار، أو أوقف التذكير.');
    await env.DB.prepare(
      "INSERT INTO notify_settings (id, value, updated_by) VALUES (1, ?, ?) ON CONFLICT(id) DO UPDATE SET value = excluded.value, updated_by = excluded.updated_by, updated_at = datetime('now')",
    ).bind(JSON.stringify(next), admin.id).run();
    await audit(env, admin, 'notify.settings', 'ok', null, JSON.stringify(next));
    return json({ ok: true, settings: next });
  }

  // إشعار يدوي: لمستخدم واحد أو للجميع. لا إعادة: من لم يفعّل الإشعارات لا يصله
  if (req.method === 'POST' && path === '/notify/send') {
    const b = await readJson<{ to?: number | 'all'; body?: string }>(req);
    const body = String(b.body || '').replace(/\s+/g, ' ').trim();
    if (!body) throw new HttpError(400, 'اكتب نص الإشعار.');
    if (body.length > BODY_MAX) throw new HttpError(400, `النص أطول من ${BODY_MAX} حرف.`);
    let ids: number[];
    let toId: number | null = null;
    if (b.to === 'all') {
      const { results } = await env.DB.prepare('SELECT id FROM users WHERE active = 1 AND id != ?').bind(admin.id).all<{ id: number }>();
      ids = results.map((r) => r.id);
    } else {
      toId = Number(b.to);
      const u = await env.DB.prepare('SELECT id FROM users WHERE id = ? AND active = 1').bind(toId).first();
      if (!u) throw new HttpError(400, 'المستلم غير موجود أو موقوف.');
      ids = [toId];
    }
    const r = await env.DB.prepare('INSERT INTO notify_manual (by_id, to_id, body) VALUES (?, ?, ?)').bind(admin.id, toId, body).run();
    const id = r.meta.last_row_id;
    const devices = await notifyUsers(env, ids, { title: 'رسالة من ' + admin.display_name, body, url: '/', tag: 'manual-' + id });
    await env.DB.prepare('UPDATE notify_manual SET devices = ? WHERE id = ?').bind(devices, id).run();
    await audit(env, admin, 'notify.send', devices ? 'ok' : 'error', toId ? String(toId) : 'all', body);
    return json({ ok: true, devices });
  }

  throw new HttpError(404, 'غير موجود.');
}
