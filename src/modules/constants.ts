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


// المواقع (الفروع) في زوهو
export const LOCATIONS: Record<string, { id: string; label: string }> = {
  ALGER: { id: '7418406000000093289', label: 'الجزائر' },
  'EL EULMA': { id: '7418406000000093098', label: 'العلمة' },
};

// قيم «البنك الساحب» كما هي في القائمة المنسدلة في زوهو
export const BANKS = [
  'AGB', 'BNA', 'BEA', 'BADR', 'BDL', 'CPA', 'CNEP', 'CNMA', 'Al Baraka', 'Al Salam', 'Trust Bank',
  'Société Générale', 'BNP Paribas', 'Natixis', 'Housing Bank', 'ABC', 'Fransabank', 'CCP', 'أخرى',
] as const;

// الوجهات، وأولها الافتراضية
export const DESTINATIONS = ['ELONAC', 'ROSTOMIA', 'Autre Fournisseur'] as const;
