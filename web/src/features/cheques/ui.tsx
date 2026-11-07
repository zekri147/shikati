import * as React from 'react';
import { useEffect, useRef, useState } from 'react';
import * as D from '@radix-ui/react-dialog';
import { ChevronLeft, Clock } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Fold } from '@/components/ui/collapsible';
import { Amount, Num } from '@/components/ltr';
import { Empty, Note } from '@/components/shell';
import { useBackClose } from '@/lib/back';
import { cn } from '@/lib/utils';
import { isShared, markShared, sharedStyle } from '@/lib/motion';
import { daysCount, daysText, fmtDate, shortDate, sum } from '@/lib/format';
import type { Cheque, Line } from './types';

export const LATE_DAYS = 7;
// بعد 14 يوماً يصير التأخير عاجلاً: شارة حمراء. قبلها نص بلون التحذير برمز الساعة
export const URGENT_DAYS = 14;
// أسماء الوجهات في الواجهة. القيمة في زوهو تبقى ELONAC، والاسم «بنك AGB» (طلب ZEKRI يوم 3/11/2026)
export const DEST_LABELS: Record<string, string> = { ELONAC: 'بنك AGB', ROSTOMIA: 'بنك الرستمية', 'Autre Fournisseur': 'مورد آخر' };
const LOCK_LABELS: Record<string, string> = { pending: 'الإيداع قيد التنفيذ', unknown: 'بانتظار التحقق', done: 'سُجّل إيداعه' };
const STATUS_TONE: Record<string, 'outline' | 'bank' | 'done' | 'dashed' | 'urgent' | 'neutral'> = {
  'في الحوزة': 'outline', 'مودع في البنك': 'bank', 'محصّل': 'done', 'مظهّر لمورد': 'dashed', 'مرفوض': 'urgent',
};

export const detailHash = (id: string) => '#cheques/c/' + encodeURIComponent(id);

// شارات الحالة محايدة، والأحمر للمرفوض وحده لأنه عاجل. الكلمة تميّز الحالة لا اللون
export function StatusBadge({ status, className }: { status: string; className?: string }) {
  return <Badge tone={STATUS_TONE[status] || 'neutral'} className={className}>{status || 'بلا حالة'}</Badge>;
}

// «متأخر»: نص تحذير برمز الساعة، وشارة حمراء بقطع الزاوية بعد 14 يوماً
export function LateMark({ days, text }: { days: number; text: React.ReactNode }) {
  const urgent = days > URGENT_DAYS;
  return (
    <span className={cn('inline-flex items-center gap-1 whitespace-nowrap text-sm font-semibold leading-relaxed text-warning',
      urgent && 'cut-sm bg-brand px-2 text-white')}>
      <Clock aria-hidden className="size-3.5" strokeWidth={2.4} />{text}
    </span>
  );
}

const Dot = () => <span aria-hidden className="text-soft">·</span>;

export type CardOpts = {
  selectable?: boolean; selected?: boolean; onToggle?: (c: Cheque) => void; link?: boolean;
  showStatus?: boolean; noAge?: boolean; ageInHandOnly?: boolean; lateOnly?: boolean; note?: string | null;
  // leaving: الشيك أُودع للتو، فينطوي من القائمة قبل وصول البيانات الجديدة
  leaving?: boolean;
  // أسباب التنبيه تحت البطاقة: سطر لكل سبب، بخط ملوّن على طرفه (alert عاجل، warn متابعة، info للعلم)
  reasons?: { tone: 'alert' | 'warn' | 'info'; text: string }[];
};

// بطاقة الشيك في سطرين: العميل والمبلغ، ثم الرقم والتاريخ والموقع وشارة واحدة.
// في شاشة الإيداع يحدد اللمسُ البطاقة، والسهم وحده يفتح التفاصيل. وفي غيرها يفتح اللمسُ البطاقة كلها التفاصيل، دون سهم.
export function ChequeCard({ c, o }: { c: Cheque; o: CardOpts }) {
  const noAge = o.noAge || (o.ageInHandOnly && c.status !== 'في الحوزة');
  const late = c.days > LATE_DAYS && !noAge;
  const selectable = !!o.selectable && !c.lock;

  let age: React.ReactNode = null;
  // أيام التأخر التي ترسم الشريط على طرف البطاقة: تحذير بعد 7 أيام، وأحمر بعد 14
  let lateDays = 0;
  if (c.status === 'مودع في البنك' && c.deposit_days !== undefined) {
    // التحصيل المتأخر لبنك AGB وحده: الرستمية لا تتحوّل إلى «محصّل» في زوهو
    const slow = c.destination === 'ELONAC' && c.deposit_days > LATE_DAYS;
    if (slow) lateDays = c.deposit_days;
    age = slow ? <LateMark days={c.deposit_days} text={'تحصيل متأخر ' + daysCount(c.deposit_days)} />
      : <span className="whitespace-nowrap text-sm text-muted">في البنك {daysText(c.deposit_days)}</span>;
  } else if (!noAge && (late || !o.lateOnly)) {
    if (late) lateDays = c.days;
    age = late ? <LateMark days={c.days} text={'متأخر ' + daysCount(c.days)} /> : <span className="whitespace-nowrap text-sm text-muted">{daysText(c.days)}</span>;
  }
  // شارة واحدة حين lateOnly: نص العمر يغني عن شارة الحالة
  const status = o.showStatus && !(o.lateOnly && age) ? <StatusBadge status={c.status} /> : null;
  const lock = o.selectable && c.lock ? <Badge tone={c.lock === 'unknown' ? 'warn' : 'neutral'}>{LOCK_LABELS[c.lock] || c.lock}</Badge> : null;

  const ref = useRef<HTMLLIElement>(null);
  // اسم العميل والمبلغ ينتقلان إلى رأس صفحة الشيك
  const open = () => { markShared(c.id, ref.current); location.hash = detailHash(c.id); };
  const shared = isShared(c.id);
  const act = selectable ? () => o.onToggle?.(c) : o.link ? open : undefined;

  return (
    <li
      ref={ref}
      role={selectable ? 'checkbox' : o.link ? 'link' : undefined}
      aria-checked={selectable ? !!o.selected : undefined}
      aria-label={!selectable && o.link ? `تفاصيل شيك ${c.customer}` : undefined}
      tabIndex={act ? 0 : undefined}
      onClick={act}
      onKeyDown={(e) => { if (act && e.target === e.currentTarget && (e.key === ' ' || e.key === 'Enter')) { e.preventDefault(); act(); } }}
      data-selectable={selectable || undefined}
      className={cn('item relative flex min-h-[60px] items-center gap-1 bg-surface py-2 ps-3 transition-colors duration-150',
        o.selectable ? 'pe-0' : 'pe-3',
        act && 'cursor-pointer active:bg-surface-alt',
        o.selected && selectable && '!bg-brand-tint', o.leaving && 'pointer-events-none overflow-hidden animate-row-out')}
    >
      {lateDays ? <span aria-hidden className={cn('absolute inset-y-0 start-0 w-1', lateDays > URGENT_DAYS ? 'bg-brand' : 'bg-warning')} /> : null}
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <div className="flex items-start justify-between gap-3">
          <div className="flex min-w-0 items-start gap-2 text-base font-semibold leading-snug [overflow-wrap:anywhere]">
            {selectable ? (
              <span aria-hidden className={cn('mt-px inline-flex size-[22px] flex-none items-center justify-center border-2 border-line-strong bg-surface',
                o.selected && 'animate-pop border-brand bg-brand text-white')}>
                {o.selected ? <svg viewBox="0 0 16 16" className="size-3.5" fill="none" stroke="currentColor" strokeWidth="2.4"><path d="M3 8.5 6.5 12 13 4.5" /></svg> : null}
              </span>
            ) : null}
            <span data-vt="cust" style={sharedStyle(shared, 'cust')}>{c.customer}</span>
          </div>
          <span data-vt="amt" style={sharedStyle(shared, 'amt')}><Amount value={c.amount} className="whitespace-nowrap font-display text-base font-semibold leading-snug" /></span>
        </div>
        <div className="flex flex-wrap items-center justify-between gap-x-2 gap-y-1">
          <div className="flex min-w-0 flex-wrap items-center gap-x-1 text-sm text-muted">
            {c.cheque_number ? <span>شيك <Num>{c.cheque_number}</Num></span> : <span>رقم غير مسجّل</span>}
            <Dot />
            {c.deposit_date && c.status !== 'في الحوزة'
              ? <span>إيداع <Num>{shortDate(c.deposit_date)}</Num></span>
              : <Num>{shortDate(c.date)}</Num>}
            {c.location ? <><Dot /><span>{c.location}</span></> : null}
          </div>
          {(lock || status || age) ? <div className="ms-auto flex flex-none flex-wrap items-center gap-2">{lock}{status}{age}</div> : null}
        </div>
        {o.note ? <Note tone="warn" compact>{o.note}</Note> : null}
        {o.reasons && o.reasons.length ? (
          // سطر نصي لكل سبب بعلامة صغيرة ملوّنة، لا صناديق ملوّنة: الجملة نفسها تشرح
          <ul className="reasons m-0 mt-1 flex list-none flex-col gap-1 p-0">
            {o.reasons.map((r, i) => (
              <li key={i}><Note plain tone={r.tone === 'info' ? undefined : r.tone}>{r.text}</Note></li>
            ))}
          </ul>
        ) : null}
      </div>
      {o.selectable ? (
        <a href={detailHash(c.id)} onClick={(e) => { e.stopPropagation(); markShared(c.id, ref.current); }} aria-label={`تفاصيل شيك ${c.customer}`}
          className="-my-2 flex w-11 flex-none items-center justify-center self-stretch border-s border-line text-muted active:bg-surface-alt">
          <ChevronLeft aria-hidden className="size-4.5" />
        </a>
      ) : null}
    </li>
  );
}

// قائمة متصلة بفواصل رفيعة بدل بطاقات منفصلة: أهدأ للعين، وتتسع لشيكات أكثر
export const LIST_BOX = 'm-0 flex list-none flex-col border border-line bg-surface p-0 [&>li+li]:border-t [&>li+li]:border-line';
export function CardList({ children, className }: { children: React.ReactNode; className?: string }) {
  return <ul className={cn(LIST_BOX, className)}>{children}</ul>;
}

// inTrigger: داخل زر القسم المطوي يكون العنوان نصاً لا عنواناً (لا عنوان داخل زر)
// meta: نص قصير مكان المجموع، مثل «الأقدم أولاً» حين يكون المجموع في اللوح الأحمر فوقه
export function SectionHead({ title, count, total, primary, inTrigger, meta }: { title: string; count: number; total?: number | null; primary?: boolean; inTrigger?: boolean; meta?: React.ReactNode }) {
  const H: any = inTrigger ? 'span' : 'h2';
  return (
    <div className="flex items-center justify-between gap-3">
      <H className={cn('m-0 flex items-center gap-2 font-bold', inTrigger ? 'text-base' : 'text-lg')}>
        <span>{title}</span>
        <span className={cn('num min-w-[22px] px-2 py-1 text-center text-sm font-semibold leading-none', primary ? 'bg-foreground text-background' : 'bg-surface-alt text-muted')}>{count}</span>
      </H>
      {total !== null && total !== undefined && count ? <Amount value={total} className="whitespace-nowrap text-sm text-muted" />
        : meta ? <span className="whitespace-nowrap text-sm text-muted">{meta}</span> : null}
    </div>
  );
}

// قسم ثابت (رئيسي) أو مطوي. القسم المطوي يتذكّر حالته أثناء الجلسة.
export function ChequeSection({ title, items, opts, note, noteTone, emptyText, collapsible, open, onOpenChange, hideTotal, noteFor }: {
  title: string; items: Cheque[]; opts: CardOpts; note?: string | null; noteTone?: 'alert' | 'warn' | '';
  emptyText?: string; collapsible?: boolean; open?: boolean; onOpenChange?: (v: boolean) => void; hideTotal?: boolean;
  noteFor?: (c: Cheque) => string | null;
}) {
  const list = items.length
    ? <CardList>{items.map((c) => <ChequeCard key={c.id} c={c} o={{ ...opts, note: noteFor ? noteFor(c) : null }} />)}</CardList>
    : <Empty>{emptyText || 'لا توجد شيكات هنا.'}</Empty>;
  const total = hideTotal ? null : sum(items);
  if (!collapsible) {
    return (
      <section className="mt-4">
        <div className="mb-2 border-b border-line-strong pb-2"><SectionHead title={title} count={items.length} total={total} primary /></div>
        {note ? <Note className="mb-2">{note}</Note> : null}
        {list}
      </section>
    );
  }
  return (
    <Fold open={!!open} onOpenChange={(v) => onOpenChange?.(v)} tone={noteTone} className="fold mt-2"
      head={<SectionHead title={title} count={items.length} total={total} inTrigger />}>
      {note ? <Note className="mb-2">{note}</Note> : null}
      <div className="[&_.item]:bg-raised">{list}</div>
    </Fold>
  );
}
