import { useSyncExternalStore } from 'react';
import { cn } from '@/lib/utils';

// رسالة قصيرة أسفل الشاشة تختفي وحدها: النجاح 3.5 ثوانٍ، والتحذير والخطأ 6 ثوانٍ.
// مكتوبة هنا بدل مكتبة جاهزة لأن المكتبات تضيف وسوم <style> تمنعها سياسة أمان المحتوى.
type Kind = 'ok' | 'warn' | 'err';
type T = { id: number; message: string; kind: Kind; out: boolean };
let items: T[] = [];
let seq = 0;
const subs = new Set<() => void>();
const emit = () => { items = [...items]; subs.forEach((s) => s()); };

export function toast(message: string, kind: Kind = 'ok') {
  const t: T = { id: ++seq, message, kind, out: false };
  items.push(t);
  emit();
  setTimeout(() => {
    items = items.map((x) => (x.id === t.id ? { ...x, out: true } : x));
    emit();
    setTimeout(() => { items = items.filter((x) => x.id !== t.id); emit(); }, 300);
  }, kind === 'ok' ? 3500 : 6000);
}

export function Toaster() {
  const list = useSyncExternalStore((cb) => { subs.add(cb); return () => subs.delete(cb); }, () => items);
  return (
    <div aria-live="polite" className="pointer-events-none fixed inset-x-4 z-[60] flex flex-col gap-2 bottom-[calc(var(--fixed-bottom,0px)+12px+env(safe-area-inset-bottom))]">
      {list.map((t) => (
        <div key={t.id} role="status"
          className={cn('border-s-4 bg-bar px-3 py-3 text-base font-semibold text-white transition-all duration-300 dark:ring-1 dark:ring-line-strong',
            t.kind === 'ok' && 'border-s-ok-on-dark', t.kind === 'warn' && 'border-s-warning', t.kind === 'err' && 'border-s-brand',
            t.out && 'translate-y-2 opacity-0')}>
          {t.message}
        </div>
      ))}
    </div>
  );
}
