// تحويل بنكي من عميل (بموافقة ZEKRI يوم 21/11/2026): دفعة عميل بطريقة «تحويل بنكي» موزّعة على أقدم فواتيره.
// منذ 25/11/2026: في الحوزة ثم إيداع فوري في البنك المختار، كما تفرض قاعدة التحقق في زوهو. لا عهدة، ولا يظهر في قوائم الشيكات.
// منذ 24/11/2026 (بطلب ZEKRI): بحالة «مودع في البنك»، والمدير يحصّله من «في البنك بانتظار التحصيل» كالشيك،
// وصورة الإشعار إجبارية، والتحويل المحصّل لا يُحذف حتى يُتراجع عن تحصيله من صفحته.
// لا يُكتب شيء في زوهو قبل «سجّل التحويل» في بطاقة التأكيد، ولا إعادة بعد انقطاع الرد.
// تحته «تحويلات سجّلتها»: آخر 30 يوماً، ومنها التراجع (حذف الدفعة) لصاحب التحويل وللمدير.
import { useCallback, useEffect, useRef, useState } from 'react';
import { MoreVertical } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Field, Input } from '@/components/ui/input';
import { DateField } from '@/components/ui/datefield';
import { CLOSE_MS, Modal, ModalActions } from '@/components/ui/dialog';
import { Menu, MenuContent, MenuItem, MenuTrigger } from '@/components/ui/dropdown';
import { Segmented } from '@/components/ui/segmented';
import { Amount, Ltr, Num } from '@/components/ltr';
import { FormError, Note } from '@/components/shell';
import { toast } from '@/components/toast';
import { api, errText, isCutOff } from '@/lib/api';
import { fmtDate, newRequestId, parseAmount, todayIso } from '@/lib/format';
import { cn } from '@/lib/utils';
import { AllocList, Block, KV, PartyPicker, type Party } from './pickers';
import { GroupField, PhotoButtons } from './edit';
import { shrink } from './media';
import { CardList, detailHash } from './ui';
import { Step, StepsProgress, type Options } from './register';
import type { Line } from './types';

type Preview = { lines: Line[]; unused: number };
type Form = {
  requestId: string; customer: Party; amount: number; date: string; reference: string;
  bank: string; bankLabel: string; location: string; locationLabel: string; image: string;
};

// العميل والموقع من الشاشة الأم، فيبقيان عند التبديل بين الشيك والتحويل
export function TransferForm({ opts, customer, setCustomer, location, setLocation, onDone }: {
  opts: Options; customer: Party | null; setCustomer: (p: Party | null) => void;
  location: string; setLocation: (v: string) => void; onDone: (pid: string) => void;
}) {
  const banks = opts.transfer_banks || [];
  const [amount, setAmount] = useState('');
  const today = todayIso();
  const [date, setDate] = useState(today);
  const [reference, setReference] = useState('');
  const [bank, setBank] = useState('');
  const [image, setImage] = useState('');
  const [error, setError] = useState('');
  const [loud, setLoud] = useState(false);
  const [checking, setChecking] = useState(false);
  const [confirm, setConfirm] = useState<Preview | null>(null);
  const [listKey, setListKey] = useState(0);
  const requestId = useRef(newRequestId());
  const locked = useRef(false);
  const errRef = useRef<HTMLDivElement>(null);

  // الترتيب نفسه في تسجيل الشيك: الصورة، ثم العميل، ثم المبلغ والتاريخ، ثم البنك والموقع (بطلب ZEKRI يوم 24/11/2026)
  const missing: string[] = [];
  if (!image) missing.push('صورة الإشعار');
  if (!customer) missing.push('العميل');
  if (!parseAmount(amount)) missing.push('المبلغ');
  if (!date) missing.push('التاريخ');
  if (!bank) missing.push('الوجهة');
  if (!location) missing.push('الموقع');

  // قراءة الإشعار بكلود (24/11/2026، بطلب ZEKRI): المبلغ والتاريخ والمرجع، اقتراحاً يراجعه الموظف كما في الشيك
  const [reading, setReading] = useState(false);
  const [readNote, setReadNote] = useState<{ tone?: 'warn' | 'ok'; text: string } | null>(null);
  async function onFile(f: File) {
    let shot: string;
    try { shot = await shrink(f); } catch (e) { toast(errText(e), 'err'); return; }
    setImage(shot);
    if (!opts.reader) { setReadNote({ text: 'القراءة الآلية غير مُعدّة بعد. اكتب البيانات بيدك.' }); return; }
    setReadNote({ text: 'جارٍ قراءة الإشعار…' });
    setReading(true);
    try {
      const { reading: r } = await api<{ reading: { amount: number | null; date: string | null; reference: string | null; note: string | null } }>(
        '/api/m/cheques/register/read', { method: 'POST', body: { image: shot, kind: 'transfer' } });
      const filled: string[] = [];
      if (r.amount) { setAmount(String(r.amount)); filled.push('المبلغ'); }
      if (r.date && r.date <= today) { setDate(r.date); filled.push('التاريخ'); }
      if (r.reference) { setReference(r.reference); filled.push('المرجع'); }
      setReadNote({
        tone: r.note ? 'warn' : 'ok',
        text: (filled.length ? 'قُرئ: ' + filled.join('، ') + '. راجعها مع الصورة.' : 'لم تُقرأ أي بيانات بثقة. اكتبها بيدك.') + (r.note ? ' ملاحظة: ' + r.note : ''),
      });
    } catch (e) {
      setReadNote({ tone: 'warn', text: errText(e) });
    } finally {
      setReading(false);
    }
  }

  async function submit() {
    setError('');
    if (missing.length) { setLoud(true); return; }
    const show = (t: string) => { setError(t); setTimeout(() => errRef.current?.scrollIntoView({ block: 'center' }), 0); };
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || date > today) { show('تاريخ التحويل لا يكون بعد اليوم.'); return; }
    if (locked.current) { show('محاولة التسجيل السابقة لم تُعرف نتيجتها. لا تعد المحاولة، وأخبر المدير ليتحقق.'); return; }
    setChecking(true);
    try {
      setConfirm(await api<Preview>('/api/m/cheques/register/preview', { method: 'POST', body: { customer_id: customer!.id, amount: parseAmount(amount) } }));
    } catch (e) {
      show(errText(e));
    } finally {
      setChecking(false);
    }
  }

  const form: Form | null = customer ? {
    requestId: requestId.current, customer, amount: parseAmount(amount) || 0, date, reference: reference.trim(),
    bank, bankLabel: banks.find((b) => b.key === bank)?.label || '', location,
    locationLabel: opts.locations.find((l) => l.key === location)?.label || '', image,
  } : null;

  function reset() {
    setAmount(''); setDate(today); setReference(''); setBank(''); setImage(''); setReadNote(null); setLoud(false);
    setCustomer(null);
    requestId.current = newRequestId();
  }

  return (
    <>
      <StepsProgress done={[!!image, !!customer, !!parseAmount(amount) && !!date, !!bank && !!location]} />
      <Step n={1} title="صورة إشعار التحويل" done={!!image}>
        {image ? <img src={image} alt="صورة إشعار التحويل" className="mt-1 block max-h-[260px] w-full border border-line bg-surface-alt object-contain" /> : null}
        <PhotoButtons first={!image} disabled={reading} onFile={onFile} shootLabel={image ? 'إعادة التصوير' : 'تصوير الإشعار'} />
        {readNote ? <Note tone={readNote.tone} className="mt-2">{readNote.text}</Note> : null}
      </Step>

      <Step n={2} title="العميل" done={!!customer}>
        <div className="py-2"><PartyPicker kind="customer" value={customer} onChange={setCustomer} /></div>
      </Step>

      {/* كالشيك: المبلغ والرقم (هنا المرجع) متجاوران، ثم التاريخ */}
      <Step n={3} title="المبلغ والمرجع والتاريخ" done={!!parseAmount(amount) && !!date}>
        <div className="grid grid-cols-2 gap-x-3">
          <Field label="المبلغ (دج)"><Input inputMode="decimal" dir="ltr" placeholder="0.00" autoComplete="off" value={amount} onChange={(e) => setAmount(e.target.value)} /></Field>
          <Field label="رقم المرجع (اختياري)">
            <Input dir="ltr" maxLength={50} placeholder="من الإشعار" autoComplete="off" value={reference} onChange={(e) => setReference(e.target.value)} />
          </Field>
        </div>
        <DateField label="تاريخ التحويل" value={date} max={today} onChange={setDate} hint="يوم وصول المبلغ إلى البنك، وهو تاريخ الدفعة في زوهو." />
      </Step>

      {/* كالشيك: الوجهة ثم الموقع. وجهة التحويل هي البنك الذي استلمه */}
      <Step n={4} title="الوجهة والموقع" done={!!bank && !!location}>
        <GroupField label="الوجهة: البنك الذي استلم التحويل">
          <Segmented label="الوجهة: البنك الذي استلم التحويل" value={bank} onChange={setBank} options={banks.map((b) => ({ value: b.key, label: b.label }))} />
        </GroupField>
        <GroupField label="الموقع">
          <Segmented label="الموقع" value={location} onChange={setLocation} options={opts.locations.map((l) => ({ value: l.key, label: l.label }))} />
        </GroupField>
      </Step>

      <div ref={errRef}>{error ? <FormError>{error}</FormError> : null}</div>

      <TransfersList key={listKey} />

      <div className="formbar fixed inset-x-0 z-[21] flex flex-col gap-2 border-t border-line-strong bg-surface px-4 py-2 bottom-[calc(var(--nav-h,60px)+env(safe-area-inset-bottom))]">
        <div aria-live="polite" className={cn('min-w-0 text-sm leading-snug', loud && missing.length ? 'font-semibold text-danger' : 'text-muted')}>
          {missing.length ? 'ينقص: ' + missing.join('، ') : 'البيانات كاملة. راجعها ثم سجّل.'}
        </div>
        <Button variant="primary" className="w-full py-2" blocked={missing.length > 0} disabled={checking} onClick={submit}>
          {checking ? 'جارٍ حساب التوزيع…' : 'مراجعة وتسجيل'}
        </Button>
      </div>

      {confirm && form ? (
        <TransferConfirm form={form} preview={confirm} onClose={(res, cut) => {
          setConfirm(null);
          if (cut) { locked.current = true; setListKey((k) => k + 1); }
          if (res) {
            toast(res.warning || `سُجّل تحويل ${form.customer.name} إلى ${form.bankLabel}`, res.warning ? 'warn' : 'ok');
            reset();
            setListKey((k) => k + 1);
            // كالشيك: بعد التسجيل تُفتح صفحة التحويل
            setTimeout(() => onDone(res.payment_id), 0);
          }
        }} />
      ) : null}
    </>
  );
}

function TransferConfirm({ form, preview, onClose }: { form: Form; preview: Preview; onClose: (res: any, cut: boolean) => void }) {
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState('');
  const [cut, setCut] = useState(false);
  const [open, setOpen] = useState(true);
  const finish = (res: any) => {
    setOpen(false);
    setTimeout(() => onClose(res, cut), res ? 450 : 0);
  };

  async function run() {
    setBusy(true);
    setFailed('');
    try {
      const res = await api('/api/m/cheques/register/transfer', { method: 'POST', body: {
        request_id: form.requestId, customer_id: form.customer.id, customer: form.customer.name, amount: form.amount,
        date: form.date, reference: form.reference || undefined, bank: form.bank, location: form.location, image: form.image || undefined,
      } });
      setBusy(false);
      finish(res);
    } catch (e) {
      setFailed(errText(e));
      // لا إعادة: لا نعرف إن كان زوهو أنشأ الدفعة
      if (isCutOff(e)) setCut(true);
      setBusy(false);
    }
  }

  return (
    <Modal open={open} onClose={() => finish(null)} busy={busy} title="تأكيد تسجيل التحويل">
      {form.image ? <img src={form.image} alt="صورة إشعار التحويل" className="mt-1 block max-h-[200px] w-full border border-line bg-surface-alt object-contain" /> : null}
      <dl className="m-0 mt-2 flex flex-col">
        <KV label="العميل">{form.customer.name}</KV>
        <KV label="المبلغ"><Amount value={form.amount} /></KV>
        <KV label="البنك">{form.bankLabel}</KV>
        <KV label="تاريخ التحويل"><Num>{fmtDate(form.date)}</Num></KV>
        <KV label="رقم المرجع">{form.reference ? <Ltr>{form.reference}</Ltr> : ''}</KV>
        <KV label="الموقع">{form.locationLabel}</KV>
      </dl>
      <h3 className="mb-1 mt-3 text-base">التوزيع على الفواتير</h3>
      <AllocList lines={preview.lines} emptyText="لا فواتير غير مدفوعة لهذا العميل." />
      {preview.unused > 0 ? <Note tone="warn" className="mt-2">يبقى <Amount value={preview.unused} className="font-semibold" /> رصيداً مسبقاً للعميل.</Note> : null}
      <p className="text-sm text-muted">سيُسجَّل في زوهو باسمك تحويلاً، ثم يُودَع فوراً في {form.bankLabel} بحالة «مودع في البنك»، كما تُسجَّل التحويلات في زوهو. لا يحتاج عهدة. يحصّله المدير بعد أن يراه في كشف البنك.</p>
      {failed ? <FormError>{failed}</FormError> : null}
      <ModalActions>
        {!cut ? <Button variant="primary" disabled={busy} onClick={run}>{busy ? 'جارٍ التسجيل…' : 'سجّل التحويل'}</Button> : null}
        <Button disabled={busy} onClick={() => finish(null)}>{cut ? 'إغلاق' : 'رجوع للتعديل'}</Button>
      </ModalActions>
    </Modal>
  );
}

type Transfer = {
  id: string; payment_id: string | null; state: 'done' | 'unknown'; customer: string | null; amount: number; date: string;
  bank: string; reference: string | null; by: string | null; can_undo: boolean; collected: boolean;
};

// تحويلات سجّلتها: آخر 30 يوماً. الحذف داخل «المزيد» وببطاقة تأكيد، كما في صفحة الشيك
function TransfersList() {
  const [list, setList] = useState<Transfer[] | null>(null);
  const [error, setError] = useState('');
  const [undo, setUndo] = useState<Transfer | null>(null);
  const load = useCallback(() => {
    api<{ transfers: Transfer[] }>('/api/m/cheques/transfers').then((r) => { setList(r.transfers); setError(''); }).catch((e) => setError(errText(e)));
  }, []);
  useEffect(load, [load]);

  if (error) return <Note tone="warn">{error}</Note>;
  if (!list || !list.length) return null;
  return (
    <section className="mt-4">
      <h2 className="mb-2 mt-0 text-sm font-semibold text-muted">تحويلات سجّلتها في آخر 30 يوماً</h2>
      <CardList>
        {list.map((t) => (
          <li key={t.id} className="flex items-center gap-2 py-2 ps-4 pe-1">
            {/* المس التحويل لتفتح صفحته: منها يحصّله المدير أو يتراجع عن تحصيله */}
            <a href={t.payment_id ? detailHash(t.payment_id) : undefined} aria-label={`تفاصيل تحويل ${t.customer || ''}`}
              className="min-w-0 flex-1 text-inherit no-underline">
              <div className="flex items-baseline justify-between gap-2">
                <span className="min-w-0 truncate font-semibold">{t.customer}</span>
                <Amount value={t.amount} className="flex-none font-semibold" />
              </div>
              <div className="flex flex-wrap items-center gap-x-2 text-sm text-muted">
                <span>{t.bank}</span>
                <span aria-hidden>·</span>
                <Num>{fmtDate(t.date)}</Num>
                {t.reference ? <><span aria-hidden>·</span><Ltr>{t.reference}</Ltr></> : null}
                {t.by ? <><span aria-hidden>·</span><span>{t.by}</span></> : null}
                {t.state === 'unknown' ? <Badge tone="warn">بانتظار التحقق</Badge>
                  : t.collected ? <Badge tone="neutral">محصّل</Badge> : <Badge tone="neutral">بانتظار التحصيل</Badge>}
              </div>
            </a>
            {t.can_undo ? (
              <Menu dir="rtl">
                <MenuTrigger asChild>
                  <Button aria-label={`المزيد: تحويل ${t.customer || ''}`} className="size-11 flex-none border-0 p-0"><MoreVertical aria-hidden className="size-5" /></Button>
                </MenuTrigger>
                <MenuContent align="end" className="min-w-[280px]">
                  <MenuItem danger className="flex-col items-start py-2" onSelect={() => setUndo(t)}>
                    <span className="block">احذف التحويل</span>
                    <span className="mt-1 block text-sm font-normal text-muted">تُحذف دفعة التحويل من زوهو، فتعود فواتير العميل غير مدفوعة.</span>
                  </MenuItem>
                </MenuContent>
              </Menu>
            ) : t.collected && t.state === 'done' ? (
              <Button aria-label={`المزيد: تحويل ${t.customer || ''}`} blocked className="size-11 flex-none border-0 p-0"
                onClick={() => toast('هذا التحويل محصّل، فلا يُحذف. افتحه ليتراجع المدير عن تحصيله أولاً.', 'warn')}><MoreVertical aria-hidden className="size-5" /></Button>
            ) : <span className="size-11 flex-none" aria-hidden />}
          </li>
        ))}
      </CardList>
      {undo ? <UndoTransfer t={undo} onClose={(changed) => { setUndo(null); if (changed) load(); }} /> : null}
    </section>
  );
}

function UndoTransfer({ t, onClose }: { t: Transfer; onClose: (changed: boolean) => void }) {
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState('');
  const [open, setOpen] = useState(true);
  const finish = (changed: boolean) => { setOpen(false); setTimeout(() => onClose(changed), CLOSE_MS); };

  async function run() {
    setBusy(true);
    try {
      const res = await api('/api/m/cheques/transfers/undo', { method: 'POST', body: { payment_id: t.payment_id } });
      toast(res.message);
      setBusy(false);
      finish(true);
    } catch (e) {
      setFailed(errText(e));
      setBusy(false);
    }
  }

  return (
    <Modal open={open} onClose={() => finish(!!failed)} busy={busy} title="حذف التحويل">
      <dl className="m-0 mt-2 flex flex-col">
        <KV label="العميل">{t.customer}</KV>
        <KV label="المبلغ"><Amount value={t.amount} /></KV>
        <KV label="البنك">{t.bank}</KV>
        <KV label="تاريخ التحويل"><Num>{fmtDate(t.date)}</Num></KV>
      </dl>
      <Note tone="warn" className="mt-3 text-base">تُحذف دفعة التحويل من زوهو، فتعود فواتير العميل غير مدفوعة.</Note>
      <p className="text-sm text-muted">الحذف في زوهو نهائي، ويُسجَّل باسمك في سجل العمليات.</p>
      {failed ? <FormError>{failed}</FormError> : null}
      <ModalActions>
        {!failed ? <Button variant="danger" disabled={busy} onClick={run}>{busy ? 'جارٍ الحذف…' : 'احذف التحويل'}</Button> : null}
        <Button disabled={busy} onClick={() => finish(!!failed)} autoFocus>{failed ? 'إغلاق' : 'إلغاء'}</Button>
      </ModalActions>
    </Modal>
  );
}
