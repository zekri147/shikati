// بطاقة تأكيد الإيداع: من شاشة الإيداع لعدة شيكات، ومن صفحة الشيك لشيك واحد.
import { useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { CLOSE_MS, Modal, ModalActions } from '@/components/ui/dialog';
import { DateField } from '@/components/ui/datefield';
import { Amount, Num } from '@/components/ltr';
import { FormError, Note } from '@/components/shell';
import { api, errText, isCutOff } from '@/lib/api';
import { chequeWord, sum, todayIso } from '@/lib/format';
import { cn } from '@/lib/utils';
import { ChequeImage } from './media';
import type { Cheque } from './types';

type RowState = { cls: 'muted' | 'ok' | 'warn' | 'err' | ''; text: string };

// بطاقة تأكيد الإيداع: الشيكات بصورها، والمجموع، وتاريخ الإيداع. يُرسل كل شيك مرة واحدة،
// وإن انقطع الرد يتوقف الإيداع ولا يُحاوَل أي شيك آخر (لا إعادة تلقائية).
export function DepositDialog({ items, onClosed }: { items: Cheque[]; onClosed: (r: { done: Cheque[]; failed: Cheque[]; attempted: boolean }) => void }) {
  const single = items.length === 1;
  const today = todayIso();
  const minDate = items.map((c) => String(c.date || '').slice(0, 10)).sort().pop() || '';
  const [date, setDate] = useState(today);
  const [rows, setRows] = useState<Record<string, RowState>>({});
  const [phase, setPhase] = useState<'ready' | 'busy' | 'finished'>('ready');
  const [message, setMessage] = useState<{ tone: 'err' | 'warn'; text: string } | null>(null);
  const [open, setOpen] = useState(true);
  const result = useRef({ done: [] as Cheque[], failed: [] as Cheque[], attempted: false });

  const close = () => { if (phase === 'busy') return; setOpen(false); setTimeout(() => onClosed(result.current), CLOSE_MS); };

  async function run() {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || date > today || (minDate && date < minDate)) {
      setMessage({ tone: 'err', text: minDate && date < minDate ? 'تاريخ الإيداع قبل تاريخ استلام الشيك. صحّحه.' : 'اختر تاريخ إيداع صحيحاً، لا يكون بعد اليوم.' });
      return;
    }
    setMessage(null);
    setPhase('busy');
    result.current.attempted = true;
    let warnings = 0;
    let stopped = false;
    const set = (id: string, r: RowState) => setRows((s) => ({ ...s, [id]: r }));
    for (const c of items) {
      if (stopped) { set(c.id, { cls: 'muted', text: 'لم يُحاوَل، فقد توقف الإيداع' }); continue; }
      set(c.id, { cls: 'muted', text: 'جارٍ التسجيل…' });
      try {
        const res = await api('/api/m/cheques/deposit', { method: 'POST', body: { payment_id: c.id, amount: c.amount, cheque_number: c.cheque_number, date } });
        result.current.done.push(c);
        if (res.warning) { warnings++; set(c.id, { cls: 'warn', text: res.warning }); } else set(c.id, { cls: 'ok', text: 'تم الإيداع' });
      } catch (e) {
        result.current.failed.push(c);
        set(c.id, { cls: 'err', text: errText(e) });
        // انقطاع الرد بعد محاولة الإيداع: لا نكمل أي شيك آخر
        if (isCutOff(e)) stopped = true;
      }
    }
    setPhase('finished');
    if (!result.current.failed.length && !warnings) { setTimeout(() => { setOpen(false); onClosed(result.current); }, 700); return; }
    setMessage(stopped
      ? { tone: 'err', text: 'توقف الإيداع، ولم تُحاوَل الشيكات الباقية. اتبع الرسالة تحت الشيك.' }
      : { tone: 'warn', text: `أُودع ${result.current.done.length} من أصل ${items.length}. راجع الرسائل أعلاه.` });
  }

  const title = single ? 'تأكيد إيداع شيك في بنك AGB' : `تأكيد إيداع ${chequeWord(items.length, true)} في بنك AGB`;
  return (
    <Modal open={open} onClose={close} busy={phase === 'busy'} title={title}>
      <ul className="m-0 mb-2 list-none p-0">
        {items.map((c) => {
          const r = rows[c.id];
          return (
            <li key={c.id} className={cn('grid items-start gap-3 border-b border-line py-3', single ? 'grid-cols-1' : 'grid-cols-[76px_1fr]')}>
              <ChequeImage id={c.id} hasImage={!!c.has_image} v={c.v} size={single ? 'big' : 'thumb'} />
              <div className="flex min-w-0 flex-col gap-1 text-base [overflow-wrap:anywhere]">
                <div className="font-semibold">{c.customer}</div>
                <div className="text-sm text-muted">شيك رقم {c.cheque_number ? <Num>{c.cheque_number}</Num> : 'غير مسجّل'}</div>
                <Amount value={c.amount} className="font-display text-base font-semibold" />
                {/* الإيداع لا يشترط العهدة، لكن من يودع شيكاً عند غيره يُنبَّه */}
                {c.custody && !c.custody.mine && (c.custody.holder || c.custody.to) ? (
                  <Note tone="warn" compact>{c.custody.incoming ? 'سُلّم إليك ولم تؤكد استلامه بعد.' : `في عهدة ${c.custody.holder || c.custody.to}. تأكد أنه معك قبل الإيداع.`}</Note>
                ) : null}
                {r ? <div className={cn('mt-1 text-sm', r.cls === 'ok' && 'font-semibold text-success', r.cls === 'err' && 'text-danger', r.cls === 'muted' && 'text-muted')}>
                  {r.cls === 'ok' ? '✓ ' : r.cls === 'warn' ? <span className="text-warning">⚠ </span> : null}{r.text}</div> : null}
              </div>
            </li>
          );
        })}
      </ul>
      {!single ? (
        <div className="mb-2 flex items-baseline justify-between border-b-2 border-foreground py-2 text-base">
          <span>المجموع</span><Amount value={sum(items)} className="font-display text-lg font-semibold" />
        </div>
      ) : null}
      <DateField label="تاريخ الإيداع" value={date} max={today} min={minDate || undefined} disabled={phase !== 'ready'} onChange={setDate} />
      <p className="text-sm text-muted">تأكد أن هذه الشيكات سُلِّمت فعلاً للبنك، وطابقها مع صورها. سيُسجَّل الإيداع في زوهو باسمك.</p>
      {message ? (message.tone === 'err' ? <FormError>{message.text}</FormError>
        : <Note tone="warn" className="mt-2 text-base">{message.text}</Note>) : null}
      <ModalActions>
        {phase !== 'finished' ? (
          <Button variant="primary" disabled={phase === 'busy'} onClick={run} autoFocus>
            {phase === 'busy' ? 'جارٍ التسجيل…' : single ? 'تأكيد الإيداع' : `تأكيد إيداع ${chequeWord(items.length, true)}`}
          </Button>
        ) : null}
        <Button disabled={phase === 'busy'} onClick={close}>{phase === 'finished' ? 'إغلاق' : 'إلغاء'}</Button>
      </ModalActions>
    </Modal>
  );
}
