import type { Env } from '../env';
import { json } from '../http';
import { zohoRequest, ZohoTimeout } from '../zoho';
import { fetchAllChequePayments } from './cheques';
import { DEST, STATUS } from './constants';

// مطابقة أسبوع التشغيل المتوازي (للمدير، قراءة فقط):
// 1. كل إيداع سجّله التطبيق: هل هو موجود في زوهو وحالته صحيحة؟
// 2. شيكات AGB المودعة في زوهو دون أن يسجّلها التطبيق (من القسم القديم أو يدوياً).

const DAYS = 7;

interface AppDeposit {
  payment_id: string;
  display_name: string | null;
  customer: string | null;
  cheque_number: string | null;
  amount: number | null;
  bank_txn_id: string | null;
  finished_at: string | null;
}

export async function handleReconcile(env: Env): Promise<Response> {
  const { results: appDeposits } = await env.DB.prepare(
    "SELECT payment_id, display_name, customer, cheque_number, amount, bank_txn_id, finished_at FROM deposits " +
    "WHERE state = 'done' AND started_at >= datetime('now', ?) ORDER BY started_at DESC",
  ).bind(`-${DAYS} days`).all<AppDeposit>();

  // 1. التحقق من كل إيداع سجّله التطبيق
  const checked = [];
  for (const d of appDeposits) {
    let problem: string | null = null;
    let status = '';
    try {
      const r = await zohoRequest<{ payment?: { deposit_details?: { deposit_id?: string }[]; custom_field_hash?: Record<string, string> } }>(
        env, 'GET', `/customerpayments/${d.payment_id}`,
      );
      const p = r.data?.payment;
      if (!r.data || r.data.code !== 0 || !p) {
        problem = 'تعذّرت قراءة الدفعة من زوهو';
      } else {
        status = String(p.custom_field_hash?.cf_5d7197 || '').trim();
        const deposits = p.deposit_details || [];
        if (!deposits.length) problem = 'لا يوجد إيداع مرتبط بالدفعة في زوهو';
        else if (deposits.length > 1) problem = `للدفعة ${deposits.length} إيداعات في زوهو`;
        else if (status !== STATUS.DEPOSITED && status !== STATUS.COLLECTED) problem = `الحالة في زوهو «${status || 'فارغة'}»`;
      }
    } catch (e) {
      problem = e instanceof ZohoTimeout ? 'زوهو لم يرد' : 'خطأ أثناء القراءة';
    }
    checked.push({ ...d, status, ok: !problem, problem });
  }

  // 2. شيكات AGB المودعة أو المحصّلة مؤخراً ولم يسجّلها التطبيق
  const known = new Set(appDeposits.map((d) => d.payment_id));
  const since = Date.now() - DAYS * 86_400_000;
  const outside = (await fetchAllChequePayments(env))
    .filter((p) => (p.cf_d_pos_vers || '').trim() === DEST.AGB)
    .filter((p) => [STATUS.DEPOSITED, STATUS.COLLECTED].includes((p.cf_5d7197 || '').trim() as typeof STATUS.DEPOSITED))
    .filter((p) => Date.parse(p.last_modified_time || '') >= since)
    .filter((p) => !known.has(p.payment_id))
    .map((p) => ({
      payment_id: p.payment_id,
      customer: p.customer_name,
      cheque_number: (p.cf_n_cheque || '').trim(),
      amount: p.amount,
      status: (p.cf_5d7197 || '').trim(),
      modified: p.last_modified_time,
    }))
    .sort((a, b) => String(b.modified).localeCompare(String(a.modified)));

  return json({
    days: DAYS,
    generated_at: new Date().toISOString(),
    app: { count: checked.length, problems: checked.filter((c) => !c.ok).length, items: checked },
    outside: { count: outside.length, items: outside },
  });
}
