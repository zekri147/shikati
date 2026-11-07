import { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Amount, Num } from '@/components/ltr';
import { api, errText } from '@/lib/api';
import { fmtDate, round2 } from '@/lib/format';
import { cn } from '@/lib/utils';
import type { Line } from './types';

export type Party = { id: string; name: string };

// بحث واختيار جهة اتصال: عميل أو مورد. البحث في الخادم يستبعد النوع الآخر.
export function PartyPicker({ kind, value, onChange, autoFocus }: { kind: 'customer' | 'vendor'; value: Party | null; onChange: (p: Party | null) => void; autoFocus?: boolean }) {
  const isVendor = kind === 'vendor';
  const [q, setQ] = useState('');
  const [list, setList] = useState<Party[] | null>(null);
  const [error, setError] = useState('');
  const seq = useRef(0);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const my = ++seq.current;
    if (q.trim().length < 2) { setList(null); setError(''); return; }
    const t = setTimeout(async () => {
      try {
        const data = await api(`/api/m/cheques/register/${isVendor ? 'vendors' : 'customers'}?q=` + encodeURIComponent(q.trim()));
        if (my !== seq.current) return;
        setList(isVendor ? data.vendors : data.customers);
        setError('');
      } catch (e) {
        if (my === seq.current) setError(errText(e));
      }
    }, 300);
    return () => clearTimeout(t);
  }, [q, isVendor]);

  if (value) {
    return (
      <div className="mt-2 flex items-center justify-between gap-2 border-s-3 border-s-brand bg-brand-tint px-2 py-2">
        <span className="font-semibold">{value.name}</span>
        <Button size="sm" onClick={() => { onChange(null); setQ(''); setList(null); setTimeout(() => input.current?.focus(), 0); }}>تغيير</Button>
      </div>
    );
  }
  return (
    <div>
      <Input ref={input} type="search" autoComplete="off" enterKeyHint="search" autoFocus={autoFocus}
        placeholder={isVendor ? 'اكتب جزءاً من اسم المورد' : 'اكتب جزءاً من اسم العميل'}
        value={q} onChange={(e) => setQ(e.target.value)} />
      {error ? <p className="mt-1 text-base text-danger">{error}</p> : null}
      {list ? (
        <ul className="mt-1 list-none border border-line p-0">
          {list.length ? list.map((c) => (
            <li key={c.id} className="border-b border-line last:border-b-0">
              <button type="button" className="block min-h-11 w-full bg-surface px-3 py-2 text-start text-base active:bg-surface-alt" onClick={() => { onChange(c); setList(null); }}>{c.name}</button>
            </li>
          )) : <li className="px-3 py-2 text-sm text-muted">{isVendor ? 'لا مورد بهذا الاسم.' : 'لا عميل بهذا الاسم.'}</li>}
        </ul>
      ) : null}
    </div>
  );
}

// توزيع المبلغ على فواتير العميل أو المورد
export function AllocList({ lines, emptyText }: { lines: Line[]; emptyText: string }) {
  if (!lines.length) return <p className="text-sm text-muted">{emptyText}</p>;
  return (
    <ul className="m-0 list-none p-0">
      {lines.map((l) => (
        <li key={l.number} className="border-b border-line py-2 text-base last:border-b-0">
          <div className="flex flex-wrap items-baseline justify-between gap-2"><Num className="font-semibold">{l.number}</Num><Amount value={l.applied} className="font-semibold" /></div>
          <div className="flex flex-wrap items-baseline justify-between gap-2 text-sm text-muted">
            <span>بتاريخ <Num>{fmtDate(l.date)}</Num></span>
            {l.applied < l.balance ? <span>يبقى منها <Amount value={round2(l.balance - l.applied)} /></span> : <span>تُسدَّد كاملة</span>}
          </div>
        </li>
      ))}
    </ul>
  );
}

// صف «عنوان: قيمة». القيمة الفارغة شرطة.
export function KV({ label, children, after }: { label: string; children: React.ReactNode; after?: React.ReactNode }) {
  const empty = children === '' || children === null || children === undefined;
  return (
    <div className="grid grid-cols-[9.5em_1fr] gap-2 border-b border-line py-2 text-base last:border-b-0">
      <dt className="text-muted">{label}</dt>
      <dd className="m-0 min-w-0 font-semibold [overflow-wrap:anywhere]">{empty ? <span className="font-normal text-muted">—</span> : children}{after ? <span className="text-sm font-normal text-muted"> · {after}</span> : null}</dd>
    </div>
  );
}

// قسم بعنوان: كل أقسام صفحات التفاصيل والنماذج. العنوان صغير فوق مجموعة مسطحة بإطار رفيع،
// لا عنوان داخل صندوق بخط فاصل. strong: عنوان بارز لخطوات النموذج. innerRef لمن يحتاج التمرير إليه
export function Block({ title, children, className, id, innerRef, strong }: { title: React.ReactNode; children: React.ReactNode; className?: string; id?: string; innerRef?: React.Ref<HTMLElement>; strong?: boolean }) {
  return (
    <section id={id} ref={innerRef} className={'scroll-mt-16 ' + (className || '')}>
      <h2 className={cn('mb-2 mt-0 flex items-center gap-2', strong ? 'text-lg font-bold' : 'text-sm font-semibold text-muted')}>{title}</h2>
      <div className="border border-line bg-surface px-4 py-2">{children}</div>
    </section>
  );
}
