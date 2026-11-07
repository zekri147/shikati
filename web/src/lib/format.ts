// صيغ العرض: المبالغ بفاصل مسافة للآلاف ووحدة DA، والتواريخ يوم/شهر/سنة بتوقيت الجزائر.

export function fmtAmount(n: number | null | undefined): string {
  if (n === null || n === undefined || Number.isNaN(Number(n))) return '—';
  const v = Number(n);
  const [whole, frac] = Math.abs(v).toFixed(2).split('.');
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
  return (v < 0 ? '-' : '') + grouped + (frac === '00' ? '' : '.' + frac) + ' DA';
}

export function fmtDate(iso: string | null | undefined): string {
  if (!iso) return '—';
  const [y, m, d] = iso.slice(0, 10).split('-');
  return `${d}/${m}/${y}`;
}

// وقت السجل مخزّن بتوقيت غرينتش؛ يُعرض بتوقيت الجزائر: DD/MM/YYYY HH:MM
export function fmtDateTime(utc: string): string {
  const d = new Date(utc.replace(' ', 'T') + 'Z');
  if (Number.isNaN(d.getTime())) return utc;
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Africa/Algiers', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(d).map((x) => [x.type, x.value]));
  return `${p.day}/${p.month}/${p.year} ${p.hour}:${p.minute}`;
}

// تاريخ مختصر في البطاقة: دون السنة إن كانت السنة الحالية
export function shortDate(iso: string | null | undefined): string {
  if (!iso) return '—';
  const full = fmtDate(iso);
  return iso.slice(0, 4) === String(new Date().getFullYear()) ? full.slice(0, 5) : full;
}

export function todayIso(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export const round2 = (n: number) => Math.round(n * 100) / 100;
export const sum = <T extends { amount: number }>(items: T[]) => round2(items.reduce((s, c) => s + c.amount, 0));
export const norm = (s: unknown) => String(s || '').toLowerCase().replace(/\s+/g, ' ').trim();

export function parseAmount(s: string): number | null {
  const v = Number(String(s || '').replace(/[\s ]/g, '').replace(',', '.'));
  return Number.isFinite(v) && v > 0 ? round2(v) : null;
}

// ——— صيغ العدد بالعربية ———
const word = (n: number, one: string, two: string, few: string, many: string) =>
  n === 1 ? one : n === 2 ? two : n <= 10 ? `${n} ${few}` : `${n} ${many}`;

// عدد الشيكات: رفعاً (شيكان) أو جرّاً بعد «إيداع» (شيكين)
export const chequeWord = (n: number, gen = false) => word(n, 'شيك واحد', gen ? 'شيكين' : 'شيكان', 'شيكات', 'شيكاً');
export const customersWord = (n: number) => word(n, 'عميل واحد', 'عميلان', 'عملاء', 'عميلاً');
export const invoicesWord = (n: number) => word(n, 'فاتورة واحدة', 'فاتورتان', 'فواتير', 'فاتورة');
export const daysWord = (n: number) => word(n, 'يوماً واحداً', 'يومين', 'أيام', 'يوماً');

export function daysText(n: number): string {
  if (n === 0) return 'اليوم';
  if (n === 1) return 'منذ يوم';
  if (n === 2) return 'منذ يومين';
  if (n <= 10) return `منذ ${n} أيام`;
  return `منذ ${n} يوماً`;
}

// مدة بالأيام دون «منذ»: يوم واحد، يومان، 9 أيام، 17 يوماً
export function daysCount(n: number): string {
  if (n === 1) return 'يوم واحد';
  if (n === 2) return 'يومان';
  if (n <= 10) return `${n} أيام`;
  return `${n} يوماً`;
}

export function relTime(ts: number): string {
  const m = Math.floor((Date.now() - ts) / 60_000);
  if (m < 1) return 'الآن';
  if (m === 1) return 'منذ دقيقة';
  if (m === 2) return 'منذ دقيقتين';
  if (m <= 10) return `منذ ${m} دقائق`;
  if (m < 60) return `منذ ${m} دقيقة`;
  return 'منذ أكثر من ساعة';
}

export const newRequestId = () =>
  crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
