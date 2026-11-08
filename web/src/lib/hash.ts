import { useSyncExternalStore } from 'react';
import { flushSync } from 'react-dom';
import { withTransition } from './motion';

// العنوان بعد # يحدد الشاشة. يُقرأ كقيمة تتغيّر مع كل تنقل.
// كل تغيير يمر بالانتقال بين الصفحات: الصفحة الجديدة تُرسم داخل الانتقال (flushSync)، فيلتقط المتصفح الصورتين.
let current = typeof location !== 'undefined' ? location.hash : '';
const subs = new Set<() => void>();
// موضع التمرير لكل عنوان، يُحفظ لحظة مغادرته قبل رسم الصفحة الجديدة، فيعود إليه الرجوع
const scrolls = new Map<string, number>();
export const savedScroll = (h: string) => scrolls.get(h) || 0;
// العمق: صفحات التفاصيل (#cheques/c/… و#coll/c/…) أعمق من القوائم والتبويبات
const depth = (h: string) => (/\/c\//.test(h) ? 1 : 0);

if (typeof window !== 'undefined') {
  // موضع التمرير يعيده التطبيق نفسه، فلا يتدخل المتصفح
  try { history.scrollRestoration = 'manual'; } catch { /* غير مدعوم */ }
  window.addEventListener('hashchange', () => {
    const next = location.hash;
    if (next === current) return;
    scrolls.set(current, window.scrollY);
    const a = depth(current);
    const b = depth(next);
    withTransition(b > a ? 'forward' : b < a ? 'back' : 'tab', () => {
      flushSync(() => { current = next; subs.forEach((s) => s()); });
    });
  });
}

// تبديل العنوان دون انتقال ولا سطر جديد في سجل الرجوع: لشاشة البداية عند فتح التطبيق
export function replaceHash(next: string) {
  if (next === current) return;
  history.replaceState(history.state, '', next);
  current = next;
  subs.forEach((s) => s());
}

export function useHash(): string {
  return useSyncExternalStore((cb) => { subs.add(cb); return () => { subs.delete(cb); }; }, () => current);
}
