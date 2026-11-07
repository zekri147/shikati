import { cn } from '@/lib/utils';
import { fmtAmount } from '@/lib/format';

// القيم اللاتينية (أرقام، مبالغ، أسماء لاتينية) معزولة الاتجاه داخل النص العربي
export function Ltr({ children, className }: { children: React.ReactNode; className?: string }) {
  return <bdi dir="ltr" className={cn('ltr', className)}>{children}</bdi>;
}
export function Num({ children, className }: { children: React.ReactNode; className?: string }) {
  return <bdi dir="ltr" className={cn('ltr num', className)}>{children}</bdi>;
}
export function Amount({ value, className }: { value: number | null | undefined; className?: string }) {
  return <bdi dir="ltr" className={cn('ltr num', className)}>{fmtAmount(value)}</bdi>;
}
