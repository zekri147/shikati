import { useEffect, useRef } from 'react';

// زر الرجوع في الهاتف يغلق النافذة أو القائمة المفتوحة أولاً، ثم يرجع للشاشة السابقة.
// عند الفتح نضيف خطوة في السجل، وزر الرجوع يزيلها فيُغلق. والإغلاق من الواجهة يزيلها بنفسه.
export function useBackClose(open: boolean, close: () => void) {
  const closeRef = useRef(close);
  closeRef.current = close;
  useEffect(() => {
    if (!open) return;
    let popped = false;
    const onPop = () => { popped = true; closeRef.current(); };
    history.pushState({ overlay: true }, '');
    window.addEventListener('popstate', onPop);
    return () => {
      window.removeEventListener('popstate', onPop);
      if (!popped && history.state && history.state.overlay) history.back();
    };
  }, [open]);
}

// عمل بعد إغلاق نافذة: ننتظر رجوع خطوة النافذة في السجل أولاً، وإلا أغلق ذلك الرجوعُ ما يُفتح بعدها
export function afterOverlay(fn: () => void) {
  if (!(history.state && history.state.overlay)) { fn(); return; }
  let done = false;
  const go = () => { if (done) return; done = true; window.removeEventListener('popstate', go); fn(); };
  window.addEventListener('popstate', go);
  setTimeout(go, 400);
}

// الانتقال إلى عنوان بعد إغلاق نافذة
export function navigate(hash: string) {
  afterOverlay(() => { location.hash = hash; });
}
