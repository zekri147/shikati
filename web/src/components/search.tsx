import * as React from 'react';
import { useState } from 'react';
import { ChevronDown, Search, X } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

// حقل البحث برمز العدسة في أوله
export function SearchBox({ placeholder, onChange, autoFocus }: { placeholder: string; onChange: (v: string) => void; autoFocus?: boolean }) {
  return (
    <div className="relative">
      <Search aria-hidden className="pointer-events-none absolute start-3 top-1/2 size-[18px] -translate-y-1/2 text-soft" />
      <Input type="search" enterKeyHint="search" autoFocus={autoFocus} aria-label="بحث" placeholder={placeholder} className="search ps-10" onChange={(e) => onChange(e.target.value)} />
    </div>
  );
}

// شريط الأدوات الموحّد فوق كل قائمة: أزرار التصفية في صف واحد، ثم زر العدسة في آخره.
// البحث يُفتح بالعدسة، وإغلاقه يمسح ما كُتب، فلا تبقى القائمة مصفّاة دون أن يرى الموظف السبب.
export function ListTools({ children, placeholder, onSearch, className }: {
  children?: React.ReactNode; placeholder: string; onSearch: (v: string) => void; className?: string;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className={cn('flex flex-col gap-2', className)}>
      <div className="flex gap-2">
        {children}
        <Button aria-label={open ? 'إغلاق البحث' : 'بحث'} aria-expanded={open}
          className={cn('search-btn cut-sm w-11 flex-none border-0 bg-chip px-0', open && 'bg-selected text-selected-ink hover:bg-selected')}
          onClick={() => { if (open) onSearch(''); setOpen(!open); }}>
          {open ? <X aria-hidden className="size-5" /> : <Search aria-hidden className="size-5" />}
        </Button>
      </div>
      {open ? <SearchBox autoFocus placeholder={placeholder} onChange={onSearch} /> : null}
    </div>
  );
}

// زر تصفية يفتح لوحة سفلية: يكتب الاختيار الحالي، وبلون «المختار» حين لا يكون «الكل»
export function FilterButton({ label, value, active, onClick, className }: {
  label: string; value: React.ReactNode; active: boolean; onClick: () => void; className?: string;
}) {
  return (
    <Button aria-haspopup="dialog" aria-label={label} onClick={onClick}
      className={cn('cut-sm min-w-0 flex-1 justify-between gap-1 border-0 bg-chip pe-2 ps-3 text-muted', active && 'bg-selected text-selected-ink hover:bg-selected', className)}>
      <span className="truncate">{value}</span><ChevronDown aria-hidden className="size-4.5 flex-none" />
    </Button>
  );
}
