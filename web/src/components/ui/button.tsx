import * as React from 'react';
import { Slot } from '@radix-ui/react-slot';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '@/lib/utils';

// ثلاثة أنواع فقط (مهارة واجهة شيكاتي): الرئيسي الأحمر واحد في كل شاشة، والعادي بإطار رمادي،
// والخطير بإطار ونص أحمرين دون تعبئة. أصغر مساحة لمس 44 بكسل.
export const buttonVariants = cva(
  'inline-flex items-center justify-center gap-2 min-h-11 px-3.5 py-2 text-base font-semibold leading-snug border transition-colors duration-150 select-none disabled:opacity-55 disabled:pointer-events-none no-underline text-center',
  {
    variants: {
      variant: {
        primary: 'bg-brand text-white border-transparent active:bg-brand-pressed hover:bg-brand-pressed',
        plain: 'bg-surface text-foreground border-line-strong active:bg-surface-alt hover:bg-surface-alt',
        danger: 'bg-surface text-danger border-danger active:bg-brand-tint hover:bg-brand-tint',
        ghost: 'bg-transparent text-foreground border-transparent active:bg-surface-alt hover:bg-surface-alt',
      },
      size: {
        default: '',
        lg: 'w-full py-3 text-lg',
        sm: 'min-h-9 px-2.5 py-1 text-sm',
      },
    },
    defaultVariants: { variant: 'plain', size: 'default' },
  },
);

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement>, VariantProps<typeof buttonVariants> {
  asChild?: boolean;
  // الزر غير المسموح: باهت، ولمسه يشرح السبب بدل أن يكون معطّلاً بلا تفسير
  blocked?: boolean;
}

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, asChild, blocked, type, ...props }, ref) => {
    const Comp: any = asChild ? Slot : 'button';
    return (
      <Comp
        ref={ref}
        type={asChild ? undefined : type || 'button'}
        aria-disabled={blocked || undefined}
        className={cn(buttonVariants({ variant, size }), blocked && 'opacity-60', className)}
        {...props}
      />
    );
  },
);
Button.displayName = 'Button';
