import * as React from 'react';
import * as C from '@radix-ui/react-collapsible';
import { ChevronLeft } from 'lucide-react';
import { cn } from '@/lib/utils';

// قسم مطوي (Radix Collapsible): للمعلومات الثانوية، وعنوانه يذكر العدد والمجموع.
// tone يرسم خطاً ملوّناً على طرفه: alert للعاجل، وwarn للمتابعة.
export function Fold({ open, onOpenChange, head, tone, children, className }: {
  open: boolean; onOpenChange: (v: boolean) => void; head: React.ReactNode; tone?: 'alert' | 'warn' | '';
  children: React.ReactNode; className?: string;
}) {
  return (
    <C.Root open={open} onOpenChange={onOpenChange}
      className={cn('border border-line bg-surface', tone === 'alert' && 'border-s-3 border-s-brand', tone === 'warn' && 'border-s-3 border-s-warning', className)}>
      <C.Trigger className={cn('flex min-h-12 w-full items-center gap-2 px-3.5 py-3 text-start active:bg-surface-alt', open && 'border-b border-line')}>
        <ChevronLeft aria-hidden className={cn('size-4.5 flex-none text-muted transition-transform duration-150', open && '-rotate-90')} />
        <div className="min-w-0 flex-1">{head}</div>
      </C.Trigger>
      <C.Content className="px-3 pb-3 pt-2.5">{children}</C.Content>
    </C.Root>
  );
}
