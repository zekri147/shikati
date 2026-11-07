import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

// دمج أصناف Tailwind دون تعارض (طريقة shadcn/ui)
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
