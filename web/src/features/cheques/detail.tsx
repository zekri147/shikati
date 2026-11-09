// صفحة تفاصيل الشيك: كل ما في زوهو عن الشيك دون فتح زوهو. وفي أسفلها شريط العمليات:
// العمل الأنسب لحالة الشيك، ثم «تعديل»، ثم «المزيد» (التراجع ببطاقة تأكيد).
import { useCallback, useEffect, useRef, useState } from 'react';
import { ChevronRight, ChevronUp } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { CLOSE_MS, Modal, ModalActions } from '@/components/ui/dialog';
import { Menu, MenuContent, MenuItem, MenuTrigger } from '@/components/ui/dropdown';
import { Badge } from '@/components/ui/badge';
import { Amount, Num } from '@/components/ltr';
import { ErrorBox, FormError, Note, SkeletonList, Slab, SlabTop } from '@/components/shell';
import { toast } from '@/components/toast';
import { api, errText, isCutOff } from '@/lib/api';
import { navigate } from '@/lib/back';
import { useFixedBottom } from '@/lib/layout';
import { daysText, fmtDate, fmtDateTime, todayIso } from '@/lib/format';
import { cn } from '@/lib/utils';
import { haptic, sharedStyle } from '@/lib/motion';
import { DEST_LABELS, StatusBadge } from './ui';
import { ChequeImage } from './media';
import { AllocList, Block, KV, PartyPicker, type Party } from './pickers';
import { EditPanel } from './edit';
import { DepositDialog } from './deposit';
import { CustodyBlock } from './custody';
import type { Cheque, Line } from './types';

const LOCK_TEXT: Record<string, string> = {
  pending: 'الإيداع قيد التنفيذ الآن', done: 'سجّل التطبيق إيداعه',
  unknown: 'بانتظار التحقق: انقطع الرد أثناء إيداعه أو التراجع عنه', failed: 'محاولة إيداع لم تتم',
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

// preview: الشيك من القائمة، فيظهر رأسه فوراً قبل وصول التفاصيل
export function DetailPage({ id, isAdmin, onBack, preview, depositable, onDeposited }: {
  id: string; isAdmin: boolean; onBack: () => void; preview?: Cheque; depositable?: Cheque | null; onDeposited?: () => void;
}) {
  const [depositing, setDepositing] = useState(false);
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

  const hasBar = !!d && !editing && (d.can_endorse || d.edit || d.undo || !!depositable);
  useFixedBottom(68, hasBar);

  // رأس الصفحة: لوح أحمر ملاصق للشريط العلوي، فيه الرجوع ثم العميل والمبلغ والحالة والوجهة
  const backRow = (extra?: React.ReactNode) => <SlabTop onBack={onBack} extra={extra} />;
  if (error && !d) return <><Slab>{backRow()}<h1 className="m-0 text-lg font-bold">تفاصيل الشيك</h1></Slab><ErrorBox>{error}</ErrorBox></>;
  if (!d) {
    return (
      <>
        {preview ? (
          <Slab>
            {backRow(preview.cheque_number ? <>شيك <Num>{preview.cheque_number}</Num></> : null)}
            <h1 className="m-0 text-lg font-bold leading-snug [overflow-wrap:anywhere]" style={sharedStyle(true, 'cust')}>{preview.customer}</h1>
            <Amount value={preview.amount} style={sharedStyle(true, 'amt')} className="mt-1 block font-display text-3xl font-semibold leading-tight max-[360px]:text-2xl" />
            <div className="mt-2 flex flex-wrap gap-2"><Badge tone={preview.status === 'في الحوزة' || preview.status === 'مرفوض' ? 'dark' : 'inverse'}>{preview.status || 'بلا حالة'}</Badge></div>
          </Slab>
        ) : <Slab>{backRow()}<h1 className="m-0 text-lg font-bold">تفاصيل الشيك</h1></Slab>}
        <SkeletonList rows={4} />
      </>
    );
  }

  const en = d.app.endorsement;
  const lock = d.app.lock;
  const u = d.undo;

  return (
    <>
      <Slab>
        {backRow(d.cheque_number ? <>شيك <Num>{d.cheque_number}</Num></> : null)}
        <h1 className="m-0 text-lg font-bold leading-snug [overflow-wrap:anywhere]" style={sharedStyle(true, 'cust')}>{d.customer}</h1>
        <Amount value={d.amount} style={sharedStyle(true, 'amt')} className="mt-1 block font-display text-3xl font-semibold leading-tight max-[360px]:text-2xl" />
        <div className="mt-2 flex flex-wrap gap-2">
          <Badge tone={d.status === 'في الحوزة' || d.status === 'مرفوض' ? 'dark' : 'inverse'}>{d.status || 'بلا حالة'}</Badge>
          {d.destination ? <Badge tone="inverse">{DEST_LABELS[d.destination] || d.destination}{d.location ? ' · ' + d.location : ''}</Badge> : <Badge tone="dark">الوجهة غير محددة</Badge>}
        </div>
      </Slab>
      <div className="mt-4 flex flex-col gap-3" aria-live="polite">
        {editing && d.edit ? <EditPanel d={d} onSaved={reload} onCancel={() => setEditing(false)} /> : null}
        {en && en.state === 'unknown' ? <Note tone="alert">بانتظار التحقق: انقطع الرد بعد إرسال دفعة المورد لهذا الشيك. تحقق في زوهو قبل أي محاولة جديدة.</Note> : null}
        {d.can_endorse ? <EndorsePanel d={d} reload={reload} innerRef={endorseRef} /> : null}
        {d.wrong_account ? <Note tone="warn">{isAdmin ? d.wrong_account + '.' : 'سُجّل هذا الشيك في حساب خطأ في زوهو. أبلغ المدير ليصحّحه قبل إيداعه.'}</Note> : null}
        {d.box_alert ? <Note tone="alert">صندوق غير مطابق: {d.box_alert}</Note> : null}
        {lock && lock.state === 'unknown' ? <Note tone="alert">بانتظار التحقق: انقطع الرد أثناء إيداع هذا الشيك أو التراجع عن إيداعه. تحقق في صفحة الإدارة قبل أي محاولة جديدة.</Note> : null}

        {/* الصورة أولاً وكبيرة: هي الدليل الذي يطابقه الموظف مع الشيك في يده. تُكبَّر باللمس */}
        {d.has_image ? (
          <figure className="m-0">
            <ChequeImage id={d.id} hasImage v={d.edit ? d.edit.version : ''} size="big" />
            <figcaption className="mt-1 text-sm text-muted">اضغط الصورة لتكبيرها{d.captured_at ? <> · صُوّرت <Num>{d.captured_at}</Num></> : null}</figcaption>
          </figure>
        ) : d.drive_url ? <a className="flex min-h-11 items-center justify-center bg-surface-alt p-2 text-center text-sm font-semibold text-danger no-underline" href={d.drive_url} target="_blank" rel="noopener noreferrer">الصورة في غوغل درايف</a>
          : <div className="flex min-h-11 items-center justify-center bg-surface-alt p-2 text-center text-sm text-soft">لا توجد صورة لهذا الشيك</div>}

        <ChequePath d={d} />

        {/* العهدة للشيك في الحوزة: من يحمله، والتسليم والاستلام */}
        {d.custody ? <CustodyBlock id={d.id} k={d.custody} onChanged={() => { reload(); onDeposited?.(); }} /> : null}

        {/* بيانات الشيك: سطور «عنوان وقيمة» في مجموعة واحدة، لا مربع لكل معلومة */}
        <Block title="بيانات الشيك">
          <dl className="m-0 flex flex-col">
            <KV label="رقم الشيك">{d.cheque_number ? <Num>{d.cheque_number}</Num> : ''}</KV>
            <KV label="تاريخ الاستلام"><Num>{fmtDate(d.date)}</Num></KV>
            {d.deposit_date ? <KV label="تاريخ الإيداع"><Num>{fmtDate(d.deposit_date)}</Num></KV> : null}
            <KV label="الوجهة">{d.destination ? DEST_LABELS[d.destination] || d.destination : 'غير محددة'}</KV>
            <KV label="الموقع">{d.location}</KV>
            <KV label="مندوب العميل">{d.rep || 'غير محدد في زوهو'}</KV>
            <KV label="سجّله">{d.created_by}</KV>
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
                  <div className="flex flex-wrap items-baseline justify-between gap-2"><Num className="font-semibold">{i.number}</Num><Amount value={i.applied} className="font-semibold" /></div>
                  <div className="flex flex-wrap items-baseline justify-between gap-2 text-sm text-muted">
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
                <li key={i} className="flex flex-wrap items-baseline justify-between gap-2 border-b border-line py-2 text-base last:border-b-0">
                  <span className="font-semibold">{x.account || 'حساب غير معروف'}</span>{x.date ? <Num>{fmtDate(x.date)}</Num> : null}
                </li>
              ))}
            </ul>
          ) : <p className="text-sm text-muted">لم يُودَع هذا الشيك بعد.</p>}
        </Block>

        <Block title="سجل العمليات">
          {d.log.length ? <ul className="m-0 list-none p-0">{d.log.map((l: string, i: number) => <LogLine key={i} line={l} />)}</ul>
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
                    <div className="flex flex-wrap items-baseline justify-between gap-2"><span className="font-semibold">{ACTION_TEXT[h.action] || h.action}</span><Num className="text-sm text-muted">{fmtDateTime(h.at)}</Num></div>
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
        <div className="detailbar fixed inset-x-0 bottom-0 z-20 flex gap-2 border-t border-line-strong bg-surface px-4 pb-[calc(10px+env(safe-area-inset-bottom))] pt-2 [&>*]:flex-1">
          {/* العمل الأنسب لحالة الشيك زراً رئيسياً: الإيداع للشيك في الحوزة لبنك AGB */}
          {depositable && !d.can_endorse ? <Button variant="primary" className="!flex-[2] whitespace-nowrap py-2" onClick={() => setDepositing(true)}>أودِع هذا الشيك</Button> : null}
          {d.can_endorse ? (
            <Button variant="primary" className="py-2" onClick={() => {
              endorseRef.current?.scrollIntoView({ block: 'start' });
              endorseRef.current?.querySelector('input')?.focus({ preventScroll: true });
            }}>إتمام التظهير</Button>
          ) : null}
          {d.edit ? (
            <Button className="py-2" blocked={!d.edit.allowed} onClick={() => {
              // التعديل غير المسموح يشرح سببه بدل زر معطّل بلا تفسير
              if (!d.edit.allowed) { toast(d.edit.blocker || 'تعديل هذا الشيك غير متاح.', 'warn'); return; }
              setEditing(true);
              window.scrollTo(0, 0);
            }}>تعديل</Button>
          ) : null}
          {u ? (
            <Menu dir="rtl">
              <MenuTrigger asChild><Button className="gap-2 py-2"><span>المزيد</span><ChevronUp aria-hidden className="size-4.5" /></Button></MenuTrigger>
              <MenuContent side="top" align="end" className="min-w-[280px]">
                <MenuItem danger blocked={!u.allowed} className="flex-col items-start py-2"
                  onSelect={() => { if (!u.allowed) { toast(u.blocker, 'warn'); return; } setUndoOpen(true); }}>
                  <span className={cn('block', !u.allowed && 'text-muted')}>{u.title}</span>
                  <span className="mt-1 block text-sm font-normal text-muted">{u.allowed ? u.effect : u.blocker}</span>
                </MenuItem>
              </MenuContent>
            </Menu>
          ) : null}
        </div>
      ) : null}

      {depositing && depositable ? <DepositDialog items={[depositable]} onClosed={(r) => {
        setDepositing(false);
        if (!r.attempted) return;
        if (r.done.length) { haptic('success'); toast('تم إيداع الشيك في بنك AGB'); }
        onDeposited?.(); reload();
      }} /> : null}
      {undoOpen && u ? <UndoDialog d={d} onClose={(after) => { setUndoOpen(false); if (after === 'gone') navigate('#cheques'); else if (after === 'reload') reload(); }} /> : null}
    </>
  );
}

// سطر من سجل الدفعة في زوهو: «2026-11-01 — نص». التاريخ يُعرض يوم/شهر/سنة في سطر صغير فوق النص
function LogLine({ line }: { line: string }) {
  const m = line.match(/^(\d{4}-\d{2}-\d{2})(?:[ T]\d{2}:\d{2}(?::\d{2})?)?\s*[—–-]\s*(.*)$/);
  return (
    <li className="border-b border-line py-2 text-base last:border-b-0 [overflow-wrap:anywhere]">
      {m ? <><Num className="block text-sm text-muted">{fmtDate(m[1])}</Num><span>{m[2]}</span></> : line}
    </li>
  );
}

// مسار الشيك من التسجيل إلى نهايته، بتواريخه من زوهو. المرحلة الحالية حمراء، والقادمة باهتة.
function ChequePath({ d }: { d: Detail }) {
  type Step = { label: string; when: string; state: 'done' | 'now' | 'todo'; alert?: boolean };
  const st: string = d.status || '';
  const days = d.date ? Math.max(0, Math.round((Date.parse(todayIso()) - Date.parse(String(d.date).slice(0, 10))) / 86_400_000)) : 0;
  const short = (iso?: string) => (iso ? fmtDate(iso).slice(0, 5) : '—');
  const deposited = !!d.deposit_date || st === 'مودع في البنك' || st === 'محصّل' || st === 'مرفوض';
  const steps: Step[] = [
    { label: 'سُجّل' + (d.created_by ? ' · ' + d.created_by : ''), when: short(d.date), state: 'done' },
    st === 'في الحوزة'
      ? { label: 'في الحوزة · ' + daysText(days), when: 'الآن', state: 'now' }
      : { label: 'في الحوزة', when: '', state: 'done' },
  ];
  if (st === 'مظهّر لمورد') steps.push({ label: 'ظُهّر لمورد', when: 'الآن', state: 'now' });
  else if (st === 'مرفوض') steps.push({ label: 'أُودع', when: short(d.deposit_date), state: 'done' }, { label: 'مرفوض', when: 'الآن', state: 'now', alert: true });
  else if (st && !['في الحوزة', 'مودع في البنك', 'محصّل'].includes(st)) steps.push({ label: st, when: 'الآن', state: 'now' });
  else {
    steps.push({ label: 'أُودع في البنك', when: short(d.deposit_date), state: st === 'مودع في البنك' ? 'now' : deposited ? 'done' : 'todo' });
    steps.push({ label: 'حُصّل', when: '', state: st === 'محصّل' ? 'now' : 'todo' });
  }
  return (
    <Block title="مسار الشيك">
      <ol className="m-0 list-none p-0">
        {steps.map((s, i) => (
          <li key={i} className="flex items-stretch gap-3" aria-current={s.state === 'now' ? 'step' : undefined}>
            <div className="flex w-4 flex-none flex-col items-center">
              <span aria-hidden className={cn('cut-xs mt-1 size-4 flex-none',
                s.state === 'done' ? 'bg-foreground' : s.state === 'now' ? 'bg-brand' : 'bg-line-strong')} />
              {i < steps.length - 1 ? <span aria-hidden className={cn('w-0.5 flex-1', s.state === 'done' ? 'bg-foreground' : 'bg-line')} /> : null}
            </div>
            <div className="flex flex-1 justify-between gap-2 pb-2">
              <span className={cn(s.state === 'todo' ? 'text-muted' : 'font-semibold', s.alert && 'text-danger')}>{s.label}</span>
              {s.when ? <span className="text-sm text-muted">{s.when}</span> : null}
            </div>
          </li>
        ))}
      </ol>
    </Block>
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
    <Block title="إتمام التظهير لمورد" innerRef={innerRef}>
      <p className="text-sm text-muted">الشيك مسجّل في حساب الشيكات المظهّرة، ولم تُنشأ دفعة المورد بعد. اختر المورد الذي سُلّم له الشيك.</p>
      <PartyPicker kind="vendor" value={vendor} onChange={setVendor} />
      {vendor && !preview && !pError ? <p className="text-sm text-muted">جارٍ حساب التوزيع…</p> : null}
      {pError ? <FormError>{pError}</FormError> : null}
      {preview ? (
        <div>
          <h3 className="mb-1 mt-3 text-base">التوزيع على فواتير المورد</h3>
          <AllocList lines={preview.lines} emptyText="لا فواتير غير مدفوعة لهذا المورد." />
          {preview.unused > 0 ? <Note tone="warn" className="mt-2">يبقى <Amount value={preview.unused} className="font-semibold" /> رصيداً مسبقاً عند المورد.</Note> : null}
        </div>
      ) : null}
      {error ? <FormError>{error}</FormError> : null}
      {preview && !dead ? <Button variant="primary" size="lg" className="mt-2" disabled={busy} onClick={go}>{busy ? 'جارٍ إنشاء دفعة المورد…' : 'إتمام التظهير'}</Button> : null}
    </Block>
  );
}

// التراجع عن آخر عملية: بطاقة تشرح ما سيُحذف، ثم طلب واحد دون إعادة
function UndoDialog({ d, onClose }: { d: Detail; onClose: (after: 'gone' | 'reload' | null) => void }) {
  const u = d.undo;
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState('');
  const [open, setOpen] = useState(true);
  const finish = (after: 'gone' | 'reload' | null) => { setOpen(false); setTimeout(() => onClose(after), CLOSE_MS); };

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
