// قسم «التحصيل»: أرصدة العملاء المدينين لكل مندوب (7/11/2026، بطلب ZEKRI).
// المندوب يرى عملاءه فقط، والمدير يختار المندوب. المراجعة الأسبوعية تُكتب تعليقاً على العميل في زوهو.
// العنوان بعد #: ‎#coll للقائمة، و‎#coll/c/<معرّف العميل> لبطاقة العميل.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Check, ChevronLeft, ChevronRight, RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Textarea } from '@/components/ui/input';
import { Modal, ModalActions } from '@/components/ui/dialog';
import { Segmented } from '@/components/ui/segmented';
import { Fold } from '@/components/ui/collapsible';
import { SearchBox } from '@/components/search';
import { Amount, Ltr, Num } from '@/components/ltr';
import { Empty, ErrorBox, FormError, Note, RefreshButton, Slab, SlabTop } from '@/components/shell';
import { toast } from '@/components/toast';
import { api, errText, type Me } from '@/lib/api';
import { useFixedBottom } from '@/lib/layout';
import { load as loadKey, save as saveKey } from '@/lib/storage';
import { customersWord, daysWord, fmtAmount, fmtDate, fmtDateTime, invoicesWord, norm, relTime, round2 } from '@/lib/format';
import { cn } from '@/lib/utils';
import { LIST_BOX, LateMark } from '@/features/cheques/ui';
import { Block, KV } from '@/features/cheques/pickers';

const STALE_MS = 5 * 60_000;
const PAGE = 40;
const REP_KEY = 'shikati-coll-rep';

// الفئات حسب تأخر أقدم فاتورة غير مسدّدة، كما في قائمة الاتصال
const CATS: [string, string][] = [['', 'الكل'], ['rev', 'للمراجعة'], ['old', 'أكثر من 90 يوماً'], ['d90', 'من 31 إلى 90'], ['d30', 'حتى 30 يوماً'], ['due', 'لم يحن موعدها'], ['open', 'أرصدة افتتاحية']];
const CAT_NOTE: Record<string, string> = {
  rev: 'عملاء عليهم دين قديم ولم تراجعهم هذا الأسبوع. اتصل بكل واحد، ثم اضغط «راجعت».',
  old: 'أقدم فاتورة غير مسدّدة تأخرت أكثر من ثلاثة أشهر. ابدأ بهم.',
  d90: 'أقدم فاتورة غير مسدّدة تأخرت بين شهر وثلاثة أشهر.',
  d30: 'أقدم فاتورة غير مسدّدة تأخرت شهراً على الأكثر.',
  due: 'فواتيرهم لم يحن موعد دفعها بعد.',
  open: 'أرصدة نُقلت عند بداية زوهو بوكس، بلا تاريخ استحقاق. تابعها مع الإدارة.',
};
// حالة الإرسال إلى زوهو بكلمة قصيرة
const ZOHO_WORD: Record<string, string> = { done: 'في زوهو', pending: 'قيد الإرسال', unknown: 'بانتظار التحقق', failed: 'لم يُرسل إلى زوهو', none: 'لم يُرسل إلى زوهو' };

type Inv = { number: string; date: string; due: string; balance: number; late: number };
type Cust = { id: string; name: string; balance: number; opening: number; late: number | null; owner: string; phone: string; invoices: Inv[] };
type Rev = { at: string; note: string; late: boolean; by: string; zoho: string };
type Review = {
  week: string; deadline: number; can_review: boolean; items: Record<string, Rev>;
  progress?: { rep: string; done: number; need: number; last: string | null }[];
  notes?: { name: string; rep: string; note: string; late: boolean; at: string }[];
  unsent?: { week: string; id: string; name: string; rep: string; state: string; error?: string; text: string }[];
};
type CollData = { at: number; is_admin: boolean; own_rep: string; customers: Cust[]; reps?: { rep: string; count: number; total: number; old: number }[]; review?: Review };

const catOf = (c: Cust) => (c.late === null ? 'open' : c.late > 90 ? 'old' : c.late > 30 ? 'd90' : c.late > 0 ? 'd30' : 'due');
const isOld = (c: Cust) => c.late === null || c.late > 90;
// المراجعة الأسبوعية: كل عميل دينه متأخر أكثر من 90 يوماً أو عليه رصيد افتتاحي
const needsReview = (c: Cust) => isOld(c) || c.opening > 0;
const total = (list: Cust[]) => round2(list.reduce((t, c) => t + c.balance, 0));
const lateText = (c: Cust) => (c.late === null ? 'رصيد افتتاحي' : c.late > 0 ? `متأخر ${daysWord(c.late)}` : 'لم يحن موعدها');
// الرقم بالصيغة المحلية: 213561765718 يصبح 0561 76 57 18
const localPhone = (p: string) => (p.startsWith('213') && p.length === 12 ? ('0' + p.slice(3)).replace(/^(\d{4})(\d{2})(\d{2})(\d{2})$/, '$1 $2 $3 $4') : '+' + p);
const sendable = (r: Rev | null | undefined) => !!r && (r.zoho === 'failed' || r.zoho === 'none');
const timeOf = (at: string) => { const t = fmtDateTime(at); return 'يوم ' + t.slice(0, 5) + ' الساعة ' + t.slice(11); };
function fmtDeadline(ms: number) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: 'Africa/Algiers', day: '2-digit', month: '2-digit' }).formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  return `${p.day}/${p.month}`;
}

function parseRoute(hash: string) {
  const h = decodeURIComponent(hash.replace(/^#/, ''));
  const m = h.match(/^coll\/c\/(\d{10,25})$/);
  return m ? { view: 'customer' as const, id: m[1] } : { view: 'list' as const, id: '' };
}

export function CollModule({ me, hash }: { me: Me; hash: string }) {
  const isAdmin = me.user.role === 'admin';
  const route = useMemo(() => parseRoute(hash), [hash]);
  const [data, setData] = useState<CollData | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [loadedAt, setLoadedAt] = useState(0);
  const [, tick] = useState(0);
  const [cat, setCat] = useState('');
  const [q, setQ] = useState('');
  const [limit, setLimit] = useState(PAGE);
  const [rep, setRep] = useState(() => (isAdmin ? loadKey(REP_KEY) : ''));
  const [reviewing, setReviewing] = useState<{ c: Cust; r: Rev | null } | null>(null);
  const busyRef = useRef(false);
  const scroll = useRef(0);
  const prev = useRef(route.view);
  const fromList = useRef(false);

  const load = useCallback(async (refresh: boolean, repCode = rep) => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    try {
      const qs = new URLSearchParams();
      if (refresh) qs.set('refresh', '1');
      if (isAdmin && repCode) qs.set('rep', repCode);
      const d = await api<CollData>('/api/m/coll' + (qs.toString() ? '?' + qs : ''));
      setData(d);
      setLoadedAt(Number(d.at) || Date.now());
      setError('');
    } catch (e) {
      setData((old) => { if (old) toast(errText(e), 'err'); else setError(errText(e)); return old; });
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }, [isAdmin, rep]);

  useEffect(() => { load(false); /* eslint-disable-next-line */ }, []);
  useEffect(() => { const t = setInterval(() => tick((n) => n + 1), 30_000); return () => clearInterval(t); }, []);
  useEffect(() => {
    const onVis = () => { if (document.visibilityState === 'visible' && Date.now() - loadedAt > STALE_MS) load(false); };
    document.addEventListener('visibilitychange', onVis);
    return () => document.removeEventListener('visibilitychange', onVis);
  }, [load, loadedAt]);
  useEffect(() => {
    const p = prev.current;
    fromList.current = route.view === 'customer' && p === 'list';
    prev.current = route.view;
    document.title = 'التحصيل';
    window.scrollTo(0, route.view === 'list' ? scroll.current : 0);
    return () => { if (route.view === 'list') scroll.current = window.scrollY; };
  }, [route.view, route.id]);

  function pickRep(code: string) {
    if (code === rep) return;
    setRep(code); saveKey(REP_KEY, code); setCat('');
    load(false, code);
  }

  const markReviewed = (c: Cust, r: Rev) => setData((d) => (d && d.review ? { ...d, review: { ...d.review, items: { ...d.review.items, [c.id]: r } } } : d));

  if (route.view === 'customer') {
    return (
      <>
        <CustomerPage data={data} id={route.id} me={me} onBack={() => { if (fromList.current) history.back(); else location.hash = '#coll'; }}
          onReview={(c, r) => setReviewing({ c, r })}
          onCancelled={(c) => setData((d) => { if (!d?.review) return d; const items = { ...d.review.items }; delete items[c.id]; return { ...d, review: { ...d.review, items } }; })} />
        {reviewing && data?.review ? <ReviewDialog data={data} me={me} c={reviewing.c} r={reviewing.r} onClose={() => setReviewing(null)} onSaved={markReviewed} /> : null}
      </>
    );
  }

  if (error && !data) return <><Slab><div className="pt-2 text-sm font-semibold">التحصيل</div></Slab><ErrorBox>{error}</ErrorBox></>;
  if (!data) return <><Slab><div className="pt-2 text-sm font-semibold">التحصيل</div></Slab><p className="mt-4 text-muted">جارٍ تحميل أرصدة العملاء…</p></>;

  const list = data.customers;
  const rv = data.review;
  const items0 = rv ? rv.items : {};
  const counts: Record<string, number> = {};
  for (const c of list) { const k = catOf(c); counts[k] = (counts[k] || 0) + 1; }
  if (rv && (rv.can_review || rep)) counts.rev = list.filter((c) => needsReview(c) && !items0[c.id]).length;
  const inCat = (c: Cust) => !cat || (cat === 'old' ? isOld(c) : cat === 'rev' ? needsReview(c) && !items0[c.id] : catOf(c) === cat);
  const match = (c: Cust) => !q || norm(c.name).includes(q) || c.invoices.some((i) => norm(i.number).includes(q));
  const items = list.filter((c) => inCat(c) && match(c));
  const shown = items.slice(0, limit);
  const more = items.length - shown.length;
  const old = list.filter(isOld);
  const opening = list.reduce((t, c) => t + (c.late === null ? c.balance : 0), 0);
  const who = data.is_admin ? (rep ? (rep === '-' ? 'العملاء بلا مندوب' : null) : 'كل العملاء') : 'عملائك';
  const catOptions = CATS.filter(([v]) => !v || counts[v] || (v === 'old' && cat === 'old')).map(([v, t]) => {
    const n = v ? (v === 'old' ? (counts.old || 0) + (counts.open || 0) : counts[v] || 0) : list.length;
    return { value: v, label: <>{t} <span className="num">{n}</span></> };
  });

  return (
    <>
      {/* اللوح الأحمر الملاصق للشريط العلوي، كما في شاشة الإيداع: المجموع، وزر التحديث بوقته */}
      <Slab>
        <div className="flex items-center justify-between gap-3 text-sm">
          <span className="font-semibold">{who ? `مجموع ديون ${who}` : <>مجموع ديون عملاء <Ltr>{rep}</Ltr></>}</span>
          <RefreshButton busy={busy} loadedAt={loadedAt} onClick={() => load(true)} onRed />
        </div>
        <Amount value={total(list)} className="block font-display text-3xl font-semibold leading-tight tracking-tight max-[360px]:text-2xl" />
        <div className="mt-2 text-sm">{list.length ? `على ${customersWord(list.length)}` : 'لا رصيد مفتوح'} · الأرصدة من زوهو بوكس</div>
      </Slab>

      {data.is_admin ? (
        <Segmented label="المندوب" scroll className="mt-3" value={rep} onChange={pickRep}
          options={[{ value: '', label: 'الكل' }, ...(data.reps || []).map((r) => ({ value: r.rep || '-', label: r.rep ? <Ltr>{r.rep}</Ltr> : 'بلا مندوب' }))]} />
      ) : null}

      <div className="mt-3 flex flex-col gap-2">
        {/* المربع الأسود للديون القديمة زر: يعرض عملاءها فقط */}
        <button type="button" aria-pressed={cat === 'old'} onClick={() => { setCat(cat === 'old' ? '' : 'old'); setLimit(PAGE); }}
          className={cn('kpi-btn cut-sm flex min-h-11 w-full items-center justify-between gap-3 bg-tile px-4 py-2 text-start text-white active:opacity-85', cat === 'old' && 'outline-3 outline-offset-2 outline-selected')}>
          <span className="text-sm font-semibold">{cat === 'old' ? '✓ ' : ''}متأخرة أكثر من 90 يوماً
            <span className="block font-normal">{old.length ? customersWord(old.length) : 'لا ديون قديمة'}{opening > 0 ? <> · منها افتتاحية <Amount value={opening} /></> : null}</span>
          </span>
          <Amount value={total(old)} className="whitespace-nowrap font-display text-lg font-semibold" />
        </button>
      </div>

      <div className="mt-3 flex flex-col gap-2">
        <Segmented label="الفئة حسب التأخر" scroll value={cat} onChange={(v) => { setCat(v); setLimit(PAGE); }} options={catOptions} />
        <SearchBox placeholder="بحث باسم العميل أو رقم الفاتورة" onChange={(v) => { setQ(norm(v)); setLimit(PAGE); }} />
      </div>

      <ReviewBlock data={data} list={list} rep={rep} cat={cat} setCat={setCat} reload={() => load(false)} />
      {data.is_admin && !rep && data.reps && data.reps.length ? <RepSummary data={data} onPick={(code) => { pickRep(code); window.scrollTo(0, 0); }} /> : null}

      <section className="mt-4">
        <div className="mb-2 flex items-center justify-between gap-3 border-b border-line-strong pb-2">
          <h2 className="m-0 text-lg font-bold">{cat ? CATS.find(([v]) => v === cat)![1] : 'كل المدينين'}</h2>
          <Amount value={total(items)} className="text-sm text-muted" />
        </div>
        {cat ? <p className="mb-2 mt-0 text-sm text-muted">{CAT_NOTE[cat]}</p> : null}
        {items.length ? (
          <ul className={LIST_BOX}>
            {shown.map((c) => <CustomerItem key={c.id} c={c} d={data} rep={rep} onReview={(r) => setReviewing({ c, r })} />)}
          </ul>
        ) : <Empty>{q ? 'لا عميل يطابق البحث.' : list.length ? 'لا عملاء في هذه الفئة.'
          : data.is_admin ? 'لا أرصدة مفتوحة لهذا الاختيار.' : 'لا رصيد مفتوح على عملائك. إن كان هذا غير صحيح، تأكد مع الإدارة أن حقل «Owner» على عملائك في زوهو يحمل رمزك.'}</Empty>}
        {more > 0 ? <Button className="mt-2 w-full py-3" onClick={() => setLimit(limit + PAGE)}>عرض {customersWord(more)} آخرين</Button> : null}
      </section>
      <p className="mt-4 text-sm text-muted">أيام التأخر تُعدّ من تاريخ استحقاق أقدم فاتورة غير مسدّدة. الرصيد الافتتاحي هو ما نُقل عند بداية زوهو بوكس.</p>

      {reviewing && rv ? <ReviewDialog data={data} me={me} c={reviewing.c} r={reviewing.r} onClose={() => setReviewing(null)} onSaved={markReviewed} /> : null}
    </>
  );
}

const Dot = () => <span aria-hidden className="text-soft">·</span>;

function CustomerItem({ c, d, rep, onReview }: { c: Cust; d: CollData; rep: string; onReview: (r: Rev | null) => void }) {
  const rv = d.review;
  const r = rv && needsReview(c) ? rv.items[c.id] : null;
  const canToggle = !!rv?.can_review && needsReview(c);
  const open = () => { location.hash = '#coll/c/' + c.id; };
  return (
    <li role="link" tabIndex={0} aria-label={`${c.name}، ${fmtAmount(c.balance)}، ${lateText(c)}`}
      onClick={open} onKeyDown={(e) => { if (e.target === e.currentTarget && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); open(); } }}
      className={cn('item flex min-h-[60px] cursor-pointer items-center gap-1 bg-surface py-2 pe-3 active:bg-surface-alt', canToggle ? 'ps-0' : 'ps-3')}>
      {canToggle ? (
        // زر «راجعت» بجانب العميل: يفتح بطاقة التأكيد، لأن المراجعة تُكتب في زوهو فوراً
        <button type="button" aria-pressed={!!r} aria-label={r ? `${c.name}: ${ZOHO_WORD[r.zoho] || 'راجعته'}` : 'راجعت ' + c.name}
          onClick={(e) => {
            e.stopPropagation();
            if (!r || sendable(r)) { onReview(r); return; }
            toast(r.zoho === 'done' ? 'سُجّلت هذه المراجعة في زوهو، فلا تُلغى.' : 'لم يصل رد واضح من زوهو. الإدارة تتحقق منها.', 'warn');
          }}
          className={cn('rev-btn -my-2 me-2 flex w-16 flex-none flex-col items-center justify-center gap-1 self-stretch border-e border-line px-1 py-2 text-sm font-semibold active:bg-surface-alt',
            r ? 'on text-foreground' : 'text-muted')}>
          <span aria-hidden className={cn('flex size-6 items-center justify-center border-2', r ? 'border-selected bg-selected text-selected-ink' : 'border-line-strong')}>
            {r ? <Check className="size-4" strokeWidth={3} /> : null}
          </span>
          <span>{r ? 'راجعته' : 'راجعت'}</span>
        </button>
      ) : null}
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <div className="flex items-start justify-between gap-3">
          <Ltr className="min-w-0 text-base font-semibold leading-snug [overflow-wrap:anywhere]">{c.name}</Ltr>
          <Amount value={c.balance} className="whitespace-nowrap font-display text-base font-semibold" />
        </div>
        <div className="flex flex-wrap items-center justify-between gap-x-2 gap-y-1">
          <div className={cn('flex min-w-0 flex-wrap items-center gap-x-1 text-sm', r ? 'text-foreground' : 'text-muted')}>
            <span>{r ? 'راجعته ' + timeOf(r.at) + (r.late ? ' (بعد الأجل)' : '') : lateText(c)}</span>
            {r && r.zoho !== 'done' ? <><Dot /><span className="font-semibold text-warning">{ZOHO_WORD[r.zoho]}</span></> : null}
            {c.invoices.length > 1 ? <><Dot /><span>{invoicesWord(c.invoices.length)}</span></> : null}
            {d.is_admin && !rep ? <><Dot />{c.owner ? <Ltr>{c.owner}</Ltr> : <span>بلا مندوب</span>}</> : null}
          </div>
          {!r && isOld(c) ? <span className="ms-auto"><LateMark days={99} text={c.late === null ? 'افتتاحي' : <><Ltr>+90</Ltr> يوماً</>} /></span> : null}
        </div>
        {r && r.note ? <Note compact className="text-foreground">{r.note}</Note> : null}
      </div>
      <span aria-hidden className="-me-2 flex w-8 flex-none items-center justify-center text-soft"><ChevronLeft className="size-4.5" /></span>
    </li>
  );
}

// ملخص المندوبين للمدير حين يختار «الكل»
function RepSummary({ data, onPick }: { data: CollData; onPick: (code: string) => void }) {
  const [open, setOpen] = useState(false);
  const reps = data.reps || [];
  return (
    <Fold open={open} onOpenChange={setOpen} className="mt-3"
      head={<div className="flex items-center justify-between gap-3"><span className="font-bold">حسب المندوب</span><span className="text-sm text-muted">{reps.length} مندوبين</span></div>}>
      <ul className={LIST_BOX}>
        {reps.map((r) => (
          <li key={r.rep || '-'} role="button" tabIndex={0} onClick={() => onPick(r.rep || '-')}
            onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onPick(r.rep || '-'); } }}
            className="flex min-h-[60px] cursor-pointer items-center gap-1 bg-raised px-3 py-2 active:bg-surface-alt">
            <div className="min-w-0 flex-1">
              <div className="flex items-start justify-between gap-3"><span className="font-semibold">{r.rep ? <Ltr>{r.rep}</Ltr> : 'بلا مندوب'}</span><Amount value={r.total} className="font-display font-semibold" /></div>
              <div className="text-sm text-muted">{customersWord(r.count)} · أكثر من 90 يوماً <Amount value={r.old} /></div>
            </div>
            <ChevronLeft aria-hidden className="size-4.5 text-soft" />
          </li>
        ))}
      </ul>
    </Fold>
  );
}

// المراجعة الأسبوعية: جدول المندوبين للمدير، وشريط التقدّم للمندوب
function ReviewBlock({ data, list, rep, cat, setCat, reload }: { data: CollData; list: Cust[]; rep: string; cat: string; setCat: (v: string) => void; reload: () => void }) {
  const rv = data.review;
  const [notesOpen, setNotesOpen] = useState(false);
  if (!rv) return null;
  const deadline = `الأجل الخميس ${fmtDeadline(rv.deadline)} الساعة 12:00`;
  const past = Date.now() > rv.deadline;
  if (data.is_admin && !rep) {
    const prog = rv.progress || [];
    const pending = <Unsent list={rv.unsent} reload={reload} />;
    if (!prog.length) return pending;
    const notes = rv.notes || [];
    return (
      <section className="mt-4">
        <div className="mb-2 flex items-center justify-between gap-3"><h2 className="m-0 text-lg font-bold">مراجعة الأسبوع</h2><span className="text-sm text-muted">{deadline}</span></div>
        <div className="overflow-x-auto border border-line bg-surface">
          <table className="w-full border-collapse text-base">
            <thead><tr>{['المندوب', 'راجع', 'آخر مراجعة', 'الحالة'].map((t) => <th key={t} className="whitespace-nowrap bg-brand px-2 py-2 text-start font-semibold text-white">{t}</th>)}</tr></thead>
            <tbody>
              {prog.map((p) => (
                <tr key={p.rep} className="even:[&>td]:bg-surface-alt">
                  <td className="border-b border-line px-2 py-2"><Ltr>{p.rep}</Ltr></td>
                  <td className="border-b border-line px-2 py-2"><Num>{`${p.done}/${p.need}`}</Num></td>
                  <td className="border-b border-line px-2 py-2">{p.last ? fmtDateTime(p.last).slice(0, 16) : 'لا شيء'}</td>
                  <td className="border-b border-line px-2 py-2">
                    <span className={p.done === p.need ? 'font-semibold' : past ? 'font-semibold text-danger' : 'text-muted'}>{p.done === p.need ? 'أنهى ✓' : past ? 'لم يُنهِ في الأجل' : 'جارية'}</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {notes.length ? (
          <Fold open={notesOpen} onOpenChange={setNotesOpen} className="mt-2"
            head={<div className="flex items-center justify-between gap-3"><span className="font-bold">ملاحظات المراجعة</span><span className="text-sm text-muted">{notes.length} ملاحظة</span></div>}>
            <ul className={LIST_BOX}>
              {notes.map((n, i) => (
                <li key={i} className="bg-raised px-3 py-2">
                  <div className="flex justify-between gap-3"><Ltr className="font-semibold">{n.name}</Ltr><Ltr className="text-sm text-muted">{n.rep}</Ltr></div>
                  <p className="my-1 text-base [overflow-wrap:anywhere]">{n.note + (n.late ? ' (بعد الأجل)' : '')}</p>
                  <div className="text-sm text-muted">{timeOf(n.at)}</div>
                </li>
              ))}
            </ul>
          </Fold>
        ) : null}
        {pending}
      </section>
    );
  }
  const need = list.filter(needsReview);
  if (!need.length || (!rv.can_review && !rep)) return null;
  const done = need.filter((c) => rv.items[c.id]).length;
  const all = done === need.length;
  const left = need.length - done;
  const text = all ? `${rv.can_review ? 'أنهيت' : 'أنهى'} مراجعة كل المدينين القدامى ✓`
    : past ? `انتهى الأجل، وبقي ${customersWord(left)} دون مراجعة.`
      : rv.can_review ? `راجعت ${done} من ${need.length}. اتصل بكل عميل، ثم اضغط «راجعت» بجانبه.` : `راجع ${done} من ${need.length}.`;
  const pct = Math.round((done / need.length) * 100);
  return (
    <section className={cn('mt-3 border border-line border-s-3 bg-surface px-3 py-3', all ? 'border-s-foreground' : past ? 'border-s-brand' : 'border-s-warning')}>
      <div className="flex flex-wrap items-baseline justify-between gap-2"><h2 className="m-0 text-base font-bold">مراجعة الأسبوع</h2><span className="text-sm text-muted">{deadline}</span></div>
      <div role="progressbar" aria-valuemin={0} aria-valuemax={need.length} aria-valuenow={done} className="my-2 h-2 bg-surface-alt">
        <div className={cn('h-full transition-[width] duration-150', all ? 'bg-foreground' : 'bg-warning')} style={{ width: `${pct}%` }} />
      </div>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className={cn('m-0 flex-[1_1_180px] text-sm', all && 'font-semibold', past && !all && 'font-semibold text-danger')}>{text}</p>
        {!all ? <Button className={cn('cut-sm border-0 bg-chip', cat === 'rev' && 'bg-selected text-selected-ink hover:bg-selected')} aria-pressed={cat === 'rev'} onClick={() => setCat(cat === 'rev' ? '' : 'rev')}>
          {cat === 'rev' ? 'اعرض الكل' : `اعرض من بقي (${left})`}</Button> : null}
      </div>
    </section>
  );
}

// للمدير: إرسال مراجعة لم تصل، أو حسم مراجعة انقطع ردها بعد التحقق في زوهو
function Unsent({ list, reload }: { list?: Review['unsent']; reload: () => void }) {
  const [open, setOpen] = useState(true);
  const [busy, setBusy] = useState('');
  if (!list || !list.length) return null;
  async function act(key: string, path: string, body: object, okText: string) {
    setBusy(key);
    try {
      const res = await api('/api/m/coll/review/' + path, { method: 'POST', body });
      if (res.state && res.state !== 'done') toast(res.state === 'unknown' ? 'لم يصل رد واضح من زوهو. تحقق قبل أي إعادة.' : (res.error || 'زوهو رفض التعليق.'), 'warn');
      else toast(okText);
      reload();
    } catch (e) {
      toast(errText(e), 'err');
    } finally {
      setBusy('');
    }
  }
  return (
    <Fold open={open} onOpenChange={setOpen} tone="warn" className="mt-2"
      head={<div className="flex items-center justify-between gap-3"><span className="font-bold">لم تصل إلى زوهو</span><span className="text-sm text-muted">{list.length}</span></div>}>
      <ul className={LIST_BOX}>
        {list.map((u) => {
          const key = u.week + u.id;
          const body = { week: u.week, customer_id: u.id };
          const waiting = u.state === 'unknown' || u.state === 'pending';
          return (
            <li key={key} className="bg-raised px-3 py-2">
              <div className="flex justify-between gap-3"><Ltr className="font-semibold">{u.name}</Ltr><Ltr className="text-sm text-muted">{u.rep}</Ltr></div>
              <div className="text-sm font-semibold text-warning">{(waiting ? 'بانتظار التحقق: افتح العميل في زوهو وابحث عن التعليق أدناه.' : ZOHO_WORD[u.state]) + (u.error ? ` (${u.error})` : '')}</div>
              <p className="my-1 text-sm text-muted [overflow-wrap:anywhere]">{u.text}</p>
              <div className="mt-2 flex flex-wrap gap-2 [&>button]:flex-1">
                {waiting ? (
                  <>
                    <Button disabled={busy === key} onClick={() => act(key, 'resolve', { ...body, found: true }, 'سُجّلت كأنها في زوهو')}>موجود في زوهو</Button>
                    <Button disabled={busy === key} onClick={() => act(key, 'resolve', { ...body, found: false }, 'صارت قابلة للإرسال')}>غير موجود</Button>
                  </>
                ) : <Button disabled={busy === key} onClick={() => act(key, 'send', body, 'أُرسلت إلى زوهو ✓')}>أرسل إلى زوهو</Button>}
              </div>
            </li>
          );
        })}
      </ul>
    </Fold>
  );
}

// نص التعليق كما سيُكتب في سجل العميل في زوهو (نفس صيغة الخادم في collcomment.ts)
function previewText(data: CollData, c: Cust, note: string, late: boolean) {
  const rv = data.review!;
  const now = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: 'Africa/Algiers', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
    .formatToParts(new Date()).map((x) => [x.type, x.value]));
  const wk = `${rv.week.slice(8, 10)}/${rv.week.slice(5, 7)}`;
  return `مراجعة التحصيل لأسبوع ${wk}: راجعه ${data.own_rep} يوم ${now.day}/${now.month} الساعة ${now.hour}:${now.minute}${late ? ' (بعد الأجل)' : ''}. `
    + `الرصيد ${fmtAmount(c.balance).replace(' DA', ' دج')}. ` + (note ? `الملاحظة: ${note}` : 'دون ملاحظة.') + ' — من تطبيق شيكاتي';
}

// بطاقة التأكيد: الملاحظة، ونص التعليق كما سيُكتب، ثم «سجّل في زوهو». لا رجوع بعد الإرسال.
function ReviewDialog({ data, me, c, r, onClose, onSaved }: { data: CollData; me: Me; c: Cust; r: Rev | null; onClose: () => void; onSaved: (c: Cust, r: Rev) => void }) {
  const rv = data.review!;
  const late = r ? r.late : Date.now() > rv.deadline;
  const [note, setNote] = useState(r ? r.note : '');
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [open, setOpen] = useState(true);
  const clean = note.replace(/\s+/g, ' ').trim();
  const finish = () => { setOpen(false); setTimeout(onClose, 0); };

  async function run() {
    setBusy(true);
    setError('');
    try {
      const res = await api('/api/m/coll/review', { method: 'POST', body: { customer_id: c.id, note: clean } });
      onSaved(c, { at: r ? r.at : new Date().toISOString().slice(0, 19).replace('T', ' '), note: clean, late: r ? r.late : res.late, by: me.user.username, zoho: res.zoho });
      setBusy(false);
      if (res.zoho === 'done') { toast('سُجّلت المراجعة في زوهو ✓'); finish(); return; }
      // سُجّلت في التطبيق ولم تصل إلى زوهو: نشرح دون إعادة تلقائية
      setDone(res.zoho === 'unknown'
        ? 'سُجّلت المراجعة في التطبيق، لكن لم يصل رد واضح من زوهو. لا تعد المحاولة: الإدارة تتحقق منها.'
        : 'سُجّلت المراجعة في التطبيق، لكن زوهو رفض التعليق. الإدارة تعيد إرساله، ويمكنك إعادة المحاولة لاحقاً.');
    } catch (e) {
      setBusy(false);
      setError(errText(e));
    }
  }

  return (
    <Modal open={open} onClose={finish} busy={busy} title={<>مراجعة <Ltr>{c.name}</Ltr></>}>
      <label className="block py-2">
        <span className="mb-2 block text-base font-semibold">ماذا قال العميل؟</span>
        <Textarea rows={3} maxLength={400} autoFocus disabled={busy || !!done} placeholder="اختياري. مثال: وعد بالدفع يوم الخميس" value={note} onChange={(e) => setNote(e.target.value)} />
      </label>
      <div className="my-2">
        <span className="text-sm text-muted">سيُكتب في سجل العميل في زوهو:</span>
        <Note className="mt-1 text-foreground">{previewText(data, c, clean, late)}</Note>
      </div>
      <Note tone="warn">بعد الإرسال لا تُعدَّل المراجعة ولا تُلغى من التطبيق.</Note>
      {done ? <Note tone="warn" className="mt-2 text-base">{done}</Note> : null}
      {error ? <FormError>{error}</FormError> : null}
      <ModalActions>
        {!done ? <Button variant="primary" disabled={busy} onClick={run}>{busy ? 'جارٍ التسجيل…' : 'سجّل في زوهو'}</Button> : null}
        <Button disabled={busy} onClick={finish}>{done ? 'إغلاق' : 'إلغاء'}</Button>
      </ModalActions>
    </Modal>
  );
}

// ——— بطاقة العميل ———
function CustomerPage({ data, id, me, onBack, onReview, onCancelled }: {
  data: CollData | null; id: string; me: Me; onBack: () => void; onReview: (c: Cust, r: Rev | null) => void; onCancelled: (c: Cust) => void;
}) {
  const c = data?.customers.find((x) => x.id === id);
  useFixedBottom(68, !!c);
  const [cancelling, setCancelling] = useState(false);
  // رأس الصفحة: لوح أحمر ملاصق للشريط العلوي، كما في صفحة الشيك
  const top = <Slab><SlabTop onBack={onBack} /><h1 className="m-0 text-lg font-bold">رصيد العميل</h1></Slab>;
  if (!data) return <>{top}<p className="mt-4 text-muted">جارٍ التحميل…</p></>;
  if (!c) return <>{top}<div className="mt-4"><Empty>لم يعد لهذا العميل رصيد مفتوح، أو ليس من عملائك.</Empty></div></>;

  const msg = `السلام عليكم، معك ${me.user.display_name} من ELONAC. نتصل بخصوص رصيدك عندنا، ${fmtAmount(c.balance).replace(' DA', '')} دج. متى يناسبك أن نسوّيه؟`;
  const rv = data.review;
  const r = rv && needsReview(c) ? rv.items[c.id] : null;

  async function cancelReview() {
    setCancelling(true);
    try {
      await api('/api/m/coll/review/' + encodeURIComponent(c!.id), { method: 'DELETE' });
      onCancelled(c!);
      toast('أُلغيت المراجعة');
    } catch (e) {
      toast(errText(e), 'err');
    } finally {
      setCancelling(false);
    }
  }

  return (
    <>
      <Slab>
        <SlabTop onBack={onBack} />
        <h1 className="m-0"><Ltr className="block text-lg font-bold leading-snug [overflow-wrap:anywhere]">{c.name}</Ltr></h1>
        <Amount value={c.balance} className="mt-1 block font-display text-3xl font-semibold leading-tight max-[360px]:text-2xl" />
        <div className="mt-2 flex flex-wrap gap-2">
          <Badge tone={isOld(c) ? 'dark' : 'inverse'}>{lateText(c)}</Badge>
          {c.invoices.length ? <Badge tone="inverse">{invoicesWord(c.invoices.length)}</Badge> : null}
          {data.is_admin ? <Badge tone="inverse">{c.owner ? <Ltr>{c.owner}</Ltr> : 'بلا مندوب'}</Badge> : null}
        </div>
      </Slab>
      <div className="mt-4 flex flex-col gap-3">

        {rv && needsReview(c) ? (
          !r ? (
            !rv.can_review ? <Note tone="warn">لم يُراجَع هذا العميل هذا الأسبوع.</Note> : (
              <Block title="مراجعة الأسبوع: لم تراجعه بعد" className="border-s-3 border-s-warning">
                <p className="text-sm text-muted">اتصل به، ثم سجّل ما قاله. المراجعة تُكتب تعليقاً في سجل العميل في زوهو.</p>
                <Button className="w-full" onClick={() => onReview(c, null)}>سجّل المراجعة</Button>
              </Block>
            )
          ) : (
            <Block title={`راجعه ${rv.can_review ? '' : r.by + ' '}${timeOf(r.at)}${r.late ? ' (بعد الأجل)' : ''}`.replace('  ', ' ')} className="border-s-3 border-s-foreground">
              <p className="my-1 text-base [overflow-wrap:anywhere]">{r.note || 'دون ملاحظة.'}</p>
              <p className={cn('text-sm', r.zoho === 'done' ? 'text-muted' : 'font-semibold text-warning')}>
                {r.zoho === 'done' ? '✓ مكتوبة في سجل العميل في زوهو.' : r.zoho === 'unknown' || r.zoho === 'pending'
                  ? 'لم يصل رد واضح من زوهو. لا تعد المحاولة: الإدارة تتحقق منها.' : 'لم تصل إلى زوهو بعد.'}
              </p>
              {rv.can_review && sendable(r) ? (
                <div className="mt-2 flex gap-2 [&>button]:flex-1">
                  <Button onClick={() => onReview(c, r)}>أعد الإرسال</Button>
                  <Button disabled={cancelling} onClick={cancelReview}>إلغاء المراجعة</Button>
                </div>
              ) : null}
            </Block>
          )
        ) : null}

        <Block title="الرصيد">
          <dl className="m-0 flex flex-col">
            <KV label="الرصيد في زوهو"><Amount value={c.balance} /></KV>
            {c.invoices.length ? <KV label="في الفواتير"><Amount value={round2(c.balance - c.opening)} /></KV> : null}
            {c.opening > 0 ? <KV label="رصيد افتتاحي"><Amount value={c.opening} /></KV> : null}
            {c.invoices.length ? <KV label="أقدم استحقاق" after={c.invoices[0].late ? `متأخرة ${daysWord(c.invoices[0].late)}` : undefined}><Num>{fmtDate(c.invoices[0].due)}</Num></KV> : null}
            <KV label="الهاتف">{c.phone ? <Num>{localPhone(c.phone)}</Num> : <span className="font-normal text-muted">لا رقم في زوهو</span>}</KV>
          </dl>
        </Block>

        {c.invoices.length ? (
          <Block title="الفواتير غير المسدّدة">
            <ul className="m-0 list-none p-0">
              {c.invoices.map((i) => (
                <li key={i.number} className="border-b border-line py-2 text-base last:border-b-0">
                  <div className="flex flex-wrap items-baseline justify-between gap-2"><Ltr className="font-semibold">{i.number}</Ltr><Amount value={i.balance} className="font-semibold" /></div>
                  <div className="text-sm text-muted">بتاريخ <Num>{fmtDate(i.date)}</Num> · الاستحقاق <Num>{fmtDate(i.due)}</Num>
                    {i.late ? <span className={i.late > 90 ? 'font-semibold text-danger' : ''}> · متأخرة {daysWord(i.late)}</span> : <span> · لم يحن موعدها</span>}</div>
                </li>
              ))}
            </ul>
          </Block>
        ) : null}
      </div>

      <div className="detailbar fixed inset-x-0 bottom-0 z-20 flex gap-2 border-t border-line-strong bg-surface px-4 pb-[calc(10px+env(safe-area-inset-bottom))] pt-2 [&>*]:flex-1">
        {c.phone ? <Button asChild variant="primary" className="py-2"><a href={'tel:+' + c.phone}>اتصال</a></Button>
          : <Button variant="primary" blocked className="py-2" onClick={() => toast('لا رقم هاتف لهذا العميل في زوهو.', 'warn')}>اتصال</Button>}
        {c.phone ? <Button asChild className="py-2"><a href={`https://wa.me/${c.phone}?text=${encodeURIComponent(msg)}`} target="_blank" rel="noopener">واتساب</a></Button>
          : <Button blocked className="py-2" onClick={() => toast('لا رقم هاتف لهذا العميل في زوهو.', 'warn')}>واتساب</Button>}
      </div>
    </>
  );
}
