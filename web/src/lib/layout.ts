import { useEffect } from 'react';

// الأشرطة الثابتة أسفل الشاشة (التنقل، الإيداع، التسجيل، العمليات) تسجّل ارتفاعها هنا،
// فيترك المحتوى مسافة سفلية بقدرها، وتظهر الرسائل القصيرة فوقها. لا يختفي آخر عنصر تحتها.
const heights = new Map<symbol, number>();
function apply() {
  const total = [...heights.values()].reduce((a, b) => a + b, 0);
  document.documentElement.style.setProperty('--fixed-bottom', `${total}px`);
}
export function useFixedBottom(px: number, active = true) {
  useEffect(() => {
    if (!active) return;
    const k = Symbol('bar');
    heights.set(k, px);
    apply();
    return () => { heights.delete(k); apply(); };
  }, [px, active]);
}
