import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '@/lib/utils';

// الشارة تحمل كلمة دائماً، فلا يُعتمد على اللون وحده
export const badgeVariants = cva('inline-flex items-center whitespace-nowrap border px-2 text-sm font-semibold leading-relaxed', {
  variants: {
    tone: {
      neutral: 'bg-surface-alt border-line-strong text-foreground',
      outline: 'bg-transparent border-line-strong text-foreground',
      bank: 'bg-surface-alt border-muted text-foreground',
      done: 'bg-surface-alt border-line-strong text-muted',
      dashed: 'bg-surface-alt border-line-strong border-dashed text-foreground',
      urgent: 'bg-brand border-brand text-white',
      warn: 'bg-warning-tint border-warning text-foreground',
      inverse: 'bg-white border-white text-ink-black',
      dark: 'bg-ink-black border-ink-black text-white',
    },
  },
  defaultVariants: { tone: 'neutral' },
});

export function Badge({ className, tone, ...props }: React.HTMLAttributes<HTMLSpanElement> & VariantProps<typeof badgeVariants>) {
  return <span className={cn(badgeVariants({ tone }), className)} {...props} />;
}
