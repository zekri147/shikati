import * as React from 'react';
import { cn } from '@/lib/utils';

// الحقول بلا زوايا مستديرة، وإطار التركيز ظاهر دائماً
export const Input = React.forwardRef<HTMLInputElement, React.InputHTMLAttributes<HTMLInputElement>>(({ className, ...props }, ref) => (
  <input
    ref={ref}
    className={cn('block w-full min-h-11 border border-line-strong bg-surface px-3 py-2 text-foreground placeholder:text-soft focus:border-muted focus:outline-none focus-visible:outline-3 focus-visible:outline-danger focus-visible:outline-offset-0 disabled:opacity-60', className)}
    {...props}
  />
));
Input.displayName = 'Input';

export const Textarea = React.forwardRef<HTMLTextAreaElement, React.TextareaHTMLAttributes<HTMLTextAreaElement>>(({ className, ...props }, ref) => (
  <textarea
    ref={ref}
    className={cn('block w-full min-h-16 resize-y border border-line-strong bg-surface px-3 py-2 text-foreground placeholder:text-soft focus:outline-none focus-visible:outline-3 focus-visible:outline-danger focus-visible:outline-offset-0 disabled:opacity-60', className)}
    {...props}
  />
));
Textarea.displayName = 'Textarea';

export function Field({ label, hint, children, className }: { label: React.ReactNode; hint?: React.ReactNode; children: React.ReactNode; className?: string }) {
  return (
    <label className={cn('block py-2', className)}>
      <span className="mb-1.5 block text-base font-semibold">{label}</span>
      {children}
      {hint ? <span className="mt-1 block text-sm text-muted">{hint}</span> : null}
    </label>
  );
}
