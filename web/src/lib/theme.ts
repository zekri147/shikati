import { useSyncExternalStore } from 'react';
import { load, save } from './storage';

// الوضع الداكن افتراضي. يُطبَّق قبل رسم الصفحة (في setupPage) حتى لا يومض الفاتح.
const KEY = 'shikati-theme';
export type Theme = 'dark' | 'light';
const listeners = new Set<() => void>();

export const storedTheme = (): Theme => (load(KEY) === 'light' ? 'light' : 'dark');

export function applyTheme(t: Theme) {
  const root = document.documentElement;
  root.classList.toggle('dark', t === 'dark');
  root.setAttribute('data-theme', t);
  // لون شريط المتصفح يطابق الشريط العلوي الأحمر في الوضعين
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', '#d73237');
}

export function toggleTheme() {
  const next: Theme = storedTheme() === 'dark' ? 'light' : 'dark';
  save(KEY, next);
  applyTheme(next);
  listeners.forEach((l) => l());
}

export function useTheme(): Theme {
  return useSyncExternalStore((cb) => { listeners.add(cb); return () => listeners.delete(cb); }, storedTheme);
}
