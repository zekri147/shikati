// تسجيل شيك جديد: صورة الشيك ← قراءة المبلغ والرقم بكلود ← اختيار العميل بالبحث ← دفعة في زوهو،
// ومع وجهة «مورد آخر» دفعة مورد من حساب الشيكات المظهّرة.
// القراءة اقتراح فقط، ولا يُكتب شيء في زوهو قبل «تسجيل الشيك» في بطاقة التأكيد.
import { useEffect, useRef, useState } from 'react';
import { Check } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Field, Input } from '@/components/ui/input';
import { DateField } from '@/components/ui/datefield';
import { Modal, ModalActions } from '@/components/ui/dialog';
import { Segmented } from '@/components/ui/segmented';
import { Amount, Num } from '@/components/ltr';
import { Empty, ErrorBox, FormError, Note, SkeletonList } from '@/components/shell';
import { toast } from '@/components/toast';
import { api, errText, isCutOff } from '@/lib/api';
import { useFixedBottom } from '@/lib/layout';
import { load as loadKey } from '@/lib/storage';
import { fmtDate, newRequestId, parseAmount, todayIso } from '@/lib/format';
import { cn } from '@/lib/utils';
import { DEST_LABELS } from './ui';
import { rotateDataUrl, shrink } from './media';
import { AllocList, Block, KV, PartyPicker, type Party } from './pickers';
import { GroupField, PhotoButtons } from './edit';
import type { Line } from './types';

const LOC_FROM_LABEL: Record<string, string> = { 'الجزائر': 'ALGER', 'العلمة': 'EL EULMA' };
type Options = { can_register: boolean; reader: boolean; destinations: string[]; locations: { key: string; label: string }[] };
type Preview = { lines: Line[]; unused: number; vendor?: { lines: Line[]; unused: number } };

// خطوة مرقّمة بعنوان بارز فوق مجموعتها: تظهر علامة ✓ حين تكتمل، فيرى الموظف ما بقي بنظرة
function Step({ n, title, done, children }: { n: number; title: string; done: boolean; children: React.ReactNode }) {
  return (
    <Block strong title={<>
        <span aria-hidden className={cn('num inline-flex size-6 flex-none items-center justify-center text-sm', done ? 'bg-selected text-selected-ink' : 'border border-line-strong text-muted')}>
          {done ? <Check className="size-4" strokeWidth={3} /> : n}
        </span>
        <span>{title}</span>
        {done ? <span className="sr-only">(مكتملة)</span> : null}
      </>}>
      {children}
    </Block>
  );
}

// مؤشر التقدّم أعلى الشاشة: أربع خطوات، والمكتملة بلون «المختار»
function StepsProgress({ done }: { done: boolean[] }) {
  const n = done.filter(Boolean).length;
  return (
    <div>
      <div className="mb-2 text-sm text-muted">{n === done.length ? 'الخطوات كلها مكتملة' : `أكملت ${n} من ${done.length} خطوات`}</div>
      <div aria-hidden className="flex gap-1">{done.map((d, i) => <span key={i} className={cn('h-1 flex-1 transition-colors duration-200', d ? 'bg-selected' : 'bg-line-strong')} />)}</div>
    </div>
  );
}

export function RegisterPage({ onDone }: { onDone: (pid: string) => void }) {
  const [opts, setOpts] = useState<Options | null>(null);
  const [loadError, setLoadError] = useState('');
  const [image, setImage] = useState('');
  const [reading, setReading] = useState(false);
  const [readNote, setReadNote] = useState<{ tone?: 'warn' | 'ok'; text: string } | null>(null);
  const [customer, setCustomer] = useState<Party | null>(null);
  const [vendor, setVendor] = useState<Party | null>(null);
  const [amount, setAmount] = useState('');
  const [number, setNumber] = useState('');
  const [destination, setDestination] = useState('ELONAC');
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

  useEffect(() => {
    api<Options>('/api/m/cheques/register/options').then(setOpts).catch((e) => setLoadError(errText(e)));
  }, []);

  useFixedBottom(92, !!opts && opts.can_register);

  async function onFile(f: File) {
    let shot: string;
    try { shot = await shrink(f); } catch (e) { toast(errText(e), 'err'); return; }
    setImage(shot);
    if (!opts?.reader) { setReadNote({ text: 'القراءة الآلية غير مُعدّة بعد. اكتب البيانات بيدك.' }); return; }
    setReadNote({ text: 'جارٍ قراءة الشيك…' });
    setReading(true);
    try {
      const { reading: r } = await api('/api/m/cheques/register/read', { method: 'POST', body: { image: shot } });
      const filled: string[] = [];
      if (r.amount) { setAmount(String(r.amount)); filled.push('المبلغ'); }
      if (r.cheque_number) { setNumber(r.cheque_number); filled.push('الرقم'); }
      setReadNote({
        tone: r.note ? 'warn' : 'ok',
        text: (filled.length ? 'قُرئ: ' + filled.join('، ') + '. راجعها مع الصورة.' : 'لم تُقرأ أي بيانات بثقة. اكتبها بيدك.') + (r.note ? ' ملاحظة: ' + r.note : ''),
      });
      // الصورة تُدار قبل رفعها، فتظهر معتدلة في التطبيق وفي زوهو
      if (r.rotation) { const rot = await rotateDataUrl(shot, r.rotation); setImage((cur) => (cur === shot ? rot : cur)); }
    } catch (e) {
      setReadNote({ tone: 'warn', text: errText(e) });
    } finally {
      setReading(false);
    }
  }

  if (loadError) return <ErrorBox>{loadError}</ErrorBox>;
  if (!opts) return <SkeletonList className="mt-0" rows={4} />;
  if (!opts.can_register) return <Empty>ليست لديك صلاحية تسجيل الشيكات.</Empty>;

  const endorsed = destination === 'Autre Fournisseur';
  const locLabels = Object.fromEntries(opts.locations.map((l) => [l.key, l.label]));
  const missing: string[] = [];
  if (!customer) missing.push('العميل');
  if (endorsed && !vendor) missing.push('المورد');
  if (!parseAmount(amount)) missing.push('المبلغ');
  if (number.replace(/\D/g, '').length !== 7) missing.push('رقم الشيك');
  if (!location) missing.push('الموقع');
  if (!date) missing.push('التاريخ');

  async function submit() {
    setError('');
    if (missing.length) { setLoud(true); return; }
    const amt = parseAmount(amount)!;
    const num = number.replace(/\D/g, '');
    const problems: string[] = [];
    if (!/^\d{7}$/.test(num) || num === '0000000') problems.push('رقم الشيك 7 أرقام');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || date > today) problems.push('تاريخ الاستلام لا يكون بعد اليوم');
    const show = (t: string) => { setError(t); setTimeout(() => errRef.current?.scrollIntoView({ block: 'center' }), 0); };
    if (problems.length) { show(problems.join('، ') + '.'); return; }
    if (locked.current) { show('محاولة التسجيل السابقة لم تُعرف نتيجتها. افتح «كل الشيكات» وتحقق قبل أي محاولة.'); return; }
    setChecking(true);
    try {
      const p = await api<Preview>('/api/m/cheques/register/preview', { method: 'POST', body: {
        customer_id: customer!.id, amount: amt, vendor_id: endorsed ? vendor!.id : undefined,
      } });
      setConfirm(p);
    } catch (e) {
      show(errText(e));
    } finally {
      setChecking(false);
    }
  }

  const form = {
    requestId: requestId.current, image, customer: customer!, vendor, amount: parseAmount(amount) || 0,
    cheque_number: number.replace(/\D/g, ''), destination, location, locationLabel: locLabels[location] || '', date,
  };

  return (
    <div className="flex flex-col gap-4">
      <StepsProgress done={[!!image, !!customer, !!parseAmount(amount) && number.replace(/\D/g, '').length === 7 && !!date, !!location && (!endorsed || !!vendor)]} />
      <Step n={1} title="صورة الشيك" done={!!image}>
        {image ? <img src={image} alt="صورة الشيك" className="mt-1 block max-h-[260px] w-full border border-line bg-surface-alt object-contain" /> : null}
        <PhotoButtons first={!image} disabled={reading} onFile={onFile} shootLabel={image ? 'إعادة التصوير' : 'تصوير الشيك'} />
        {readNote ? <Note tone={readNote.tone} className="mt-2">{readNote.text}</Note> : null}
      </Step>

      <Step n={2} title="العميل" done={!!customer}>
        <div className="py-2"><PartyPicker kind="customer" value={customer} onChange={setCustomer} /></div>
      </Step>

      <Step n={3} title="المبلغ والرقم والتاريخ" done={!!parseAmount(amount) && number.replace(/\D/g, '').length === 7 && !!date}>
        <div className="grid grid-cols-2 gap-x-3">
          <Field label="المبلغ (دج)"><Input inputMode="decimal" dir="ltr" placeholder="0.00" autoComplete="off" value={amount} onChange={(e) => setAmount(e.target.value)} /></Field>
          <Field label="رقم الشيك"><Input inputMode="numeric" dir="ltr" maxLength={7} placeholder="7 أرقام" autoComplete="off" value={number} onChange={(e) => setNumber(e.target.value)} /></Field>
        </div>
        <DateField label="تاريخ الاستلام" value={date} max={today} onChange={setDate} hint="لا يُقبل إيداع الشيك قبل هذا التاريخ." />
      </Step>

      <Step n={4} title="الوجهة والموقع" done={!!location && (!endorsed || !!vendor)}>
        <GroupField label="الوجهة">
          <Segmented label="الوجهة" value={destination} onChange={setDestination} options={opts.destinations.map((d) => ({ value: d, label: DEST_LABELS[d] || d }))} />
        </GroupField>
        {endorsed ? <GroupField label="المورد الذي سُلّم له الشيك"><PartyPicker kind="vendor" value={vendor} onChange={setVendor} /></GroupField> : null}
        <GroupField label="الموقع">
          <Segmented label="الموقع" value={location} onChange={setLocation} options={opts.locations.map((l) => ({ value: l.key, label: l.label }))} />
        </GroupField>
      </Step>

      <div ref={errRef}>{error ? <FormError>{error}</FormError> : null}</div>

      {/* شريط ثابت فوق شريط التنقل: ما ينقص، وزر «مراجعة وتسجيل» الباهت حتى تكتمل البيانات */}
      <div className="formbar fixed inset-x-0 z-[21] flex flex-col gap-2 border-t border-line-strong bg-surface px-4 py-2 bottom-[calc(var(--nav-h,60px)+env(safe-area-inset-bottom))]">
        <div aria-live="polite" className={cn('min-w-0 text-sm leading-snug', loud && missing.length ? 'font-semibold text-danger' : 'text-muted')}>
          {missing.length ? 'ينقص: ' + missing.join('، ') : 'البيانات كاملة. راجعها ثم سجّل.'}
        </div>
        <Button variant="primary" className="w-full py-2" blocked={missing.length > 0} disabled={checking} onClick={submit}>
          {checking ? 'جارٍ حساب التوزيع…' : 'مراجعة وتسجيل'}
        </Button>
      </div>

      {confirm ? (
        <RegisterConfirm form={form} preview={confirm} onClose={(res, cut) => {
          setConfirm(null);
          if (cut) locked.current = true;
          if (res) { toast(res.warning || 'تم تسجيل الشيك', res.warning ? 'warn' : 'ok'); setTimeout(() => onDone(res.payment_id), 0); }
        }} />
      ) : null}
    </div>
  );
}

function RegisterConfirm({ form, preview, onClose }: { form: any; preview: Preview; onClose: (res: any, cut: boolean) => void }) {
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState('');
  const [cut, setCut] = useState(false);
  const [open, setOpen] = useState(true);
  const endorsed = form.destination === 'Autre Fournisseur';
  const finish = (res: any) => {
    setOpen(false);
    // الانتقال إلى صفحة الشيك بعد رجوع خطوة البطاقة في سجل المتصفح
    setTimeout(() => onClose(res, cut), res ? 450 : 0);
  };

  async function run() {
    setBusy(true);
    setFailed('');
    try {
      const res = await api('/api/m/cheques/register', { method: 'POST', body: {
        request_id: form.requestId, customer_id: form.customer.id, customer: form.customer.name,
        amount: form.amount, cheque_number: form.cheque_number, destination: form.destination, location: form.location,
        image: form.image || undefined, date: form.date,
        vendor_id: endorsed ? form.vendor.id : undefined, vendor: endorsed ? form.vendor.name : undefined,
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
    <Modal open={open} onClose={() => finish(null)} busy={busy} title="تأكيد تسجيل الشيك">
      {form.image ? <img src={form.image} alt="صورة الشيك" className="mt-1 block max-h-[260px] w-full border border-line bg-surface-alt object-contain" />
        : <div className="flex items-center justify-center bg-surface-alt p-4 text-sm text-soft">دون صورة</div>}
      <dl className="m-0 mt-2 flex flex-col">
        <KV label="العميل">{form.customer.name}</KV>
        <KV label="المبلغ"><Amount value={form.amount} /></KV>
        <KV label="رقم الشيك"><Num>{form.cheque_number}</Num></KV>
        <KV label="الوجهة">{DEST_LABELS[form.destination]}</KV>
        {endorsed ? <KV label="المورد">{form.vendor.name}</KV> : null}
        <KV label="الموقع">{form.locationLabel}</KV>
        <KV label="تاريخ الاستلام"><Num>{fmtDate(form.date)}</Num></KV>
      </dl>
      <h3 className="mb-1 mt-3 text-base">{endorsed ? 'التوزيع على فواتير العميل' : 'التوزيع على الفواتير'}</h3>
      <AllocList lines={preview.lines} emptyText="لا فواتير غير مدفوعة لهذا العميل." />
      {preview.unused > 0 ? <Note tone="warn" className="mt-2">يبقى <Amount value={preview.unused} className="font-semibold" /> رصيداً مسبقاً للعميل.</Note> : null}
      {endorsed && preview.vendor ? (
        <>
          <h3 className="mb-1 mt-3 text-base">التوزيع على فواتير المورد</h3>
          <AllocList lines={preview.vendor.lines} emptyText="لا فواتير غير مدفوعة لهذا المورد." />
          {preview.vendor.unused > 0 ? <Note tone="warn" className="mt-2">يبقى <Amount value={preview.vendor.unused} className="font-semibold" /> رصيداً مسبقاً عند المورد.</Note> : null}
        </>
      ) : null}
      <p className="text-sm text-muted">تأكد أن البيانات تطابق الشيك. سيُسجَّل في زوهو باسمك.</p>
      {failed ? <FormError>{failed}</FormError> : null}
      <ModalActions>
        {!cut ? <Button variant="primary" disabled={busy} onClick={run}>{busy ? 'جارٍ التسجيل…' : 'تسجيل الشيك'}</Button> : null}
        <Button disabled={busy} onClick={() => finish(null)}>{cut ? 'إغلاق' : 'رجوع للتعديل'}</Button>
      </ModalActions>
    </Modal>
  );
}
