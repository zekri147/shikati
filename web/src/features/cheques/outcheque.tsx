// شيك منّا لمورد (للمدير وحده): شيك الشركة الصادر من أحد بنوكها، يُسجَّل دفعة مورد بطريقة «شيك»
// موزّعة آلياً على أقدم فواتير المورد، وحالته «سُلّم للمورد». ليس تظهيراً لشيك عميل.
// لا يُكتب شيء في زوهو قبل «سجّل دفعة المورد» في بطاقة التأكيد، ولا إعادة بعد انقطاع الرد.
import { useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Field, Input } from '@/components/ui/input';
import { DateField } from '@/components/ui/datefield';
import { Modal, ModalActions } from '@/components/ui/dialog';
import { Segmented } from '@/components/ui/segmented';
import { Amount, Num } from '@/components/ltr';
import { FormError, Note } from '@/components/shell';
import { toast } from '@/components/toast';
import { api, errText, isCutOff } from '@/lib/api';
import { load as loadKey } from '@/lib/storage';
import { fmtDate, newRequestId, parseAmount, todayIso } from '@/lib/format';
import { cn } from '@/lib/utils';
import { AllocList, KV, PartyPicker, type Party } from './pickers';
import { GroupField, PhotoButtons } from './edit';
import { LOC_FROM_LABEL, Step, StepsProgress, useChequePhoto, type Options } from './register';
import type { Line } from './types';

type Preview = { lines: Line[]; unused: number };
type Form = {
  requestId: string; image: string; vendor: Party; amount: number; cheque_number: string;
  bank: string; bankLabel: string; location: string; locationLabel: string; date: string;
};

export function OutChequeForm({ opts, onDone }: { opts: Options; onDone: () => void }) {
  const banks = opts.out_banks || [];
  const [vendor, setVendor] = useState<Party | null>(null);
  const [amount, setAmount] = useState('');
  const [number, setNumber] = useState('');
  const [bank, setBank] = useState(banks[0]?.key || '');
  const [location, setLocation] = useState(() => LOC_FROM_LABEL[loadKey('shikati-location')] || '');
  const today = todayIso();
  const [date, setDate] = useState(today);
  const [error, setError] = useState('');
  const [loud, setLoud] = useState(false);
  const [checking, setChecking] = useState(false);
  const [confirm, setConfirm] = useState<Preview | null>(null);
  const requestId = useRef(newRequestId());
  const locked = useRef(false);
  const errRef = useRef<HTMLDivElement>(null);
  const { image, reading, readNote, onFile } = useChequePhoto(opts.reader, (a, n) => { if (a) setAmount(a); if (n) setNumber(n); });

  const digits = number.replace(/\D/g, '');
  const missing: string[] = [];
  if (!vendor) missing.push('المورد');
  if (!parseAmount(amount)) missing.push('المبلغ');
  if (digits.length !== 7) missing.push('رقم الشيك');
  if (!date) missing.push('التاريخ');
  if (!bank) missing.push('البنك');
  if (!location) missing.push('الموقع');

  async function submit() {
    setError('');
    if (missing.length) { setLoud(true); return; }
    const show = (t: string) => { setError(t); setTimeout(() => errRef.current?.scrollIntoView({ block: 'center' }), 0); };
    const problems: string[] = [];
    if (digits === '0000000') problems.push('رقم الشيك 7 أرقام');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || date > today) problems.push('تاريخ التسليم لا يكون بعد اليوم');
    if (problems.length) { show(problems.join('، ') + '.'); return; }
    if (locked.current) { show('محاولة التسجيل السابقة لم تُعرف نتيجتها. تحقق من دفعات الموردين في زوهو قبل أي محاولة.'); return; }
    setChecking(true);
    try {
      setConfirm(await api<Preview>('/api/m/cheques/endorse/preview', { method: 'POST', body: { vendor_id: vendor!.id, amount: parseAmount(amount) } }));
    } catch (e) {
      show(errText(e));
    } finally {
      setChecking(false);
    }
  }

  const form: Form | null = vendor ? {
    requestId: requestId.current, image, vendor, amount: parseAmount(amount) || 0, cheque_number: digits,
    bank, bankLabel: banks.find((b) => b.key === bank)?.label || '', location,
    locationLabel: opts.locations.find((l) => l.key === location)?.label || '', date,
  } : null;

  return (
    <>
      <StepsProgress done={[!!image, !!vendor, !!parseAmount(amount) && digits.length === 7 && !!date, !!bank && !!location]} />
      <Step n={1} title="صورة الشيك" done={!!image}>
        {image ? <img src={image} alt="صورة الشيك" className="mt-1 block max-h-[260px] w-full border border-line bg-surface-alt object-contain" /> : null}
        <PhotoButtons first={!image} disabled={reading} onFile={onFile} shootLabel={image ? 'إعادة التصوير' : 'تصوير الشيك'} />
        {readNote ? <Note tone={readNote.tone} className="mt-2">{readNote.text}</Note> : null}
      </Step>

      <Step n={2} title="المورد" done={!!vendor}>
        <div className="py-2"><PartyPicker kind="vendor" value={vendor} onChange={setVendor} /></div>
      </Step>

      <Step n={3} title="المبلغ والرقم والتاريخ" done={!!parseAmount(amount) && digits.length === 7 && !!date}>
        <div className="grid grid-cols-2 gap-x-3">
          <Field label="المبلغ (دج)"><Input inputMode="decimal" dir="ltr" placeholder="0.00" autoComplete="off" value={amount} onChange={(e) => setAmount(e.target.value)} /></Field>
          <Field label="رقم الشيك"><Input inputMode="numeric" dir="ltr" maxLength={7} placeholder="7 أرقام" autoComplete="off" value={number} onChange={(e) => setNumber(e.target.value)} /></Field>
        </div>
        <DateField label="تاريخ تسليم الشيك" value={date} max={today} onChange={setDate} hint="تاريخ الدفعة في زوهو." />
      </Step>

      <Step n={4} title="البنك والموقع" done={!!bank && !!location}>
        <GroupField label="البنك المسحوب عليه">
          <Segmented label="البنك المسحوب عليه" value={bank} onChange={setBank} options={banks.map((b) => ({ value: b.key, label: b.label }))} />
        </GroupField>
        <GroupField label="الموقع">
          <Segmented label="الموقع" value={location} onChange={setLocation} options={opts.locations.map((l) => ({ value: l.key, label: l.label }))} />
        </GroupField>
      </Step>

      <div ref={errRef}>{error ? <FormError>{error}</FormError> : null}</div>

      <div className="formbar fixed inset-x-0 z-[21] flex flex-col gap-2 border-t border-line-strong bg-surface px-4 py-2 bottom-[calc(var(--nav-h,60px)+env(safe-area-inset-bottom))]">
        <div aria-live="polite" className={cn('min-w-0 text-sm leading-snug', loud && missing.length ? 'font-semibold text-danger' : 'text-muted')}>
          {missing.length ? 'ينقص: ' + missing.join('، ') : 'البيانات كاملة. راجعها ثم سجّل.'}
        </div>
        <Button variant="primary" className="w-full py-2" blocked={missing.length > 0} disabled={checking} onClick={submit}>
          {checking ? 'جارٍ حساب التوزيع…' : 'مراجعة وتسجيل'}
        </Button>
      </div>

      {confirm && form ? (
        <OutConfirm form={form} preview={confirm} onClose={(res, cut) => {
          setConfirm(null);
          if (cut) locked.current = true;
          if (res) {
            toast(res.warning || `سُجّل شيك ${form.cheque_number} للمورد ${form.vendor.name}`, res.warning ? 'warn' : 'ok');
            setTimeout(onDone, 0);
          }
        }} />
      ) : null}
    </>
  );
}

function OutConfirm({ form, preview, onClose }: { form: Form; preview: Preview; onClose: (res: any, cut: boolean) => void }) {
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
      const res = await api('/api/m/cheques/register/out', { method: 'POST', body: {
        request_id: form.requestId, vendor_id: form.vendor.id, vendor: form.vendor.name, amount: form.amount,
        cheque_number: form.cheque_number, bank: form.bank, location: form.location, date: form.date, image: form.image || undefined,
      } });
      setBusy(false);
      finish(res);
    } catch (e) {
      setFailed(errText(e));
      // لا إعادة: لا نعرف إن كان زوهو أنشأ دفعة المورد
      if (isCutOff(e)) setCut(true);
      setBusy(false);
    }
  }

  return (
    <Modal open={open} onClose={() => finish(null)} busy={busy} title="تأكيد شيك صادر لمورد">
      {form.image ? <img src={form.image} alt="صورة الشيك" className="mt-1 block max-h-[260px] w-full border border-line bg-surface-alt object-contain" />
        : <div className="flex items-center justify-center bg-surface-alt p-4 text-sm text-soft">دون صورة</div>}
      <dl className="m-0 mt-2 flex flex-col">
        <KV label="المورد">{form.vendor.name}</KV>
        <KV label="المبلغ"><Amount value={form.amount} /></KV>
        <KV label="رقم الشيك"><Num>{form.cheque_number}</Num></KV>
        <KV label="البنك">{form.bankLabel}</KV>
        <KV label="الموقع">{form.locationLabel}</KV>
        <KV label="تاريخ التسليم"><Num>{fmtDate(form.date)}</Num></KV>
      </dl>
      <h3 className="mb-1 mt-3 text-base">التوزيع على فواتير المورد</h3>
      <AllocList lines={preview.lines} emptyText="لا فواتير غير مدفوعة لهذا المورد." />
      {preview.unused > 0 ? <Note tone="warn" className="mt-2">يبقى <Amount value={preview.unused} className="font-semibold" /> رصيداً مسبقاً عند المورد.</Note> : null}
      <p className="text-sm text-muted">ستُنشأ في زوهو دفعة مورد من حساب {form.bankLabel} بحالة «سُلّم للمورد». تأكد أن البيانات تطابق الشيك.</p>
      {failed ? <FormError>{failed}</FormError> : null}
      <ModalActions>
        {!cut ? <Button variant="primary" disabled={busy} onClick={run}>{busy ? 'جارٍ التسجيل…' : 'سجّل دفعة المورد'}</Button> : null}
        <Button disabled={busy} onClick={() => finish(null)}>{cut ? 'إغلاق' : 'رجوع للتعديل'}</Button>
      </ModalActions>
    </Modal>
  );
}
