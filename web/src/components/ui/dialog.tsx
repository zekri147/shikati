import * as React from 'react';
import * as D from '@radix-ui/react-dialog';
import { cn } from '@/lib/utils';
import { useBackClose } from '@/lib/back';

// بطاقة تأكيد (Radix Dialog): رأس أحمر بالعنوان، ثم المحتوى، ثم زر التنفيذ يميناً والإلغاء يساراً.
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
        <D.Overlay className="fixed inset-0 z-40 bg-scrim" />
        <D.Content
          aria-describedby={undefined}
          onPointerDownOutside={(e) => e.preventDefault()}
          onInteractOutside={(e) => e.preventDefault()}
          className={cn('fixed left-1/2 top-1/2 z-50 max-h-[calc(100dvh-24px)] w-[min(440px,calc(100vw-24px))] -translate-x-1/2 -translate-y-1/2 overflow-y-auto bg-surface text-foreground focus:outline-none', className)}
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
        <D.Overlay className="fixed inset-0 z-40 bg-scrim" />
        <D.Content
          aria-describedby={undefined}
          dir="rtl"
          className="fixed inset-x-0 bottom-0 z-50 flex max-h-[80dvh] flex-col border-t border-line-strong bg-surface pb-[env(safe-area-inset-bottom)] text-foreground focus:outline-none"
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

export const DialogClose = D.Close;
