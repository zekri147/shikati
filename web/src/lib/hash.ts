import { useSyncExternalStore } from 'react';

// العنوان بعد # يحدد الشاشة. يُقرأ كقيمة تتغيّر مع كل تنقل.
export function useHash(): string {
  return useSyncExternalStore((cb) => { window.addEventListener('hashchange', cb); return () => window.removeEventListener('hashchange', cb); }, () => location.hash);
}
