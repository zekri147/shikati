import * as React from 'react';
import { Eye, EyeOff } from 'lucide-react';
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

// الرمز السري مع زر العين لإظهاره: يتأكد الموظف مما كتب قبل الدخول، والهاتف في يد واحدة
export const PasswordInput = React.forwardRef<HTMLInputElement, Omit<React.InputHTMLAttributes<HTMLInputElement>, 'type'>>(({ className, ...props }, ref) => {
  const [shown, setShown] = React.useState(false);
  return (
    <span className="relative block">
      <Input ref={ref} type={shown ? 'text' : 'password'} className={cn('pe-12', className)} {...props} />
      <button type="button" onClick={() => setShown(!shown)} aria-pressed={shown} aria-label={shown ? 'إخفاء الرمز السري' : 'إظهار الرمز السري'}
        className="absolute inset-y-0 end-0 flex w-11 items-center justify-center text-muted active:bg-surface-alt">
        {shown ? <EyeOff aria-hidden className="size-5" /> : <Eye aria-hidden className="size-5" />}
      </button>
    </span>
  );
});
PasswordInput.displayName = 'PasswordInput';

export function Field({ label, hint, children, className }: { label: React.ReactNode; hint?: React.ReactNode; children: React.ReactNode; className?: string }) {
  return (
    <label className={cn('block py-2', className)}>
      <span className="mb-1.5 block text-base font-semibold">{label}</span>
      {children}
      {hint ? <span className="mt-1 block text-sm text-muted">{hint}</span> : null}
    </label>
  );
}
