import type { Env } from '../env';
import { zohoGet } from '../zoho';
import { activeAdminIds, notifyUsers } from '../push';
import { STATUS } from './constants';

// إشعار التحصيل، بطلب ZEKRI يوم 3/11/2026: حين يصير الشيك «محصّلاً» (رسالة بنك AGB تفعل ذلك في زوهو)،
// يصل إشعار إلى هاتف الموظف الذي أودعه من التطبيق، وإلى المدير. إن لم يُودَع من التطبيق فللمدير وحده.
// تعمل كل 10 دقائق، وتقرأ من زوهو صفحة واحدة: آخر الشيكات تعديلاً. لا تكتب شيئاً في زوهو.

const PAGE = 50;
const BASELINE_KEY = 'collect_baseline';

interface Payment {
  payment_id: string;
  customer_name?: string;
  amount?: number;
  cf_n_cheque?: string;
  cf_5d7197?: string;
}

const fmt = (n: number) => {
  const [w, f] = Math.abs(n).toFixed(2).split('.');
  return w.replace(/\B(?=(\d{3})+(?!\d))/g, ' ') + (f === '00' ? '' : '.' + f) + ' DA';
};

export async function runCollectNotices(env: Env): Promise<{ checked: number; sent: number; baseline: boolean }> {
  const data = await zohoGet<{ customerpayments?: Payment[] }>(env, '/customerpayments', {
    filter_by: 'PaymentMode.Check', sort_column: 'last_modified_time', sort_order: 'D', per_page: PAGE,
  });
  const collected = (data.customerpayments || []).filter((p) => String(p.cf_5d7197 || '').trim() === STATUS.COLLECTED);

  // أول تشغيل: الشيكات المحصّلة من قبل لا يُرسل عنها شيء
  const base = await env.DB.prepare('SELECT value FROM app_meta WHERE key = ?').bind(BASELINE_KEY).first<{ value: string }>();
  if (!base) {
    for (const p of collected) {
      await env.DB.prepare('INSERT OR IGNORE INTO collect_notices (payment_id, sent) VALUES (?, 0)').bind(p.payment_id).run();
    }
    await env.DB.prepare("INSERT OR IGNORE INTO app_meta (key, value) VALUES (?, datetime('now'))").bind(BASELINE_KEY).run();
    return { checked: collected.length, sent: 0, baseline: true };
  }

  let sent = 0;
  const admins = await activeAdminIds(env);
  for (const p of collected) {
    // الإدخال الذري يمنع الإشعار المزدوج إن تداخل تشغيلان
    const ins = await env.DB.prepare('INSERT OR IGNORE INTO collect_notices (payment_id, sent) VALUES (?, 1)').bind(p.payment_id).run();
    if (!ins.meta.changes) continue;
    const dep = await env.DB.prepare(
      "SELECT d.user_id FROM deposits d JOIN users u ON u.id = d.user_id WHERE d.payment_id = ? AND d.state = 'done' AND u.active = 1",
    ).bind(p.payment_id).first<{ user_id: number }>();
    const to = dep ? [dep.user_id, ...admins] : admins;
    const num = String(p.cf_n_cheque || '').trim();
    sent += await notifyUsers(env, to, {
      title: 'تم تحصيل شيك',
      body: `${p.customer_name || 'عميل'}${num ? ` — الشيك ${num}` : ''} — ${fmt(Number(p.amount) || 0)}`,
      url: '/#cheques/c/' + p.payment_id,
      tag: 'collect-' + p.payment_id,
    });
  }
  return { checked: collected.length, sent, baseline: false };
}
