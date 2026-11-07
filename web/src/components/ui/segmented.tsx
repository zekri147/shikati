import * as TG from '@radix-ui/react-toggle-group';
import { cn } from '@/lib/utils';

const ALL = '__all';

// أزرار تصفية متلاصقة (Radix ToggleGroup): خيار واحد دائماً، والمختار بلون «المختار»
export function Segmented<T extends string>({ value, onChange, options, label, scroll, className }: {
  value: T; onChange: (v: T) => void; options: { value: T; label: React.ReactNode }[]; label: string; scroll?: boolean; className?: string;
}) {
  return (
    <TG.Root
      type="single"
      dir="rtl"
      value={value || ALL}
      // النقر على المختار لا يلغيه: يبقى خيار واحد دائماً
      onValueChange={(v) => { if (v) onChange((v === ALL ? '' : v) as T); }}
      aria-label={label}
      className={cn('flex border border-line-strong bg-surface', scroll && 'overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden', className)}
    >
      {options.map((o) => (
        <TG.Item
          key={o.value || ALL}
          value={o.value || ALL}
          className={cn('min-h-11 flex-1 border-s border-line px-1.5 py-2 text-base text-muted first:border-s-0 data-[state=on]:bg-selected data-[state=on]:text-selected-ink',
            scroll && 'flex-[1_0_auto] whitespace-nowrap px-3')}
        >
          {o.label}
        </TG.Item>
      ))}
    </TG.Root>
  );
}
