import * as React from 'react';
import * as D from '@radix-ui/react-dialog';
import { cn } from '@/lib/utils';
import { useBackClose } from '@/lib/back';

// بطاقة تأكيد (Radix Dialog): تصعد من أسفل الشاشة قريباً من الإبهام (منذ الدفعة «ب»)، برأس أحمر بالعنوان، ثم المحتوى، ثم زر التنفيذ يميناً والإلغاء يساراً.
// أثناء التنفيذ (busy) لا تُغلق. زر الرجوع في الهاتف يغلقها. لمس الخلفية لا يغلقها حتى لا تضيع بيانات.
export function Modal({ open, onClose, title, busy, children, className, labelledTitle }: {
  open: boolean; onClose: () => void; title: React.ReactNode; busy?: boolean;
  children: React.ReactNode; className?: string; labelledTitle?: string;
}) {
  const close = () => { if (!busy) onClose(); };
  useBackClose(open, close);
  return (
    <D.Root open={open} onOpenChange={(v) => { if (!v) close(); }}>
      <D.Portal>
        <D.Overlay className="fixed inset-0 z-40 bg-scrim data-[state=open]:animate-fade-in data-[state=closed]:animate-fade-out" />
        <D.Content
          aria-describedby={undefined}
          onPointerDownOutside={(e) => e.preventDefault()}
          onInteractOutside={(e) => e.preventDefault()}
          className={cn('fixed inset-x-0 bottom-0 z-50 mx-auto max-h-[calc(100dvh-24px)] w-full max-w-[480px] overflow-y-auto bg-surface pb-[env(safe-area-inset-bottom)] text-foreground focus:outline-none data-[state=open]:animate-sheet-in data-[state=closed]:animate-sheet-out', className)}
          dir="rtl"
        >
          <D.Title className="m-0 bg-brand px-4 py-3 text-lg font-bold text-white" aria-label={labelledTitle}>{title}</D.Title>
          <div className="px-4 pb-4 pt-2">{children}</div>
        </D.Content>
      </D.Portal>
    </D.Root>
  );
}

// أزرار البطاقة: التنفيذ يميناً والإلغاء يساراً، بنفس العرض
export function ModalActions({ children }: { children: React.ReactNode }) {
  return <div className="mt-3 flex gap-2 [&>*]:flex-1 [&>*]:py-3">{children}</div>;
}

// اللوحة السفلية (نمط Drawer): اختيار من قائمة قريباً من الإبهام. لمس الخلفية يغلقها.
export function Sheet({ open, onClose, title, children, action }: {
  open: boolean; onClose: () => void; title: React.ReactNode; children: React.ReactNode; action?: React.ReactNode;
}) {
  useBackClose(open, onClose);
  return (
    <D.Root open={open} onOpenChange={(v) => { if (!v) onClose(); }}>
      <D.Portal>
        <D.Overlay className="fixed inset-0 z-40 bg-scrim data-[state=open]:animate-fade-in data-[state=closed]:animate-fade-out" />
        <D.Content
          aria-describedby={undefined}
          dir="rtl"
          className="fixed inset-x-0 bottom-0 z-50 mx-auto flex max-h-[80dvh] w-full max-w-[480px] flex-col border-t border-line-strong bg-surface pb-[env(safe-area-inset-bottom)] text-foreground focus:outline-none data-[state=open]:animate-sheet-in data-[state=closed]:animate-sheet-out"
        >
          <div className="flex flex-none items-center justify-between gap-3 border-b border-line px-4 py-2">
            <D.Title className="m-0 text-lg font-bold">{title}</D.Title>
            {action}
          </div>
          <div className="overflow-y-auto py-2">{children}</div>
        </D.Content>
      </D.Portal>
    </D.Root>
  );
}

// خيار في اللوحة السفلية: الاسم يميناً، والعدد والمجموع يساراً. المختار بلون «المختار» مع ✓
export function SheetOption({ selected, empty, label, meta, onClick }: {
  selected: boolean; empty?: boolean; label: React.ReactNode; meta?: React.ReactNode; onClick: () => void;
}) {
  return (
    <button type="button" aria-pressed={selected} onClick={onClick}
      className={cn('sheet-opt flex min-h-[52px] w-full items-center justify-between gap-3 border-b border-line px-4 py-2 text-start text-base font-semibold last:border-b-0 active:bg-surface-alt',
        selected && 'bg-selected text-selected-ink active:bg-selected', empty && !selected && 'font-normal text-muted')}>
      <span className="flex items-center gap-2">{selected ? <span aria-hidden>✓</span> : null}{label}</span>
      {meta ? <span className={cn('flex flex-col items-end text-sm font-normal leading-snug', selected ? 'text-selected-ink' : 'text-muted')}>{meta}</span> : null}
    </button>
  );
}

export const DialogClose = D.Close;

// مدة نزول البطاقة عند الإغلاق: ينتظرها من يزيل البطاقة بعد إغلاقها، فتكتمل الحركة
export const CLOSE_MS = 200;
