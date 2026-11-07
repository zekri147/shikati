// صفحة تفاصيل الشيك: كل ما في زوهو عن الشيك دون فتح زوهو. وفي أسفلها شريط العمليات:
// العمل الأنسب لحالة الشيك، ثم «تعديل»، ثم «المزيد» (التراجع ببطاقة تأكيد).
import { useCallback, useEffect, useRef, useState } from 'react';
import { ChevronRight, ChevronUp } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Modal, ModalActions } from '@/components/ui/dialog';
import { Menu, MenuContent, MenuItem, MenuTrigger } from '@/components/ui/dropdown';
import { Badge } from '@/components/ui/badge';
import { Amount, Num } from '@/components/ltr';
import { ErrorBox, FormError, Note } from '@/components/shell';
import { toast } from '@/components/toast';
import { api, errText, isCutOff } from '@/lib/api';
import { navigate } from '@/lib/back';
import { useFixedBottom } from '@/lib/layout';
import { fmtDate, fmtDateTime } from '@/lib/format';
import { cn } from '@/lib/utils';
import { DEST_LABELS, StatusBadge } from './ui';
import { ChequeImage } from './media';
import { AllocList, Block, KV, PartyPicker, type Party } from './pickers';
import { EditPanel } from './edit';
import type { Line } from './types';

const LOCK_TEXT: Record<string, string> = {
  pending: 'الإيداع قيد التنفيذ الآن', done: 'سجّل التطبيق إيداعه',
  unknown: 'بانتظار التحقق: انقطع الرد بعد محاولة الإيداع', failed: 'محاولة إيداع لم تتم',
};
const ENDORSE_TEXT: Record<string, string> = {
  pending: 'التظهير قيد التنفيذ الآن', done: 'ظُهّر من التطبيق للمورد',
  unknown: 'بانتظار التحقق: انقطع الرد بعد إرسال دفعة المورد', failed: 'محاولة تظهير لم تتم',
};
const ACTION_TEXT: Record<string, string> = {
  deposit: 'إيداع', 'deposit.release': 'تحرير القفل', 'deposit.reverted': 'إلغاء الإيداع في زوهو', register: 'تسجيل الشيك',
  endorse: 'التظهير لمورد', 'undo.deposit': 'تراجع عن الإيداع', 'undo.endorse': 'تراجع عن التظهير', 'undo.register': 'حذف التسجيل',
  edit: 'تعديل الشيك', 'register.read': 'قراءة الصورة',
};

export type Detail = any;

export function DetailPage({ id, isAdmin, onBack }: { id: string; isAdmin: boolean; onBack: () => void }) {
  const [d, setD] = useState<Detail | null>(null);
  const [error, setError] = useState('');
  const [editing, setEditing] = useState(false);
  const [undoOpen, setUndoOpen] = useState(false);
  const endorseRef = useRef<HTMLElement>(null);

  const reload = useCallback(async () => {
    setEditing(false);
    try {
      const x = await api('/api/m/cheques/detail/' + encodeURIComponent(id));
      setD(x);
      setError('');
      document.title = 'شيك ' + x.customer;
    } catch (e) {
      setError(errText(e));
    }
  }, [id]);
  useEffect(() => { setD(null); reload(); }, [reload]);

  const hasBar = !!d && !editing && (d.can_endorse || d.edit || d.undo);
  useFixedBottom(68, hasBar);

  const top = (
    <div className="mb-3 flex items-center gap-3">
      <Button onClick={onBack} className="gap-1 pe-3 ps-3.5"><ChevronRight aria-hidden className="size-4.5" /><span>رجوع</span></Button>
      <h1 className="m-0 text-lg font-bold">تفاصيل الشيك</h1>
    </div>
  );
  if (error && !d) return <>{top}<ErrorBox>{error}</ErrorBox></>;
  if (!d) return <>{top}<p className="text-muted">جارٍ التحميل…</p></>;

  const en = d.app.endorsement;
  const lock = d.app.lock;
  const u = d.undo;

  return (
    <>
      {top}
      <div className="flex flex-col gap-3" aria-live="polite">
        {/* الرأس الأحمر: العميل والمبلغ والحالة والوجهة */}
        <div className="cut bg-brand px-4.5 pb-3.5 pt-4 text-white">
          <div className="text-lg font-bold leading-snug [overflow-wrap:anywhere]">{d.customer}</div>
          <Amount value={d.amount} className="mt-1 block font-display text-[30px] font-semibold leading-tight" />
          <div className="mt-2.5 flex flex-wrap gap-1.5">
            <Badge tone={d.status === 'في الحوزة' || d.status === 'مرفوض' ? 'dark' : 'inverse'}>{d.status || 'بلا حالة'}</Badge>
            {d.destination ? <Badge tone="inverse">الوجهة: {DEST_LABELS[d.destination] || d.destination}</Badge> : <Badge tone="dark">الوجهة غير محددة</Badge>}
          </div>
        </div>

        {editing && d.edit ? <EditPanel d={d} onSaved={reload} onCancel={() => setEditing(false)} /> : null}
        {en && en.state === 'unknown' ? <Note tone="alert">بانتظار التحقق: انقطع الرد بعد إرسال دفعة المورد لهذا الشيك. تحقق في زوهو قبل أي محاولة جديدة.</Note> : null}
        {d.can_endorse ? <EndorsePanel d={d} reload={reload} innerRef={endorseRef} /> : null}
        {d.wrong_account ? <Note tone="warn">حساب غير صحيح: {d.wrong_account}</Note> : null}
        {d.box_alert ? <Note tone="alert">صندوق غير مطابق: {d.box_alert}</Note> : null}
        {lock && lock.state === 'unknown' ? <Note tone="alert">بانتظار التحقق: انقطع الرد بعد محاولة إيداع هذا الشيك. تحقق في صفحة الإدارة قبل أي محاولة جديدة.</Note> : null}

        <div>
          {d.has_image ? <ChequeImage id={d.id} hasImage v={d.edit ? d.edit.version : ''} size="big" />
            : d.drive_url ? <a className="flex items-center justify-center bg-surface-alt p-4.5 text-center font-semibold text-danger no-underline" href={d.drive_url} target="_blank" rel="noopener noreferrer">الصورة في غوغل درايف: اضغط لفتحها</a>
              : <div className="flex items-center justify-center bg-surface-alt p-4.5 text-center text-sm text-soft">لا توجد صورة لهذا الشيك</div>}
        </div>

        <Block title="بيانات الشيك">
          <dl className="m-0 flex flex-col">
            <KV label="رقم الشيك">{d.cheque_number ? <Num>{d.cheque_number}</Num> : ''}</KV>
            <KV label="تاريخ الاستلام"><Num>{fmtDate(d.date)}</Num></KV>
            {d.deposit_date ? <KV label="تاريخ الإيداع"><Num>{fmtDate(d.deposit_date)}</Num></KV> : null}
            <KV label="الموقع">{d.location}</KV>
            <KV label="سجّله">{d.created_by}</KV>
            {d.captured_at ? <KV label="وقت التصوير"><Num>{d.captured_at}</Num></KV> : null}
          </dl>
        </Block>

        {/* بيانات المحاسبة في زوهو للمدير وحده */}
        {isAdmin ? (
          <Block title="في زوهو">
            <dl className="m-0 flex flex-col">
              <KV label="رقم الدفعة">{d.number ? <Num>{d.number}</Num> : ''}</KV>
              <KV label="الحساب">{d.account ? <Num>{d.account}</Num> : ''}</KV>
              {d.unused_amount ? <KV label="مبلغ غير موزّع"><Amount value={d.unused_amount} /></KV> : null}
              {d.refunds ? <KV label="استردادات"><Num>{String(d.refunds)}</Num></KV> : null}
              {d.description ? <KV label="الوصف">{d.description}</KV> : null}
              {d.fiscal !== undefined ? <KV label="الملف الجبائي للعميل">{d.fiscal || ''}</KV> : null}
            </dl>
          </Block>
        ) : null}

        <Block title="الفواتير المسدّدة بهذا الشيك">
          {d.invoices.length ? (
            <ul className="m-0 list-none p-0">
              {d.invoices.map((i: any) => (
                <li key={i.number} className="border-b border-line py-2 text-base last:border-b-0">
                  <div className="flex flex-wrap items-baseline justify-between gap-2.5"><Num className="font-semibold">{i.number}</Num><Amount value={i.applied} className="font-semibold" /></div>
                  <div className="flex flex-wrap items-baseline justify-between gap-2.5 text-sm text-muted">
                    <span>بتاريخ <Num>{fmtDate(i.date)}</Num></span>
                    {i.balance > 0 ? <span>باقي الفاتورة <Amount value={i.balance} /></span> : <span>سُدّدت كاملة</span>}
                  </div>
                </li>
              ))}
            </ul>
          ) : <p className="text-sm text-muted">الدفعة غير موزّعة على أي فاتورة.</p>}
        </Block>

        <Block title="الإيداع في البنك">
          {d.deposits.length ? (
            <ul className="m-0 list-none p-0">
              {d.deposits.map((x: any, i: number) => (
                <li key={i} className="flex flex-wrap items-baseline justify-between gap-2.5 border-b border-line py-2 text-base last:border-b-0">
                  <span className="font-semibold">{x.account || 'حساب غير معروف'}</span>{x.date ? <Num>{fmtDate(x.date)}</Num> : null}
                </li>
              ))}
            </ul>
          ) : <p className="text-sm text-muted">لم يُودَع هذا الشيك بعد.</p>}
        </Block>

        <Block title="سجل العمليات">
          {d.log.length ? <ol className="m-0 ps-5 text-base">{d.log.map((l: string, i: number) => <li key={i} className="py-0.5 [overflow-wrap:anywhere]">{l}</li>)}</ol>
            : <p className="text-sm text-muted">لا توجد عمليات مسجّلة بعد.</p>}
        </Block>

        {lock || d.app.history.length || en ? (
          <Block title="في التطبيق">
            {en ? <p><span className="font-semibold">{ENDORSE_TEXT[en.state] || en.state}</span>
              {en.vendor ? <span className="text-muted"> · {en.vendor}</span> : null}
              {en.display_name ? <span className="text-muted"> · {en.display_name}</span> : null}</p> : null}
            {lock ? <p><span className="font-semibold">{LOCK_TEXT[lock.state] || lock.state}</span>
              {lock.by ? <span className="text-muted"> · {lock.by}</span> : null}
              {lock.started_at ? <span className="text-muted"> · <Num>{fmtDateTime(lock.started_at)}</Num></span> : null}</p> : null}
            {d.app.history.length ? (
              <ul className="m-0 list-none p-0">
                {d.app.history.map((h: any, i: number) => (
                  <li key={i} className="border-b border-line py-2 text-base last:border-b-0">
                    <div className="flex flex-wrap items-baseline justify-between gap-2.5"><span className="font-semibold">{ACTION_TEXT[h.action] || h.action}</span><Num className="text-sm text-muted">{fmtDateTime(h.at)}</Num></div>
                    <div className="text-sm text-muted">{[h.username, h.details].filter(Boolean).join(' · ')}</div>
                  </li>
                ))}
              </ul>
            ) : null}
          </Block>
        ) : null}
      </div>

      {/* شريط العمليات الثابت: العمل الرئيسي، ثم «تعديل»، ثم «المزيد» */}
      {hasBar ? (
        <div className="detailbar fixed inset-x-0 bottom-0 z-20 flex gap-2 border-t border-line-strong bg-surface px-4 pb-[calc(10px+env(safe-area-inset-bottom))] pt-2.5 [&>*]:flex-1">
          {d.can_endorse ? (
            <Button variant="primary" className="py-2.5" onClick={() => {
              endorseRef.current?.scrollIntoView({ block: 'start' });
              endorseRef.current?.querySelector('input')?.focus({ preventScroll: true });
            }}>إتمام التظهير</Button>
          ) : null}
          {d.edit ? (
            <Button className="py-2.5" blocked={!d.edit.allowed} onClick={() => {
              // التعديل غير المسموح يشرح سببه بدل زر معطّل بلا تفسير
              if (!d.edit.allowed) { toast(d.edit.blocker || 'تعديل هذا الشيك غير متاح.', 'warn'); return; }
              setEditing(true);
              window.scrollTo(0, 0);
            }}>تعديل</Button>
          ) : null}
          {u ? (
            <Menu dir="rtl">
              <MenuTrigger asChild><Button className="gap-1.5 py-2.5"><span>المزيد</span><ChevronUp aria-hidden className="size-4.5" /></Button></MenuTrigger>
              <MenuContent side="top" align="end" className="min-w-[280px]">
                <MenuItem danger blocked={!u.allowed} className="flex-col items-start py-2.5"
                  onSelect={() => { if (!u.allowed) { toast(u.blocker, 'warn'); return; } setUndoOpen(true); }}>
                  <span className={cn('block', !u.allowed && 'text-muted')}>{u.title}</span>
                  <span className="mt-0.5 block text-sm font-normal text-muted">{u.allowed ? u.effect : u.blocker}</span>
                </MenuItem>
              </MenuContent>
            </Menu>
          ) : null}
        </div>
      ) : null}

      {undoOpen && u ? <UndoDialog d={d} onClose={(after) => { setUndoOpen(false); if (after === 'gone') navigate('#cheques'); else if (after === 'reload') reload(); }} /> : null}
    </>
  );
}

// إتمام التظهير: اختيار المورد ← معاينة التوزيع على فواتيره ← دفعة المورد. طلب واحد دون إعادة.
function EndorsePanel({ d, reload, innerRef }: { d: Detail; reload: () => void; innerRef: React.RefObject<HTMLElement> }) {
  const [vendor, setVendor] = useState<Party | null>(null);
  const [preview, setPreview] = useState<{ lines: Line[]; unused: number } | null>(null);
  const [pError, setPError] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [dead, setDead] = useState(false);

  useEffect(() => {
    setPreview(null); setPError(''); setError('');
    if (!vendor) return;
    let alive = true;
    api('/api/m/cheques/endorse/preview', { method: 'POST', body: { vendor_id: vendor.id, amount: d.amount } })
      .then((p) => { if (alive) setPreview(p); }).catch((e) => { if (alive) setPError(errText(e)); });
    return () => { alive = false; };
  }, [vendor, d.amount]);

  async function go() {
    if (!vendor) return;
    setBusy(true);
    setError('');
    try {
      const res = await api('/api/m/cheques/endorse', { method: 'POST', body: { payment_id: d.id, vendor_id: vendor.id, vendor: vendor.name } });
      toast(res.warning || 'تم التظهير للمورد', res.warning ? 'warn' : 'ok');
      reload();
    } catch (e) {
      setError(errText(e));
      // انقطاع الرد: لا إعادة
      if (isCutOff(e)) setDead(true);
      setBusy(false);
    }
  }

  return (
    <section ref={innerRef as React.RefObject<HTMLElement>} className="scroll-mt-16 border border-line bg-surface px-3.5 pb-3 pt-1">
      <h2 className="-mx-3.5 mb-2 mt-0 border-b border-line px-3.5 pb-2 pt-2.5 text-base font-bold">إتمام التظهير لمورد</h2>
      <p className="text-sm text-muted">الشيك مسجّل في حساب الشيكات المظهّرة، ولم تُنشأ دفعة المورد بعد. اختر المورد الذي سُلّم له الشيك.</p>
      <PartyPicker kind="vendor" value={vendor} onChange={setVendor} />
      {vendor && !preview && !pError ? <p className="text-sm text-muted">جارٍ حساب التوزيع…</p> : null}
      {pError ? <FormError>{pError}</FormError> : null}
      {preview ? (
        <div>
          <h3 className="mb-1 mt-3.5 text-base">التوزيع على فواتير المورد</h3>
          <AllocList lines={preview.lines} emptyText="لا فواتير غير مدفوعة لهذا المورد." />
          {preview.unused > 0 ? <Note tone="warn" className="mt-2">يبقى <Amount value={preview.unused} className="font-semibold" /> رصيداً مسبقاً عند المورد.</Note> : null}
        </div>
      ) : null}
      {error ? <FormError>{error}</FormError> : null}
      {preview && !dead ? <Button variant="primary" size="lg" className="mt-2" disabled={busy} onClick={go}>{busy ? 'جارٍ إنشاء دفعة المورد…' : 'إتمام التظهير'}</Button> : null}
    </section>
  );
}

// التراجع عن آخر عملية: بطاقة تشرح ما سيُحذف، ثم طلب واحد دون إعادة
function UndoDialog({ d, onClose }: { d: Detail; onClose: (after: 'gone' | 'reload' | null) => void }) {
  const u = d.undo;
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState('');
  const [open, setOpen] = useState(true);
  const finish = (after: 'gone' | 'reload' | null) => { setOpen(false); setTimeout(() => onClose(after), 0); };

  async function run() {
    setBusy(true);
    try {
      const res = await api('/api/m/cheques/undo', { method: 'POST', body: { payment_id: d.id, kind: u.kind } });
      toast(res.warning || res.message, res.warning ? 'warn' : 'ok');
      setBusy(false);
      finish(u.kind === 'register' ? 'gone' : 'reload');
    } catch (e) {
      setFailed(errText(e));
      setBusy(false);
    }
  }

  return (
    <Modal open={open} onClose={() => finish(failed ? 'reload' : null)} busy={busy} title={u.title}>
      <dl className="m-0 mt-2 flex flex-col">
        <KV label="العميل">{d.customer}</KV>
        <KV label="المبلغ"><Amount value={d.amount} /></KV>
        <KV label="رقم الشيك">{d.cheque_number ? <Num>{d.cheque_number}</Num> : ''}</KV>
      </dl>
      <Note tone="warn" className="mt-3 text-base">{u.effect}</Note>
      <p className="text-sm text-muted">الحذف في زوهو نهائي، ويُسجَّل باسمك في سجل العمليات.</p>
      {failed ? <FormError>{failed}</FormError> : null}
      <ModalActions>
        {!failed ? <Button variant="danger" disabled={busy} onClick={run}>{busy ? 'جارٍ الحذف…' : u.title}</Button> : null}
        <Button disabled={busy} onClick={() => finish(failed ? 'reload' : null)} autoFocus>{failed ? 'إغلاق' : 'إلغاء'}</Button>
      </ModalActions>
    </Modal>
  );
}
