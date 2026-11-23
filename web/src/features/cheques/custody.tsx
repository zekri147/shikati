// العهدة: من يحمل الشيك فعلياً (المرحلة الثانية من خطة التحصيل، 7/11/2026).
// في قاعدة التطبيق وحدها. منذ 23/11/2026 (بطلب ZEKRI): التسليم ببطاقة تأكيد تعرض الشيكات والمستلم،
// ولعدة شيكات مرة واحدة، والمستلم يرى لوحاً واضحاً في شاشة الإيداع يؤكد منه الاستلام.
// الشيك المسلَّم لا يُودَع ولا يُظهَّر حتى يؤكد المستلم أو يُلغى التسليم (الفحص في الخادم).
import { useEffect, useRef, useState } from 'react';
import { ChevronLeft } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { CLOSE_MS, Modal, ModalActions, Sheet, SheetOption } from '@/components/ui/dialog';
import { Amount, Num } from '@/components/ltr';
import { FormError, Note } from '@/components/shell';
import { toast } from '@/components/toast';
import { api, errText } from '@/lib/api';
import { chequeWord, sum } from '@/lib/format';
import { haptic } from '@/lib/motion';
import { cn } from '@/lib/utils';
import { ChequeImage } from './media';
import { Block } from './pickers';
import type { Cheque, Custody } from './types';

// ما يلزم لعرض الشيك في بطاقة التسليم ولوح الاستلام
export type HandCheque = Pick<Cheque, 'id' | 'customer' | 'cheque_number' | 'amount' | 'has_image' | 'v'> & { custody?: Custody };

export type CustodyDetail = Custody & { since: string | null; actions: ('take' | 'give' | 'accept' | 'refuse' | 'cancel')[] };

// نص العهدة القصير في بطاقة الشيك: «عندك» أو «عند أمين»، أو التسليم المعلّق
export function custodyShort(k?: Custody): string | null {
  if (!k) return null;
  if (k.incoming) return 'سُلّم إليك';
  if (k.to) return 'بانتظار ' + k.to;
  if (k.mine) return 'عندك';
  return k.holder ? 'عند ' + k.holder : null;
}

// تصفية شاشة الإيداع بالعهدة
export const CUSTODY_FILTERS: [string, string][] = [['', 'كل العهد'], ['mine', 'في عهدتي'], ['others', 'عند غيري'], ['none', 'غير محددة']];
export function byCustody(k: Custody | undefined, f: string): boolean {
  if (!f) return true;
  if (f === 'mine') return !!k && (k.mine || k.incoming);
  if (f === 'others') return !!k && !!k.holder && !k.mine && !k.incoming;
  return !k || (!k.holder && !k.to);
}

type Person = { id: number; display_name: string; role: string };

export function CustodyBlock({ id, k, cheque, onChanged }: { id: string; k: CustodyDetail; cheque: HandCheque; onChanged: () => void }) {
  const [busy, setBusy] = useState(false);
  const [giving, setGiving] = useState(false);

  async function act(action: string, to?: number) {
    setBusy(true);
    try {
      const r = await api('/api/m/cheques/custody', { method: 'POST', body: { payment_id: id, action, to } });
      haptic('success');
      toast(r.message);
      onChanged();
    } catch (e) {
      toast(errText(e), 'err');
    } finally {
      setBusy(false);
    }
  }

  const has = (a: CustodyDetail['actions'][number]) => k.actions.includes(a);
  const who = k.mine ? 'في عهدتك' : k.holder ? 'في عهدة ' + k.holder : 'العهدة غير محددة';
  return (
    <Block title="العهدة: من يحمل الشيك">
      <p className="m-0 py-1 text-base font-semibold">{who}</p>
      {!k.holder && !k.to ? <p className="m-0 text-sm text-muted">سُجّل قبل العهدة أو من خارج التطبيق. إن كان الشيك معك، اضغط «هو في عهدتي».</p> : null}
      {k.incoming ? <Note tone="warn" className="mt-1">سلّمه إليك {k.from || 'زميل'}. أكّد استلامه إن كان في يدك، أو اضغط «ليس معي». لا يُودَع قبل تأكيدك.</Note>
        : k.to ? <Note tone="warn" className="mt-1">سلّمه {k.outgoing ? 'أنت' : k.from || '—'} إلى {k.to}، وينتظر تأكيد الاستلام. لا يُودَع ولا يُظهَّر قبل ذلك.</Note> : null}
      {k.actions.length ? (
        <div className="mt-2 flex flex-wrap gap-2 pb-2 [&>button]:flex-1">
          {has('accept') ? <Button variant="primary" className="py-2" disabled={busy} onClick={() => act('accept')}>{busy ? 'جارٍ الحفظ…' : 'استلمته، هو في يدي'}</Button> : null}
          {has('refuse') ? <Button className="py-2" disabled={busy} onClick={() => act('refuse')}>ليس معي</Button> : null}
          {has('give') ? <Button className="py-2" disabled={busy} onClick={() => setGiving(true)}>سلّمته إلى زميل…</Button> : null}
          {has('take') ? <Button className="py-2" disabled={busy} onClick={() => act('take')}>{busy ? 'جارٍ الحفظ…' : 'هو في عهدتي'}</Button> : null}
          {has('cancel') ? <Button className="py-2" disabled={busy} onClick={() => act('cancel')}>ألغِ التسليم</Button> : null}
        </div>
      ) : null}
      {giving ? <HandoverDialog items={[{ ...cheque, custody: k }]} onClosed={(r) => { setGiving(false); if (r.done.length) { toast(`سُلّم الشيك إلى ${r.to}، وينتظر تأكيده.`); onChanged(); } }} /> : null}
    </Block>
  );
}

// ——— التسليم إلى زميل: بطاقة تأكيد تعرض الشيكات والمستلم، لشيك واحد أو لعدة شيكات ———

export function HandoverDialog({ items, onClosed }: { items: HandCheque[]; onClosed: (r: { done: string[]; to: string }) => void }) {
  const single = items.length === 1;
  const [people, setPeople] = useState<Person[] | null>(null);
  const [to, setTo] = useState<Person | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [phase, setPhase] = useState<'ready' | 'busy' | 'finished'>('ready');
  const [message, setMessage] = useState('');
  const [open, setOpen] = useState(true);
  const done = useRef<string[]>([]);

  useEffect(() => {
    api('/api/m/cheques/custody/people').then((r) => setPeople(r.people)).catch((e) => setMessage(errText(e)));
  }, []);

  const finish = () => { setOpen(false); setTimeout(() => onClosed({ done: done.current, to: to?.display_name || '' }), CLOSE_MS); };
  const close = () => { if (phase !== 'busy') finish(); };

  async function run() {
    if (!to) { setMessage(`اختر من سلّمته ${single ? 'الشيك' : 'الشيكات'}.`); return; }
    setMessage('');
    setPhase('busy');
    try {
      const r = await api('/api/m/cheques/custody/batch', { method: 'POST', body: { action: 'give', payment_ids: items.map((c) => c.id), to: to.id } });
      const errs: Record<string, string> = {};
      for (const x of r.results as { id: string; ok: boolean; error?: string }[]) {
        if (x.ok) done.current.push(x.id); else errs[x.id] = x.error || 'لم يُسلَّم.';
      }
      setErrors(errs);
      setPhase('finished');
      if (!Object.keys(errs).length) { haptic('success'); setTimeout(finish, 600); return; }
      setMessage(done.current.length ? `سُلّم ${done.current.length} من أصل ${items.length}. راجع السبب تحت ما لم يُسلَّم.` : 'لم يُسلَّم أي شيك. راجع السبب تحت كل شيك.');
    } catch (e) {
      setPhase('ready');
      setMessage(errText(e));
    }
  }

  const name = to?.display_name || '';
  const title = single ? 'تسليم شيك إلى زميل' : `تسليم ${chequeWord(items.length, true)} إلى زميل`;
  return (
    <Modal open={open} onClose={close} busy={phase === 'busy'} title={title}>
      <ul className="m-0 mb-2 list-none p-0">
        {items.map((c) => (
          <li key={c.id} className="grid grid-cols-[76px_1fr] items-start gap-3 border-b border-line py-3">
            <ChequeImage id={c.id} hasImage={!!c.has_image} v={c.v} size="thumb" />
            <div className="flex min-w-0 flex-col gap-1 text-base [overflow-wrap:anywhere]">
              <div className="font-semibold">{c.customer}</div>
              <div className="text-sm text-muted">شيك رقم {c.cheque_number ? <Num>{c.cheque_number}</Num> : 'غير مسجّل'}</div>
              <Amount value={c.amount} className="font-display text-base font-semibold" />
              {errors[c.id] ? <div className="text-sm text-danger">{errors[c.id]}</div>
                : phase === 'finished' ? <div className="text-sm font-semibold text-success">✓ سُلّم، وينتظر تأكيد {name}</div> : null}
            </div>
          </li>
        ))}
      </ul>
      {!single ? (
        <div className="mb-3 flex items-baseline justify-between border-b-2 border-foreground py-2 text-base">
          <span>المجموع</span><Amount value={sum(items)} className="font-display text-lg font-semibold" />
        </div>
      ) : null}
      <div className="mb-2 text-base font-semibold">إلى من سلّمت{single ? 'ه' : 'ها'}؟</div>
      {people ? people.length ? (
        <div className={cn('mb-3 border border-line', phase !== 'ready' && 'pointer-events-none opacity-60')}>
          {people.map((p) => (
            <SheetOption key={p.id} selected={to?.id === p.id} label={p.display_name} meta={p.role === 'admin' ? 'المدير' : 'مندوب'}
              onClick={() => { setTo(p); setMessage(''); }} />
          ))}
        </div>
      ) : <p className="text-sm text-muted">لا يوجد مستخدم آخر نشط.</p>
        : !message ? <p className="text-sm text-muted">جارٍ تحميل الزملاء…</p> : null}
      <p className="text-sm text-muted">
        {single ? 'يبقى الشيك في عهدتك' : 'تبقى الشيكات في عهدتك'} حتى يؤكد {name || 'المستلم'} أن{single ? 'ه' : 'ها'} في يده.
        وقبل التأكيد لا {single ? 'يُودَع ولا يُظهَّر' : 'تُودَع ولا تُظهَّر'}. سيصله إشعار ليؤكد.
      </p>
      {message ? <FormError>{message}</FormError> : null}
      <ModalActions>
        {phase !== 'finished' ? (
          <Button variant="primary" disabled={phase === 'busy'} onClick={run}>
            {phase === 'busy' ? 'جارٍ التسليم…' : name ? `سلّمت${single ? 'ه' : 'ها'} إلى ${name}` : `سلّمت ${single ? 'الشيك' : chequeWord(items.length, true)}`}
          </Button>
        ) : null}
        <Button disabled={phase === 'busy'} onClick={close}>{phase === 'finished' ? 'إغلاق' : 'إلغاء'}</Button>
      </ModalActions>
    </Modal>
  );
}

// ——— للمستلم: لوح في شاشة الإيداع بما سُلّم إليه، ولوحة يؤكد منها الاستلام ———

type RowResult = { tone: 'ok' | 'muted' | 'err'; text: string };

export function IncomingPanel({ items, onChanged }: { items: HandCheque[]; onChanged: () => void }) {
  const [open, setOpen] = useState(false);
  // الشيكات كما كانت عند فتح اللوحة، فلا تختفي من أمامه حين تتحدث القائمة بعد التأكيد
  const [snap, setSnap] = useState<HandCheque[]>([]);
  const [busy, setBusy] = useState('');
  const [rows, setRows] = useState<Record<string, RowResult>>({});
  if (!items.length && !open) return null;

  const givers = [...new Set(items.map((c) => c.custody?.from).filter(Boolean))].join(' و');
  const pending = snap.filter((c) => !rows[c.id]);
  const show = () => { setSnap(items); setRows({}); setOpen(true); };
  const close = () => { if (!busy) setOpen(false); };

  async function acceptAll() {
    setBusy('all');
    try {
      const r = await api('/api/m/cheques/custody/batch', { method: 'POST', body: { action: 'accept', payment_ids: pending.map((c) => c.id) } });
      const next = { ...rows };
      let ok = 0;
      for (const x of r.results as { id: string; ok: boolean; error?: string }[]) {
        next[x.id] = x.ok ? { tone: 'ok', text: 'استلمته، وصار في عهدتك' } : { tone: 'err', text: x.error || 'لم يُسجَّل.' };
        if (x.ok) ok++;
      }
      setRows(next);
      if (ok) { haptic('success'); toast(ok === 1 ? 'استلمت الشيك، وصار في عهدتك.' : `استلمت ${chequeWord(ok, true)}، وصارت في عهدتك.`); }
      onChanged();
      if (ok === pending.length) setTimeout(() => setOpen(false), 600);
    } catch (e) {
      toast(errText(e), 'err');
    } finally {
      setBusy('');
    }
  }

  async function refuse(c: HandCheque) {
    setBusy(c.id);
    try {
      await api('/api/m/cheques/custody', { method: 'POST', body: { payment_id: c.id, action: 'refuse' } });
      setRows((s) => ({ ...s, [c.id]: { tone: 'muted', text: `رفضته، فبقي عند ${c.custody?.from || 'من سلّمه'}` } }));
      onChanged();
    } catch (e) {
      setRows((s) => ({ ...s, [c.id]: { tone: 'err', text: errText(e) } }));
    } finally {
      setBusy('');
    }
  }

  return (
    <>
      {items.length ? (
        <button type="button" onClick={show}
          className="incoming mt-3 flex min-h-14 w-full items-center gap-2 border-s-3 border-s-brand bg-brand-tint px-4 py-2 text-start text-foreground active:bg-surface-alt">
          <span className="flex min-w-0 flex-1 flex-col">
            <span className="text-base font-semibold">{items.length === 1 ? 'سُلّم إليك شيك' : `سُلّمت إليك ${chequeWord(items.length)}`} · <Amount value={sum(items)} /></span>
            <span className="text-sm text-muted">من {givers || 'زميل'}. أكّد استلام{items.length === 1 ? 'ه' : 'ها'} قبل أي عملية.</span>
          </span>
          <span className="flex-none text-sm font-semibold">أكّد الاستلام</span>
          <ChevronLeft aria-hidden className="size-4.5 flex-none text-soft" />
        </button>
      ) : null}
      <Sheet open={open} onClose={close} title="تأكيد الاستلام" action={<Button disabled={!!busy} onClick={close}>إغلاق</Button>}>
        <p className="m-0 px-4 pb-2 text-sm text-muted">طابق كل شيك في يدك مع صورته. ما ليس معك اضغط تحته «ليس معي»، فيبقى عند من سلّمه.</p>
        <ul className="m-0 list-none border-t border-line p-0">
          {snap.map((c) => {
            const r = rows[c.id];
            return (
              <li key={c.id} className="grid grid-cols-[76px_1fr] items-start gap-3 border-b border-line px-4 py-3">
                <ChequeImage id={c.id} hasImage={!!c.has_image} v={c.v} size="thumb" />
                <div className="flex min-w-0 flex-col gap-1 text-base [overflow-wrap:anywhere]">
                  <div className="font-semibold">{c.customer}</div>
                  <div className="text-sm text-muted">شيك رقم {c.cheque_number ? <Num>{c.cheque_number}</Num> : 'غير مسجّل'} · من {c.custody?.from || 'زميل'}</div>
                  <Amount value={c.amount} className="font-display text-base font-semibold" />
                  {r ? <div className={cn('text-sm', r.tone === 'ok' && 'font-semibold text-success', r.tone === 'err' && 'text-danger', r.tone === 'muted' && 'text-muted')}>{r.tone === 'ok' ? '✓ ' : ''}{r.text}</div>
                    : <Button className="mt-1 self-start px-4 py-1" disabled={!!busy} onClick={() => refuse(c)}>{busy === c.id ? 'جارٍ الحفظ…' : 'ليس معي'}</Button>}
                </div>
              </li>
            );
          })}
        </ul>
        {pending.length ? (
          <div className="px-4 pb-2 pt-3">
            <Button variant="primary" className="w-full py-3" disabled={!!busy} onClick={acceptAll}>
              {busy === 'all' ? 'جارٍ الحفظ…' : pending.length === 1 ? 'استلمته، هو في يدي' : pending.length === 2 ? 'استلمت الشيكين، هما في يدي' : `استلمت ${chequeWord(pending.length)}، كلها في يدي`}
            </Button>
          </div>
        ) : null}
      </Sheet>
    </>
  );
}
