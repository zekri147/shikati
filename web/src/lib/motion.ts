// الحركة: الانتقال بين الصفحات، والعنصر المشترك بين البطاقة ورأس الصفحة، والاهتزاز الخفيف.
// كلها تتوقف إن فعّل الموظف «تقليل الحركة» في هاتفه، أو لم يدعمها المتصفح.
export const reducedMotion = () => {
  try { return window.matchMedia('(prefers-reduced-motion: reduce)').matches; } catch { return false; }
};

type VTDoc = Document & { startViewTransition?: (cb: () => void) => { finished: Promise<void>; ready: Promise<void> } };

// الاتجاه: forward للدخول إلى صفحة تفاصيل، وback للرجوع منها، وtab للتنقل بين الشاشات
export function withTransition(dir: 'forward' | 'back' | 'tab', update: () => void) {
  const doc = document as VTDoc;
  if (!doc.startViewTransition || reducedMotion() || document.visibilityState !== 'visible') { update(); return; }
  document.documentElement.dataset.vt = dir;
  try {
    const t = doc.startViewTransition(update);
    // انتقال أُلغي (اسمان متطابقان، أو تنقل سريع): الصفحة الجديدة تُرسم دون حركة، فلا خطأ
    t.ready.catch(() => { /* دون حركة */ });
    t.finished.catch(() => { /* دون حركة */ }).finally(() => { if (document.documentElement.dataset.vt === dir) delete document.documentElement.dataset.vt; });
  } catch {
    update();
  }
}

// العنصر المشترك: اسم العميل والمبلغ في البطاقة الملموسة يأخذان اسمَي الانتقال، فينتقلان إلى رأس الصفحة.
// اسم الانتقال لا يتكرر في الصفحة، فيُزال عن أي بطاقة سابقة أولاً.
let sharedId = '';
export const isShared = (id: string) => id === sharedId;
export function markShared(id: string, root: HTMLElement | null) {
  sharedId = id;
  document.querySelectorAll<HTMLElement>('[data-vt]').forEach((el) => { el.style.viewTransitionName = ''; });
  root?.querySelectorAll<HTMLElement>('[data-vt]').forEach((el) => { el.style.viewTransitionName = 'vt-' + el.dataset.vt; });
}
export const sharedStyle = (on: boolean, name: 'amt' | 'cust'): React.CSSProperties | undefined =>
  on ? ({ viewTransitionName: 'vt-' + name } as React.CSSProperties) : undefined;

// اهتزاز خفيف في هواتف أندرويد (آيفون لا يدعمه من المتصفح): لمسة عند التحديد، ونبضتان عند نجاح الإيداع
export function haptic(kind: 'tick' | 'success' = 'tick') {
  try { if (!reducedMotion()) navigator.vibrate?.(kind === 'tick' ? 8 : [12, 60, 12]); } catch { /* غير مدعوم */ }
}
