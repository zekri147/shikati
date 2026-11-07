// آخر بيانات وصلت من الخادم، محفوظة على الهاتف: تُعرض فوراً عند فتح التطبيق، ثم تُحدَّث في الخلفية.
// المفتاح يحمل اسم المستخدم، فلا يرى مستخدمٌ بيانات غيره على نفس الجهاز. تُمسح كلها عند الخروج.
const PREFIX = 'shikati-cache:';
// ما هو أقدم من يومين لا يُعرض: الأفضل انتظار البيانات الجديدة
const MAX_AGE = 2 * 24 * 3600_000;

export function readCache<T>(key: string): { data: T; at: number } | null {
  try {
    const raw = localStorage.getItem(PREFIX + key);
    if (!raw) return null;
    const v = JSON.parse(raw);
    if (!v || typeof v.at !== 'number' || Date.now() - v.at > MAX_AGE) return null;
    return v;
  } catch { return null; }
}

export function writeCache(key: string, data: unknown, at = Date.now()): void {
  try { localStorage.setItem(PREFIX + key, JSON.stringify({ at, data })); } catch { /* التخزين ممتلئ أو غير متاح */ }
}

export function clearCaches(): void {
  try {
    for (let i = localStorage.length - 1; i >= 0; i--) {
      const k = localStorage.key(i);
      if (k && k.startsWith(PREFIX)) localStorage.removeItem(k);
    }
  } catch { /* غير متاح */ }
}
