// قراءة حقول الشيك من زوهو بصيغة موحّدة، مشتركة بين القائمة وصفحة التفاصيل

const MONTHS: Record<string, string> = {
  jan: '01', feb: '02', mar: '03', apr: '04', may: '05', jun: '06',
  jul: '07', aug: '08', sep: '09', oct: '10', nov: '11', dec: '12',
};

// زوهو يعيد التاريخ بصيغة المنظمة (05 Nov 2026) أو بصيغة ISO. نوحّدها إلى YYYY-MM-DD.
export function isoDate(v: unknown): string {
  const s = String(v ?? '').trim();
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = s.match(/^(\d{1,2})[ /-]([A-Za-z]{3})[a-z]*[ /-](\d{4})$/);
  if (m && MONTHS[m[2].toLowerCase()]) return `${m[3]}-${MONTHS[m[2].toLowerCase()]}-${m[1].padStart(2, '0')}`;
  m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (m) return `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  return '';
}

export function chequeNumber(v: unknown): string {
  const s = String(v ?? '').trim();
  return s === '0000000' || s === '0' ? '' : s;
}

const CIH = '7418406000000000358';
const ENDORSED = '7418406000009849106';
const ENDORSED_DEST = 'Autre Fournisseur';

// فحص الحساب، بنفس قاعدة دالة الحالة في زوهو: الشيك المظهّر لمورد في حساب الشيكات المظهّرة،
// والشيك بلا وجهة في أحدهما، وكل شيك آخر في حساب الحوزة. يعيد اسم الحساب المتوقع، أو فارغاً إن كان سليماً.
export function expectedAccount(accountId: string, destination: string): string {
  if (destination === ENDORSED_DEST) return accountId === ENDORSED ? '' : 'Endorsed Cheques';
  if (!destination) return accountId === CIH || accountId === ENDORSED ? '' : 'Cheques in Hand';
  return accountId === CIH ? '' : 'Cheques in Hand';
}

export function wrongAccountText(accountId: string, accountName: string, destination: string): string {
  const expected = expectedAccount(accountId, destination);
  // اسم الحساب الصحيح بالعربية كما يعرفه الموظف، واسم الحساب الحالي كما في زوهو
  const label = expected === 'Endorsed Cheques' ? 'الشيكات المظهّرة' : 'الشيكات في الحوزة';
  return expected ? `مسجّل في حساب «${accountName || 'غير معروف'}»، والصحيح حساب ${label}` : '';
}
