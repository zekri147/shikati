// ثوابت زوهو بوكس المشتركة بين قسم الشيكات ووحدة الإيداع

export const ACCOUNT_CHEQUES_IN_HAND = '7418406000000000358';

export const STATUS = {
  IN_HAND: 'في الحوزة',
  DEPOSITED: 'مودع في البنك',
  COLLECTED: 'محصّل',
  REJECTED: 'مرفوض',
} as const;

export const DEST = { AGB: 'ELONAC', ROSTOMIA: 'ROSTOMIA' } as const;

export const CACHE_KEY = 'cheques_v1';

// تاريخ اليوم بتوقيت الجزائر بصيغة YYYY-MM-DD
export function todayAlgiers(now = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Algiers' }).format(now);
}

