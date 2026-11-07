import { useEffect, useRef, useState } from 'react';
import { reducedMotion } from '@/lib/motion';
import { cn } from '@/lib/utils';
import { fmtAmount } from '@/lib/format';

// القيم اللاتينية (أرقام، مبالغ، أسماء لاتينية) معزولة الاتجاه داخل النص العربي
export function Ltr({ children, className }: { children: React.ReactNode; className?: string }) {
  return <bdi dir="ltr" className={cn('ltr', className)}>{children}</bdi>;
}
export function Num({ children, className }: { children: React.ReactNode; className?: string }) {
  return <bdi dir="ltr" className={cn('ltr num', className)}>{children}</bdi>;
}
export function Amount({ value, className, style }: { value: number | null | undefined; className?: string; style?: React.CSSProperties }) {
  return <bdi dir="ltr" className={cn('ltr num', className)} style={style}>{fmtAmount(value)}</bdi>;
}

// مبلغ يتحرك نحو قيمته الجديدة (400 مللي ثانية) حين تتغيّر، مثل نقص المجموع بعد الإيداع.
// أول ظهور ومع «تقليل الحركة»: القيمة مباشرة دون حركة.
export function AnimatedAmount({ value, className }: { value: number; className?: string }) {
  const [shown, setShown] = useState(value);
  const from = useRef(value);
  useEffect(() => {
    const start = from.current;
    from.current = value;
    if (start === value || reducedMotion()) { setShown(value); return; }
    let raf = 0;
    const t0 = performance.now();
    const step = (t: number) => {
      const k = Math.min(1, (t - t0) / 400);
      const e = 1 - Math.pow(1 - k, 3);
      setShown(k < 1 ? Math.round(start + (value - start) * e) : value);
      if (k < 1) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [value]);
  return <Amount value={shown} className={className} />;
}
