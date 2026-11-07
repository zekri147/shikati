// تعديل الشيك بعد تسجيله: الرقم والمبلغ والتاريخ والموقع والوجهة والصورة.
// المعاينة تعرض الفروق والتوزيع الجديد على الفواتير، ولا يُكتب شيء في زوهو قبل «حفظ التعديل».
import { useEffect, useRef, useState } from 'react';
import { Camera } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Field, Input } from '@/components/ui/input';
import { DateField } from '@/components/ui/datefield';
import { Modal, ModalActions } from '@/components/ui/dialog';
import { Segmented } from '@/components/ui/segmented';
import { Amount, Num } from '@/components/ltr';
import { FormError, Note } from '@/components/shell';
import { toast } from '@/components/toast';
import { api, errText, isCutOff } from '@/lib/api';
import { parseAmount, todayIso } from '@/lib/format';
import { DEST_LABELS } from './ui';
import { rotateDataUrl, shrink } from './media';
import { AllocList } from './pickers';
import type { Detail } from './detail';

export function GroupField({ label, children }: { label: string; children: React.ReactNode }) {
  return <div className="py-2"><span className="mb-1.5 block text-base font-semibold">{label}</span>{children}</div>;
}

// أزرار الصورة: الكاميرا والمعرض. onImage يستقبل الصورة مصغّرة
export function PhotoButtons({ onFile, first, disabled, shootLabel }: { onFile: (f: File) => void; first?: boolean; disabled?: boolean; shootLabel: string }) {
  const cam = useRef<HTMLInputElement>(null);
  const gal = useRef<HTMLInputElement>(null);
  const pick = (e: React.ChangeEvent<HTMLInputElement>) => { const f = e.target.files && e.target.files[0]; e.target.value = ''; if (f) onFile(f); };
  return (
    <div className={first ? 'mt-2 flex flex-col gap-2' : 'mt-2 flex gap-2 [&>button]:flex-1'}>
      <input ref={cam} type="file" accept="image/*" capture="environment" hidden onChange={pick} />
      <input ref={gal} type="file" accept="image/*" hidden onChange={pick} />
      <Button disabled={disabled} className={first ? 'border-muted py-4.5 text-lg' : 'py-2.5'} onClick={() => cam.current?.click()}>
        <Camera aria-hidden className={first ? 'size-6.5' : 'size-5'} /><span>{shootLabel}</span>
      </Button>
      <Button disabled={disabled} className="py-2.5" onClick={() => gal.current?.click()}>من المعرض</Button>
    </div>
  );
}

type Change = { label: string; from: string; to: string };

export function EditPanel({ d, onSaved, onCancel }: { d: Detail; onSaved: () => void; onCancel: () => void }) {
  const e = d.edit;
  const [num, setNum] = useState<string>(d.cheque_number || '');
  const [amount, setAmount] = useState<string>(String(d.amount));
  const [date, setDate] = useState<string>(d.date || '');
  const [location, setLocation] = useState<string>(d.location_key);
  const [destination, setDestination] = useState<string>(d.destination || 'ELONAC');
  const [image, setImage] = useState('');
  const [error, setError] = useState('');
  const [checking, setChecking] = useState(false);
  const [preview, setPreview] = useState<{ body: any; p: any } | null>(null);
  const first = useRef<HTMLInputElement>(null);
  const box = useRef<HTMLElement>(null);

  useEffect(() => { box.current?.scrollIntoView({ block: 'start' }); first.current?.focus({ preventScroll: true }); }, []);

  async function onFile(f: File) {
    let shot: string;
    try { shot = await shrink(f); } catch (err) { toast(errText(err), 'err'); return; }
    setImage(shot);
    // كلود يحدد اتجاه الصورة، فتُدار قبل رفعها
    try {
      const { rotation } = await api('/api/m/cheques/register/orient', { method: 'POST', body: { image: shot } });
      if (rotation) { const r = await rotateDataUrl(shot, rotation); setImage((cur) => (cur === shot ? r : cur)); }
    } catch { /* تُرفع كما هي */ }
  }

  const body = () => ({
    payment_id: d.id, version: e.version, cheque_number: num.trim(), amount: parseAmount(amount),
    date, location, destination, image: image || undefined,
  });

  async function review() {
    setError('');
    const b = body();
    if (!/^\d{7}$/.test(b.cheque_number)) { setError('رقم الشيك يجب أن يكون 7 أرقام.'); return; }
    if (!b.amount) { setError('المبلغ غير صالح.'); return; }
    setChecking(true);
    try {
      const p = await api('/api/m/cheques/edit/preview', { method: 'POST', body: b });
      setPreview({ body: b, p });
    } catch (err) {
      setError(errText(err));
    } finally {
      setChecking(false);
    }
  }

  return (
    <section ref={box} className="scroll-mt-16 border border-line bg-surface px-3.5 pb-3 pt-1">
      <h2 className="-mx-3.5 mb-2 mt-0 border-b border-line px-3.5 pb-2 pt-2.5 text-base font-bold">تعديل الشيك</h2>
      <Field label="رقم الشيك"><Input ref={first} inputMode="numeric" dir="ltr" maxLength={7} autoComplete="off" value={num} onChange={(x) => setNum(x.target.value)} /></Field>
      <Field label="المبلغ" hint="إن تغيّر المبلغ يُعاد توزيعه آلياً على أقدم فواتير العميل.">
        <Input inputMode="decimal" dir="ltr" autoComplete="off" value={amount} onChange={(x) => setAmount(x.target.value)} />
      </Field>
      <DateField label="تاريخ الاستلام" value={date} max={todayIso()} onChange={setDate} />
      <GroupField label="الموقع">
        <Segmented label="الموقع" value={location} onChange={setLocation} options={[{ value: 'ALGER', label: 'الجزائر' }, { value: 'EL EULMA', label: 'العلمة' }]} />
      </GroupField>
      <GroupField label="الوجهة">
        <Segmented label="الوجهة" value={destination} onChange={setDestination} options={Object.entries(DEST_LABELS).map(([value, label]) => ({ value, label }))} />
      </GroupField>
      <GroupField label="الصورة">
        <PhotoButtons onFile={onFile} shootLabel="الكاميرا" />
        {image ? <img src={image} alt="الصورة الجديدة" className="mt-1 block max-h-[260px] w-full border border-line bg-surface-alt object-contain" /> : null}
      </GroupField>
      {error ? <FormError>{error}</FormError> : null}
      <Button variant="primary" size="lg" className="mt-2" disabled={checking} onClick={review}>{checking ? 'جارٍ التحقق…' : 'مراجعة التعديل'}</Button>
      <Button size="lg" className="mt-2" onClick={onCancel}>إلغاء</Button>
      {preview ? <EditConfirm d={d} b={preview.body} p={preview.p} onClose={(saved) => { setPreview(null); if (saved) onSaved(); }} /> : null}
    </section>
  );
}

function EditConfirm({ d, b, p, onClose }: { d: Detail; b: any; p: any; onClose: (reload: boolean) => void }) {
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState('');
  const [cut, setCut] = useState(false);
  const [open, setOpen] = useState(true);
  const finish = (reload: boolean) => { setOpen(false); setTimeout(() => onClose(reload), 0); };

  async function save() {
    setBusy(true);
    try {
      const res = await api('/api/m/cheques/edit', { method: 'POST', body: b });
      toast(res.warning || res.message, res.warning ? 'warn' : 'ok');
      setBusy(false);
      finish(true);
    } catch (err) {
      setFailed(errText(err));
      // انقطاع الرد: لا إعادة، وتُحدَّث الصفحة عند الإغلاق
      if (isCutOff(err)) setCut(true);
      setBusy(false);
    }
  }

  // كل قيمة معزولة الاتجاه، فيبقى السهم من القديم (يميناً) إلى الجديد (يساراً) حتى مع النص اللاتيني
  const show = (v: string, money: boolean) => (money ? <Amount value={Number(v)} /> : /^[\d\s.-]+$/.test(v) ? <Num>{v}</Num> : <bdi>{v}</bdi>);
  return (
    <Modal open={open} onClose={() => finish(cut)} busy={busy} title="تأكيد تعديل الشيك">
      <p className="text-sm text-muted">{d.customer}</p>
      <ul className="m-0 list-none p-0">
        {(p.changes as Change[]).map((c0, i) => {
          const c = c0.label === 'الوجهة' ? { ...c0, from: DEST_LABELS[c0.from] || c0.from, to: DEST_LABELS[c0.to] || c0.to } : c0;
          const money = c.label === 'المبلغ';
          return (
            <li key={i} className="flex flex-wrap items-baseline justify-between gap-2.5 border-b border-line py-2 text-base last:border-b-0">
              <span className="font-semibold">{c.label}</span>
              {c.from ? <span>{show(c.from, money)} ← {show(c.to, money)}</span> : <span>{c.to}</span>}
            </li>
          );
        })}
      </ul>
      {p.allocation ? (
        <>
          <h3 className="mb-1 mt-3.5 text-base">التوزيع الجديد على الفواتير</h3>
          <AllocList lines={p.allocation.lines} emptyText="لا فواتير غير مدفوعة لهذا العميل." />
          {p.allocation.unused > 0 ? <Note tone="warn" className="mt-2">يبقى <Amount value={p.allocation.unused} className="font-semibold" /> رصيداً للعميل.</Note> : null}
        </>
      ) : null}
      {b.image ? <img src={b.image} alt="الصورة الجديدة" className="mt-3 block max-h-[260px] w-full border border-line bg-surface-alt object-contain" /> : null}
      {failed ? <FormError>{failed}</FormError> : null}
      <ModalActions>
        {!failed ? <Button variant="primary" disabled={busy} onClick={save}>{busy ? 'جارٍ الحفظ…' : 'حفظ التعديل'}</Button> : null}
        <Button disabled={busy} onClick={() => finish(cut)} autoFocus>{failed ? 'إغلاق' : 'رجوع'}</Button>
      </ModalActions>
    </Modal>
  );
}

