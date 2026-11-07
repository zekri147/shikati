import { CalendarDays } from 'lucide-react';
import { cn } from '@/lib/utils';
import { toast } from '@/components/toast';
import { isoAddDays, longDate, shortDate, todayIso } from '@/lib/format';

// حقل التاريخ: زرّا «اليوم» و«أمس» لأغلب الحالات، و«تاريخ آخر» يفتح تقويم الهاتف.
// التاريخ المختار يُكتب تحتها بالعربية («السبت 7 نوفمبر»)، لأن تقويم الهاتف يتبع لغته
// وقد يعرض الشهر قبل اليوم، فيُقرأ 11/07 جويلية بدل نوفمبر.
export function DateField({ label, value, onChange, min, max, disabled, hint, className }: {
  label: string; value: string; onChange: (iso: string) => void; min?: string; max?: string;
  disabled?: boolean; hint?: string; className?: string;
}) {
  const today = todayIso();
  const top = max || today;
  const yesterday = isoAddDays(today, -1);
  const other = value !== today && value !== yesterday;
  const chip = 'cut-sm relative flex min-h-11 flex-1 items-center justify-center gap-1.5 bg-chip px-2 py-2 text-base font-semibold text-muted active:opacity-80 disabled:opacity-55';
  const on = 'bg-selected text-selected-ink';

  function pick(v: string) {
    if (!v) return;
    if (v > top) { toast('التاريخ لا يكون بعد اليوم.', 'warn'); return; }
    if (min && v < min) { toast(`التاريخ لا يكون قبل ${longDate(min)}، تاريخ استلام الشيك.`, 'warn'); return; }
    onChange(v);
  }

  return (
    <fieldset className={cn('m-0 min-w-0 border-0 p-0 py-2', className)} disabled={disabled}>
      <legend className="mb-1.5 p-0 text-base font-semibold">{label}</legend>
      <div className="flex gap-2">
        <button type="button" className={cn(chip, value === today && on)} aria-pressed={value === today} onClick={() => pick(today)}>اليوم</button>
        <button type="button" className={cn(chip, value === yesterday && on, min && yesterday < min && 'opacity-55')} aria-pressed={value === yesterday} onClick={() => pick(yesterday)}>أمس</button>
        {/* حقل التقويم شفاف فوق الزر: لمسه يفتح تقويم الهاتف مباشرة */}
        <span className={cn(chip, other && on)}>
          <CalendarDays aria-hidden className="size-4.5" />
          <span>{other ? <bdi dir="ltr" className="ltr num">{shortDate(value)}</bdi> : 'تاريخ آخر'}</span>
          <input type="date" aria-label={label + ': تاريخ آخر'} value={value} min={min} max={top} disabled={disabled}
            className="absolute inset-0 size-full cursor-pointer opacity-0"
            onClick={(e) => { try { (e.currentTarget as HTMLInputElement & { showPicker?: () => void }).showPicker?.(); } catch { /* غير مدعوم */ } }}
            onChange={(e) => pick(e.target.value)} />
        </span>
      </div>
      <div className="mt-1.5 text-base font-semibold" aria-live="polite">{longDate(value)}</div>
      {hint ? <div className="text-sm text-muted">{hint}</div> : null}
    </fieldset>
  );
}
