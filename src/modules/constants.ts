// ثوابت زوهو بوكس المشتركة بين قسم الشيكات ووحدة الإيداع

export const ACCOUNT_CHEQUES_IN_HAND = '7418406000000000358';
export const ACCOUNT_ENDORSED = '7418406000009849106';

export const STATUS = {
  IN_HAND: 'في الحوزة',
  DEPOSITED: 'مودع في البنك',
  COLLECTED: 'محصّل',
  REJECTED: 'مرفوض',
  ENDORSED: 'مظهّر لمورد',
  RETURNED: 'مُعاد للعميل',
  GUARANTEE: 'شيك ضمان',
} as const;

export const DEST = { AGB: 'ELONAC', ROSTOMIA: 'ROSTOMIA' } as const;

export const CACHE_KEY = 'cheques_v2';

// تاريخ اليوم بتوقيت الجزائر بصيغة YYYY-MM-DD
export function todayAlgiers(now = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Algiers' }).format(now);
}

