import * as React from 'react';
import * as M from '@radix-ui/react-dropdown-menu';
import { cn } from '@/lib/utils';

// قائمة منسدلة (Radix): لوحة المفاتيح بالأسهم، والتركيز يعود إلى الزر عند الإغلاق
export const Menu = M.Root;
export const MenuTrigger = M.Trigger;

export function MenuContent({ className, children, side = 'bottom', align = 'end' }: {
  className?: string; children: React.ReactNode; side?: 'top' | 'bottom'; align?: 'start' | 'end';
}) {
  return (
    <M.Portal>
      <M.Content
        side={side}
        align={align}
        sideOffset={side === 'top' ? 8 : 0}
        collisionPadding={8}
        className={cn('z-50 flex min-w-60 flex-col border border-line-strong bg-surface py-1 text-foreground',
          side === 'top' ? 'border-b-3 border-b-brand' : 'border-t-3 border-t-brand', className)}
      >
        {children}
      </M.Content>
    </M.Portal>
  );
}

export const MenuItem = React.forwardRef<HTMLDivElement, M.DropdownMenuItemProps & { danger?: boolean; blocked?: boolean }>(
  ({ className, danger, blocked, ...props }, ref) => (
    <M.Item
      ref={ref}
      className={cn('flex min-h-11 w-full cursor-pointer select-none items-center px-4 py-2.5 text-start text-base outline-none data-[highlighted]:bg-surface-alt',
        danger && 'font-semibold text-danger', blocked && 'opacity-60', className)}
      {...props}
    />
  ),
);
MenuItem.displayName = 'MenuItem';

export function MenuLabel({ children }: { children: React.ReactNode }) {
  return <M.Label className="border-b border-line px-4 pb-2 pt-2.5 text-sm text-muted">{children}</M.Label>;
}
export function MenuSeparator() {
  return <M.Separator className="my-1 h-px bg-line" />;
}
