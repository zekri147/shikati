// التخزين المحلي قد يكون غير متاح (نافذة خاصة)، فكل قراءة وكتابة محمية
export function load(key: string, fallback = ''): string {
  try { return localStorage.getItem(key) ?? fallback; } catch { return fallback; }
}
export function save(key: string, value: string): void {
  try { localStorage.setItem(key, value); } catch { /* التخزين غير متاح */ }
}
