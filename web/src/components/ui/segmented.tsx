import * as TG from '@radix-ui/react-toggle-group';
import { cn } from '@/lib/utils';

const ALL = '__all';

// أزرار تصفية (Radix ToggleGroup) بشكل الشارات المائلة: خيار واحد دائماً، والمختار بلون «المختار»
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
      className={cn('flex gap-2', scroll && 'overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden', className)}
    >
      {options.map((o) => (
        <TG.Item
          key={o.value || ALL}
          value={o.value || ALL}
          className={cn('cut-sm min-h-11 flex-1 bg-chip px-2 py-2 text-base font-semibold text-muted active:opacity-80 data-[state=on]:bg-selected data-[state=on]:text-selected-ink',
            scroll && 'flex-[1_0_auto] whitespace-nowrap px-3')}
        >
          {o.label}
        </TG.Item>
      ))}
    </TG.Root>
  );
}

// اختيار متعدد بالشكل نفسه (أيام التذكير في إعدادات الإشعارات): كل شارة تُختار وتُلغى وحدها
export function ToggleChips<T extends string>({ value, onChange, options, label, className }: {
  value: T[]; onChange: (v: T[]) => void; options: { value: T; label: React.ReactNode }[]; label: string; className?: string;
}) {
  return (
    <TG.Root type="multiple" dir="rtl" value={value} onValueChange={(v) => onChange(v as T[])} aria-label={label} className={cn('flex flex-wrap gap-2', className)}>
      {options.map((o) => (
        <TG.Item key={o.value} value={o.value}
          className="cut-sm min-h-11 min-w-[72px] flex-1 bg-chip px-3 py-2 text-base font-semibold text-muted active:opacity-80 data-[state=on]:bg-selected data-[state=on]:text-selected-ink">
          {o.label}
        </TG.Item>
      ))}
    </TG.Root>
  );
}
