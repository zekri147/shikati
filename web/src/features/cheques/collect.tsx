// بطاقة تأكيد التحصيل اليدوي لشيكات ELONAC المودعة في بنك AGB، للمدير وحده (بطلب ZEKRI يوم 24/11/2026):
// تحصيلها الآلي من رسائل البنك لا يعمل حالياً. من قسم «بانتظار التحصيل» لعدة شيكات، ومن صفحة الشيك لشيك واحد.
// يُرسل كل شيك مرة واحدة، وإن انقطع الرد يتوقف ولا يُحاوَل أي شيك آخر (لا إعادة تلقائية).
import { useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { CLOSE_MS, Modal, ModalActions } from '@/components/ui/dialog';
import { DateField } from '@/components/ui/datefield';
import { Amount, Num } from '@/components/ltr';
import { FormError, Note } from '@/components/shell';
import { api, errText, isCutOff } from '@/lib/api';
import { chequeWord, fmtDate, sum, todayIso } from '@/lib/format';
import { cn } from '@/lib/utils';
import type { Cheque } from './types';

type RowState = { cls: 'muted' | 'ok' | 'err'; text: string };

export function CollectDialog({ items, onClosed }: { items: Cheque[]; onClosed: (r: { done: Cheque[]; failed: Cheque[]; attempted: boolean }) => void }) {
  const single = items.length === 1;
  const today = todayIso();
  // لا تحصيل قبل الإيداع: أحدث تاريخ إيداع بين المحدد
  const minDate = items.map((c) => String(c.deposit_date || c.date || '').slice(0, 10)).sort().pop() || '';
  const [date, setDate] = useState(today);
  const [rows, setRows] = useState<Record<string, RowState>>({});
  const [phase, setPhase] = useState<'ready' | 'busy' | 'finished'>('ready');
  const [message, setMessage] = useState<{ tone: 'err' | 'warn'; text: string } | null>(null);
  const [open, setOpen] = useState(true);
  const result = useRef({ done: [] as Cheque[], failed: [] as Cheque[], attempted: false });

  const close = () => { if (phase === 'busy') return; setOpen(false); setTimeout(() => onClosed(result.current), CLOSE_MS); };

  async function run() {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || date > today || (minDate && date < minDate)) {
      setMessage({ tone: 'err', text: minDate && date < minDate ? 'تاريخ التحصيل قبل تاريخ الإيداع. صحّحه.' : 'اختر تاريخ تحصيل صحيحاً، لا يكون بعد اليوم.' });
      return;
    }
    setMessage(null);
    setPhase('busy');
    result.current.attempted = true;
    let stopped = false;
    const set = (id: string, r: RowState) => setRows((s) => ({ ...s, [id]: r }));
    for (const c of items) {
      if (stopped) { set(c.id, { cls: 'muted', text: 'لم يُحاوَل، فقد توقف التحصيل' }); continue; }
      set(c.id, { cls: 'muted', text: 'جارٍ التسجيل…' });
      try {
        await api('/api/m/cheques/collect', { method: 'POST', body: { payment_id: c.id, date } });
        result.current.done.push(c);
        set(c.id, { cls: 'ok', text: 'حُصّل' });
      } catch (e) {
        result.current.failed.push(c);
        set(c.id, { cls: 'err', text: errText(e) });
        if (isCutOff(e)) stopped = true;
      }
    }
    setPhase('finished');
    if (!result.current.failed.length) { setTimeout(() => { setOpen(false); onClosed(result.current); }, 700); return; }
    setMessage(stopped
      ? { tone: 'err', text: 'توقف التحصيل، ولم تُحاوَل الشيكات الباقية. اتبع الرسالة تحت الشيك.' }
      : { tone: 'warn', text: `حُصّل ${result.current.done.length} من أصل ${items.length}. راجع الرسائل أعلاه.` });
  }

  return (
    <Modal open={open} onClose={close} busy={phase === 'busy'} title={single ? 'تأكيد تحصيل شيك' : `تأكيد تحصيل ${chequeWord(items.length, true)}`}>
      <ul className="m-0 mb-2 list-none p-0">
        {items.map((c) => {
          const r = rows[c.id];
          return (
            <li key={c.id} className="flex flex-col gap-1 border-b border-line py-3 text-base [overflow-wrap:anywhere]">
              <div className="flex items-baseline justify-between gap-3">
                <span className="font-semibold">{c.customer}</span>
                <Amount value={c.amount} className="whitespace-nowrap font-display text-base font-semibold" />
              </div>
              <div className="text-sm text-muted">
                شيك رقم {c.cheque_number ? <Num>{c.cheque_number}</Num> : 'غير مسجّل'}
                {c.deposit_date ? <> · أُودع <Num>{fmtDate(c.deposit_date)}</Num></> : null}
              </div>
              {r ? <div className={cn('mt-1 text-sm', r.cls === 'ok' && 'font-semibold text-success', r.cls === 'err' && 'text-danger', r.cls === 'muted' && 'text-muted')}>
                {r.cls === 'ok' ? '✓ ' : null}{r.text}</div> : null}
            </li>
          );
        })}
      </ul>
      {!single ? (
        <div className="mb-2 flex items-baseline justify-between border-b-2 border-foreground py-2 text-base">
          <span>المجموع</span><Amount value={sum(items)} className="font-display text-lg font-semibold" />
        </div>
      ) : null}
      <DateField label="تاريخ التحصيل" value={date} max={today} min={minDate || undefined} disabled={phase !== 'ready'} onChange={setDate} />
      <p className="text-sm text-muted">
        تأكد من كشف البنك أن {single ? 'هذا الشيك حُصّل' : 'هذه الشيكات حُصّلت'} فعلاً. ستصير الحالة «محصّل» في زوهو، ويُكتب في سجل الشيك أنه تحصيل يدوي باسمك. يمكنك التراجع عنه من صفحة الشيك.
      </p>
      {message ? (message.tone === 'err' ? <FormError>{message.text}</FormError>
        : <Note tone="warn" className="mt-2 text-base">{message.text}</Note>) : null}
      <ModalActions>
        {phase !== 'finished' ? (
          <Button variant="primary" disabled={phase === 'busy'} onClick={run} autoFocus>
            {phase === 'busy' ? 'جارٍ التسجيل…' : single ? 'تأكيد التحصيل' : `تأكيد تحصيل ${chequeWord(items.length, true)}`}
          </Button>
        ) : null}
        <Button disabled={phase === 'busy'} onClick={close}>{phase === 'finished' ? 'إغلاق' : 'إلغاء'}</Button>
      </ModalActions>
    </Modal>
  );
}
