// قسم «التحصيل»: أرصدة العملاء المدينين لكل مندوب (7/11/2026، بطلب ZEKRI).
// المندوب يرى عملاءه فقط، والمدير يختار المندوب. المراجعة الأسبوعية تُكتب تعليقاً على العميل في زوهو.
// العنوان بعد #: ‎#coll للقائمة، و‎#coll/c/<معرّف العميل> لبطاقة العميل.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Check, ChevronLeft } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Textarea } from '@/components/ui/input';
import { CLOSE_MS, Modal, ModalActions, Sheet, SheetOption } from '@/components/ui/dialog';
import { Fold } from '@/components/ui/collapsible';
import { FilterButton, ListTools } from '@/components/search';
import { AnimatedAmount, Amount, Ltr, Num } from '@/components/ltr';
import { PullToRefresh } from '@/components/pull';
import { Empty, ErrorBox, FormError, Note, RefreshButton, SkeletonList, Slab, SlabTop } from '@/components/shell';
import { toast } from '@/components/toast';
import { api, errText, type Me } from '@/lib/api';
import { useFixedBottom } from '@/lib/layout';
import { savedScroll } from '@/lib/hash';
import { readCache, writeCache } from '@/lib/cache';
import { load as loadKey, save as saveKey } from '@/lib/storage';
import { customersWord, daysWord, fmtAmount, fmtDate, fmtDateTime, invoicesWord, norm, relTime, round2 } from '@/lib/format';
import { cn } from '@/lib/utils';
import { isShared, markShared, sharedStyle } from '@/lib/motion';
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
  const [rep, setRep] = useState(() => (isAdmin ? loadKey(REP_KEY) : ''));
  // آخر أرصدة على الهاتف تُعرض فوراً، ثم تُحدَّث. لكل اختيار مندوب نسخته
  const keyOf = (code: string) => 'coll:' + me.user.username + ':' + code;
  const [data, setData] = useState<CollData | null>(() => readCache<CollData>(keyOf(rep))?.data || null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [loadedAt, setLoadedAt] = useState(() => readCache<CollData>(keyOf(rep))?.at || 0);
  const [, tick] = useState(0);
  const [cat, setCat] = useState('');
  const [q, setQ] = useState('');
  const [limit, setLimit] = useState(PAGE);
  const [reviewing, setReviewing] = useState<{ c: Cust; r: Rev | null } | null>(null);
  const [sheet, setSheet] = useState<'' | 'rep' | 'cat' | 'review'>('');
  const busyRef = useRef(false);
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
      writeCache(keyOf(repCode), d, Number(d.at) || Date.now());
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
    window.scrollTo(0, route.view === 'list' ? savedScroll(hash) : 0);
  }, [route.view, route.id]);

  function pickRep(code: string) {
    if (code === rep) return;
    setRep(code); saveKey(REP_KEY, code); setCat('');
    const c = readCache<CollData>(keyOf(code));
    if (c) { setData(c.data); setLoadedAt(c.at); }
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
  if (!data) return <><Slab><div className="pt-2 text-sm font-semibold">التحصيل</div></Slab><SkeletonList rows={8} /></>;

  const list = data.customers;
  const rv = data.review;
  const items0 = rv ? rv.items : {};
  const canRev = !!rv && (rv.can_review || !!rep);
  const inCatV = (c: Cust, v: string) => !v || (v === 'old' ? isOld(c) : v === 'rev' ? needsReview(c) && !items0[c.id] : catOf(c) === v);
  const match = (c: Cust) => !q || norm(c.name).includes(q) || c.invoices.some((i) => norm(i.number).includes(q));
  const items = list.filter((c) => inCatV(c, cat) && match(c));
  const shown = items.slice(0, limit);
  const more = items.length - shown.length;
  const old = list.filter(isOld);
  const who = data.is_admin ? (rep ? (rep === '-' ? 'العملاء بلا مندوب' : null) : 'كل العملاء') : 'عملائك';
  // الفئات في اللوحة السفلية: كل فئة بعدد عملائها ومجموعها، والفارغة تُخفى
  const catList = CATS.filter(([v]) => v !== 'rev' || canRev).map(([v, t]) => ({ v, t, of: list.filter((c) => inCatV(c, v)) }))
    .filter((x) => !x.v || x.of.length || x.v === cat);
  const catLabel = cat ? CATS.find(([v]) => v === cat)![1] : 'كل الفئات';
  const repLabel = rep ? (rep === '-' ? 'بلا مندوب' : <Ltr>{rep}</Ltr>) : 'كل المندوبين';
  const reps = data.reps || [];

  return (
    <>
      <PullToRefresh busy={busy} onRefresh={() => load(true)} />
      {/* اللوح الأحمر الملاصق للشريط العلوي، كما في شاشة الإيداع: المجموع، وزر التحديث بوقته */}
      <Slab>
        <div className="flex items-center justify-between gap-3 text-sm">
          <span className="font-semibold">{who ? `مجموع ديون ${who}` : <>مجموع ديون عملاء <Ltr>{rep}</Ltr></>}</span>
          <RefreshButton busy={busy} loadedAt={loadedAt} onClick={() => load(true)} onRed />
        </div>
        <AnimatedAmount value={total(list)} className="block font-display text-3xl font-semibold leading-tight tracking-tight max-[360px]:text-2xl" />
        <div className="mt-2 flex flex-wrap gap-x-3 text-sm">
          <span>{list.length ? `على ${customersWord(list.length)}` : 'لا رصيد مفتوح'}</span>
          {old.length ? <span>أكثر من 90 يوماً <Amount value={total(old)} className="font-semibold" /></span> : null}
        </div>
      </Slab>

      <ReviewBlock data={data} list={list} rep={rep} cat={cat} setCat={(v) => { setCat(v); setLimit(PAGE); }} onOpen={() => setSheet('review')} />

      {/* شريط الأدوات الموحّد: المندوب (للمدير) والفئة في لوحتين سفليتين، ثم العدسة */}
      <ListTools className="mt-3" placeholder="بحث باسم العميل أو رقم الفاتورة" onSearch={(v) => { setQ(norm(v)); setLimit(PAGE); }}>
        {data.is_admin ? <FilterButton className="rep-btn" label="اختيار المندوب" value={repLabel} active={!!rep} onClick={() => setSheet('rep')} /> : null}
        <FilterButton className="cat-btn" label="الفئة حسب التأخر" value={catLabel} active={!!cat} onClick={() => setSheet('cat')} />
      </ListTools>

      <section className="mt-4">
        <div className="mb-2 flex items-center justify-between gap-3 border-b border-line-strong pb-2">
          <h2 className="m-0 flex items-center gap-2 text-lg font-bold"><span>{cat ? catLabel : 'كل المدينين'}</span>
            <span className="num min-w-[22px] bg-foreground px-2 py-1 text-center text-sm font-semibold leading-none text-background">{items.length}</span></h2>
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

      <Sheet open={sheet === 'rep'} onClose={() => setSheet('')} title="المندوب" action={<Button onClick={() => setSheet('')}>إغلاق</Button>}>
        {[{ code: '', label: 'كل المندوبين' as React.ReactNode, count: reps.reduce((t, r) => t + r.count, 0), sum: round2(reps.reduce((t, r) => t + r.total, 0)), old: 0 },
          ...reps.map((r) => ({ code: r.rep || '-', label: r.rep ? <Ltr>{r.rep}</Ltr> : 'بلا مندوب' as React.ReactNode, count: r.count, sum: r.total, old: r.old }))].map((o) => (
          <SheetOption key={o.code || 'all'} selected={o.code === rep} label={o.label}
            meta={<><span>{customersWord(o.count)}{o.old ? <> · قديم <Amount value={o.old} /></> : null}</span><Amount value={o.sum} /></>}
            onClick={() => { setSheet(''); pickRep(o.code); window.scrollTo(0, 0); }} />
        ))}
      </Sheet>

      <Sheet open={sheet === 'cat'} onClose={() => setSheet('')} title="الفئة حسب التأخر" action={<Button onClick={() => setSheet('')}>إغلاق</Button>}>
        {catList.map(({ v, t, of }) => (
          <SheetOption key={v || 'all'} selected={v === cat} empty={!of.length} label={v ? t : 'كل الفئات'}
            meta={<><span>{of.length ? customersWord(of.length) : 'لا عملاء'}</span>{of.length ? <Amount value={total(of)} /> : null}</>}
            onClick={() => { setSheet(''); if (v !== cat) { setCat(v); setLimit(PAGE); window.scrollTo(0, 0); } }} />
        ))}
        <p className="m-0 px-4 pb-2 pt-3 text-sm text-muted">أيام التأخر تُعدّ من تاريخ استحقاق أقدم فاتورة غير مسدّدة. الرصيد الافتتاحي هو ما نُقل عند بداية زوهو بوكس.</p>
      </Sheet>

      {rv && data.is_admin && !rep ? (
        <Sheet open={sheet === 'review'} onClose={() => setSheet('')} title="مراجعة الأسبوع" action={<Button onClick={() => setSheet('')}>إغلاق</Button>}>
          <div className="px-4 pb-3"><ReviewDetails data={data} reload={() => load(false)} /></div>
        </Sheet>
      ) : null}

      {reviewing && rv ? <ReviewDialog data={data} me={me} c={reviewing.c} r={reviewing.r} onClose={() => setReviewing(null)} onSaved={markReviewed} /> : null}
    </>
  );
}

const Dot = () => <span aria-hidden className="text-soft">·</span>;

function CustomerItem({ c, d, rep, onReview }: { c: Cust; d: CollData; rep: string; onReview: (r: Rev | null) => void }) {
  const rv = d.review;
  const r = rv && needsReview(c) ? rv.items[c.id] : null;
  const canToggle = !!rv?.can_review && needsReview(c);
  const ref = useRef<HTMLLIElement>(null);
  const open = () => { markShared(c.id, ref.current); location.hash = '#coll/c/' + c.id; };
  const shared = isShared(c.id);
  return (
    <li ref={ref} role="link" tabIndex={0} aria-label={`${c.name}، ${fmtAmount(c.balance)}، ${lateText(c)}`}
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
          <span data-vt="cust" style={sharedStyle(shared, 'cust')} className="min-w-0"><Ltr className="text-base font-semibold leading-snug [overflow-wrap:anywhere]">{c.name}</Ltr></span>
          <span data-vt="amt" style={sharedStyle(shared, 'amt')}><Amount value={c.balance} className="whitespace-nowrap font-display text-base font-semibold" /></span>
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
    </li>
  );
}

// المراجعة الأسبوعية: للمدير سطر واحد يفتح التفاصيل في لوحة سفلية، وللمندوب شريط التقدّم
function ReviewBlock({ data, list, rep, cat, setCat, onOpen }: { data: CollData; list: Cust[]; rep: string; cat: string; setCat: (v: string) => void; onOpen: () => void }) {
  const rv = data.review;
  if (!rv) return null;
  const deadline = `الأجل الخميس ${fmtDeadline(rv.deadline)} الساعة 12:00`;
  const past = Date.now() > rv.deadline;
  if (data.is_admin && !rep) {
    const prog = rv.progress || [];
    const unsent = rv.unsent || [];
    if (!prog.length && !unsent.length) return null;
    const done = prog.reduce((t, p) => t + p.done, 0);
    const need = prog.reduce((t, p) => t + p.need, 0);
    const late = past && done < need;
    return (
      <button type="button" onClick={onOpen} aria-haspopup="dialog"
        className="review-btn mt-3 flex min-h-11 w-full items-center gap-2 border-b border-line py-2 text-start active:bg-surface-alt">
        <span className="min-w-0 flex-1">
          <span className="block text-base font-semibold">مراجعة الأسبوع: <Num>{`${done}/${need}`}</Num>
            {late ? <span className="text-danger"> · انتهى الأجل</span> : done === need && need ? ' ✓' : null}</span>
          <span className="block text-sm text-muted">{deadline}</span>
          {unsent.length ? <span className="block text-sm font-semibold text-warning">لم تصل إلى زوهو: {unsent.length}</span> : null}
        </span>
        <ChevronLeft aria-hidden className="size-4.5 flex-none text-soft" />
      </button>
    );
  }
  const need = list.filter(needsReview);
  if (!need.length || (!rv.can_review && !rep)) return null;
  const done = need.filter((c) => rv.items[c.id]).length;
  const all = done === need.length;
  const left = need.length - done;
  const text = all ? `${rv.can_review ? 'أنهيت' : 'أنهى'} مراجعة كل المدينين القدامى ✓`
    : past ? `انتهى الأجل، وبقي ${customersWord(left)} دون مراجعة.`
      : `${rv.can_review ? 'راجعت' : 'راجع'} ${done} من ${need.length}.`;
  const pct = Math.round((done / need.length) * 100);
  return (
    <section className="mt-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className={cn('m-0 text-base font-bold', past && !all && 'text-danger')}>مراجعة الأسبوع: {text}</h2>
        <span className="text-sm text-muted">{deadline}</span>
      </div>
      <div role="progressbar" aria-label="تقدّم المراجعة" aria-valuemin={0} aria-valuemax={need.length} aria-valuenow={done} className="my-2 h-2 bg-surface-alt">
        <div className={cn('h-full transition-[width] duration-200', all ? 'bg-foreground' : past ? 'bg-brand' : 'bg-warning')} style={{ width: `${pct}%` }} />
      </div>
      {!all ? (
        <Button className={cn('cut-sm w-full border-0 bg-chip', cat === 'rev' && 'bg-selected text-selected-ink hover:bg-selected')} aria-pressed={cat === 'rev'} onClick={() => setCat(cat === 'rev' ? '' : 'rev')}>
          {cat === 'rev' ? 'اعرض كل المدينين' : `اعرض من بقي دون مراجعة (${left})`}</Button>
      ) : null}
    </section>
  );
}

// تفاصيل المراجعة للمدير في اللوحة السفلية: تقدّم كل مندوب، والملاحظات، وما لم يصل إلى زوهو
function ReviewDetails({ data, reload }: { data: CollData; reload: () => void }) {
  const rv = data.review!;
  const [notesOpen, setNotesOpen] = useState(false);
  const past = Date.now() > rv.deadline;
  const prog = rv.progress || [];
  const notes = rv.notes || [];
  return (
    <>
      <Unsent list={rv.unsent} reload={reload} />
      {prog.length ? (
        <ul className={cn(LIST_BOX, 'mt-2')}>
          {prog.map((p) => (
            <li key={p.rep} className="flex min-h-[52px] items-center justify-between gap-3 px-3 py-2">
              <span className="min-w-0">
                <Ltr className="block font-semibold">{p.rep}</Ltr>
                <span className="block text-sm text-muted">{p.last ? 'آخر مراجعة ' + timeOf(p.last) : 'لم يراجع أحداً بعد'}</span>
              </span>
              <span className="flex flex-none flex-col items-end">
                <Num className="font-display font-semibold">{`${p.done}/${p.need}`}</Num>
                <span className={cn('text-sm', p.done === p.need ? 'font-semibold' : past ? 'font-semibold text-danger' : 'text-muted')}>{p.done === p.need ? 'أنهى ✓' : past ? 'لم يُنهِ في الأجل' : 'جارية'}</span>
              </span>
            </li>
          ))}
        </ul>
      ) : null}
      {notes.length ? (
        <Fold open={notesOpen} onOpenChange={setNotesOpen} className="mt-2"
          head={<div className="flex items-center justify-between gap-3"><span className="font-bold">ملاحظات المراجعة</span><span className="text-sm text-muted">{notes.length} ملاحظة</span></div>}>
          <ul className={LIST_BOX}>
            {notes.map((n, i) => (
              <li key={i} className="px-3 py-2">
                <div className="flex justify-between gap-3"><Ltr className="font-semibold">{n.name}</Ltr><Ltr className="text-sm text-muted">{n.rep}</Ltr></div>
                <p className="my-1 text-base [overflow-wrap:anywhere]">{n.note + (n.late ? ' (بعد الأجل)' : '')}</p>
                <div className="text-sm text-muted">{timeOf(n.at)}</div>
              </li>
            ))}
          </ul>
        </Fold>
      ) : null}
    </>
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
    + `الرصيد ${fmtAmount(c.balance).replace(' DA', ' دج')}. ` + (note ? `الملاحظة: ${note}` : 'دون ملاحظة.') + ' — من تطبيق ميداني';
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
  const finish = () => { setOpen(false); setTimeout(onClose, CLOSE_MS); };

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
  if (!data) return <>{top}<SkeletonList rows={3} /></>;
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
        <h1 className="m-0" style={sharedStyle(true, 'cust')}><Ltr className="block text-lg font-bold leading-snug [overflow-wrap:anywhere]">{c.name}</Ltr></h1>
        <Amount value={c.balance} style={sharedStyle(true, 'amt')} className="mt-1 block font-display text-3xl font-semibold leading-tight max-[360px]:text-2xl" />
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
                  <div className="flex flex-wrap items-baseline justify-between gap-x-2 text-sm text-muted">
                    <span>بتاريخ <Num>{fmtDate(i.date)}</Num> · الاستحقاق <Num>{fmtDate(i.due)}</Num></span>
                    <span className={cn('whitespace-nowrap', i.late > 90 && 'font-semibold text-danger')}>{i.late ? 'متأخرة ' + daysWord(i.late) : 'لم يحن موعدها'}</span>
                  </div>
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
