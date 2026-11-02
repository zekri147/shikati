import type { Env } from '../env';
import { zohoRequest } from '../zoho';
import { isoDate } from './fields';

// تاريخ الإيداع: حقل «تاريخ الإيداع» في زوهو (cf_46404d) يكتبه التطبيق عند كل إيداع منذ 2/11/2026.
// الشيكات المودعة قبل ذلك يُقرأ تاريخها مرة واحدة من المعاملة البنكية، ويُحفظ في جدول deposit_dates.

export const DEPOSIT_DATE_FIELD = 'cf_46404d';
// تحصيل متأخر: مرّت هذه الأيام على الإيداع ولم يُحصَّل الشيك
export const COLLECT_LATE_DAYS = 7;
// حد الشيكات التي يُقرأ تاريخها من زوهو في كل تحديث للقائمة، حتى لا تبطؤ
const FETCH_LIMIT = 15;

const str = (v: unknown) => String(v ?? '').trim();

export function fieldDate(cf: Record<string, unknown> | undefined): string {
  if (!cf) return '';
  return isoDate(cf[`${DEPOSIT_DATE_FIELD}_unformatted`] || cf[DEPOSIT_DATE_FIELD]);
}

// من المعاملة البنكية للإيداع، ثم يُحفظ
async function fromBankTransaction(env: Env, pid: string, depositId?: string): Promise<string> {
  let did = str(depositId);
  if (!did) {
    const r = await zohoRequest<{ payment?: { deposit_details?: { deposit_id?: string }[] } }>(env, 'GET', `/customerpayments/${pid}`, { timeoutMs: 10_000 });
    did = str(r.data?.payment?.deposit_details?.[0]?.deposit_id);
  }
  if (!/^\d{10,25}$/.test(did)) return '';
  const t = await zohoRequest<{ banktransaction?: { date?: string } }>(env, 'GET', `/banktransactions/${did}`, { timeoutMs: 10_000 });
  const date = isoDate(t.data?.banktransaction?.date);
  if (date) {
    await env.DB.prepare('INSERT OR REPLACE INTO deposit_dates (payment_id, deposit_date, source) VALUES (?, ?, ?)')
      .bind(pid, date, 'bank_transaction').run();
  }
  return date;
}

// لصفحة التفاصيل
export async function depositDateFor(env: Env, pid: string, cf: Record<string, unknown> | undefined, depositId?: string): Promise<string> {
  const own = fieldDate(cf);
  if (own) return own;
  const row = await env.DB.prepare('SELECT deposit_date FROM deposit_dates WHERE payment_id = ?').bind(pid).first<{ deposit_date: string }>();
  if (row) return row.deposit_date;
  try {
    return await fromBankTransaction(env, pid, depositId);
  } catch {
    return '';
  }
}

// للقائمة: يكمّل تاريخ الإيداع الناقص من القاعدة، ثم من زوهو لعدد محدود في كل مرة
export async function fillDepositDates(env: Env, cheques: { id: string; deposit_date?: string }[]): Promise<void> {
  const missing = cheques.filter((c) => !c.deposit_date);
  if (!missing.length) return;
  const known = new Map<string, string>();
  for (let i = 0; i < missing.length; i += 90) {
    const ids = missing.slice(i, i + 90).map((c) => c.id);
    const { results } = await env.DB.prepare(
      `SELECT payment_id, deposit_date FROM deposit_dates WHERE payment_id IN (${ids.map(() => '?').join(',')})`,
    ).bind(...ids).all<{ payment_id: string; deposit_date: string }>();
    for (const r of results) known.set(r.payment_id, r.deposit_date);
  }
  let fetched = 0;
  for (const c of missing) {
    const d = known.get(c.id);
    if (d) { c.deposit_date = d; continue; }
    if (fetched >= FETCH_LIMIT) continue;
    fetched++;
    try {
      c.deposit_date = (await fromBankTransaction(env, c.id)) || undefined;
    } catch { /* يُحاوَل في التحديث القادم */ }
  }
}
