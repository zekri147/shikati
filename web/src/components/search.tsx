import { Search } from 'lucide-react';
import { Input } from '@/components/ui/input';

// حقل البحث برمز العدسة في أوله
export function SearchBox({ placeholder, onChange }: { placeholder: string; onChange: (v: string) => void }) {
  return (
    <div className="relative">
      <Search aria-hidden className="pointer-events-none absolute start-3 top-1/2 size-[18px] -translate-y-1/2 text-soft" />
      <Input type="search" enterKeyHint="search" aria-label="بحث" placeholder={placeholder} className="search ps-10" onChange={(e) => onChange(e.target.value)} />
    </div>
  );
}
