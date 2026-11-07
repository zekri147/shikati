import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '@/lib/utils';

// الشارة المائلة (SlantTag) بقطع الزاوية الصغير، مملوءة بلا إطار. تحمل كلمة دائماً، فلا يُعتمد على اللون وحده
export const badgeVariants = cva('cut-sm inline-flex items-center whitespace-nowrap px-2 text-sm font-semibold leading-relaxed', {
  variants: {
    tone: {
      neutral: 'bg-surface-alt text-foreground',
      outline: 'bg-surface-alt text-foreground',
      bank: 'bg-line-strong text-foreground',
      done: 'bg-surface-alt text-muted',
      dashed: 'bg-surface-alt text-foreground',
      urgent: 'bg-brand text-white',
      warn: 'bg-warning-tint text-foreground',
      inverse: 'bg-white text-ink-black',
      dark: 'bg-ink-black text-white',
    },
  },
  defaultVariants: { tone: 'neutral' },
});

export function Badge({ className, tone, ...props }: React.HTMLAttributes<HTMLSpanElement> & VariantProps<typeof badgeVariants>) {
  return <span className={cn(badgeVariants({ tone }), className)} {...props} />;
}
