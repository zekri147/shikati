import { useEffect, useRef, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import { cn } from '@/lib/utils';
import { haptic } from '@/lib/motion';

// السحب للتحديث: في أعلى القائمة يسحب الموظف الشاشة للأسفل بإبهامه، فيظهر مؤشر تحت الشريط العلوي.
// بعد 56 بكسل يكفي أن يترك ليبدأ التحديث. لا يعمل أثناء نافذة مفتوحة أو بعد تمرير الصفحة.
const TRIGGER = 56;

export function PullToRefresh({ onRefresh, busy, disabled }: { onRefresh: () => void; busy: boolean; disabled?: boolean }) {
  const [dy, setDy] = useState(0);
  const [pulled, setPulled] = useState(false);
  const cb = useRef(onRefresh);
  cb.current = onRefresh;

  useEffect(() => { if (!busy) setPulled(false); }, [busy]);

  useEffect(() => {
    if (disabled) return;
    let y0 = -1;
    let d = 0;
    let armed = false;
    const start = (e: TouchEvent) => {
      y0 = window.scrollY <= 0 && e.touches.length === 1 && !document.querySelector('[role="dialog"]') ? e.touches[0].clientY : -1;
      d = 0; armed = false;
    };
    const move = (e: TouchEvent) => {
      if (y0 < 0) return;
      if (window.scrollY > 0) { y0 = -1; setDy(0); return; }
      d = Math.min(Math.max(0, e.touches[0].clientY - y0) * 0.5, 80);
      if (d >= TRIGGER && !armed) { armed = true; haptic(); }
      if (d < TRIGGER) armed = false;
      setDy(d);
    };
    const end = () => {
      if (y0 >= 0 && d >= TRIGGER) { setPulled(true); cb.current(); }
      y0 = -1; d = 0; setDy(0);
    };
    window.addEventListener('touchstart', start, { passive: true });
    window.addEventListener('touchmove', move, { passive: true });
    window.addEventListener('touchend', end, { passive: true });
    window.addEventListener('touchcancel', end, { passive: true });
    return () => {
      window.removeEventListener('touchstart', start);
      window.removeEventListener('touchmove', move);
      window.removeEventListener('touchend', end);
      window.removeEventListener('touchcancel', end);
    };
  }, [disabled]);

  const loading = pulled && busy;
  if (!dy && !loading) return null;
  const ready = dy >= TRIGGER;
  return (
    <div aria-live="polite" className="pointer-events-none fixed inset-x-0 z-[25] flex justify-center top-[calc(60px+env(safe-area-inset-top))]"
      style={{ transform: `translateY(${loading ? 8 : dy - 24}px)`, opacity: loading ? 1 : Math.min(1, dy / TRIGGER) }}>
      <div className={cn('cut-sm flex items-center gap-2 bg-bar px-3 py-2 text-sm font-semibold text-white ring-1 ring-line-on-dark', ready && !loading && 'ring-white')}>
        <RefreshCw aria-hidden className={cn('size-4', loading && 'animate-spin')} style={loading ? undefined : { transform: `rotate(${dy * 4}deg)` }} />
        <span>{loading ? 'جارٍ التحديث…' : ready ? 'اترك للتحديث' : 'اسحب للتحديث'}</span>
      </div>
    </div>
  );
}
