// قسم «التحصيل»: أرصدة العملاء المدينين لكل مندوب (7/11/2026، بطلب ZEKRI).
// المندوب يرى عملاءه فقط، والمدير يختار المندوب.
// منذ 8/11/2026 (بطلب ZEKRI) إقرار الدين كل 14 يوماً بدل المراجعة الأسبوعية: صورة لديون العملاء،
// يقرّ المندوب بدين كل عميل أو يعترض عليه، والاعتراض وحده يُكتب تعليقاً على العميل في زوهو.
// العنوان بعد #: ‎#coll للقائمة، و‎#coll/c/<معرّف العميل> لبطاقة العميل، و‎#coll/ack لشاشة الإقرار.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Check, ChevronLeft, PenLine } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Textarea } from '@/components/ui/input';
import { Sheet, SheetOption } from '@/components/ui/dialog';
import { Fold } from '@/components/ui/collapsible';
import { FilterButton, ListTools } from '@/components/search';
import { AnimatedAmount, Amount, Ltr, Num } from '@/components/ltr';
import { PullToRefresh } from '@/components/pull';
import { Empty, ErrorBox, FormError, Note, RefreshButton, SkeletonList, Slab, SlabBack, SlabTop } from '@/components/shell';
import { toast } from '@/components/toast';
import { api, errText, type Me } from '@/lib/api';
import { useFixedBottom } from '@/lib/layout';
import { savedScroll } from '@/lib/hash';
import { readCache, writeCache } from '@/lib/cache';
import { load as loadKey, save as saveKey } from '@/lib/storage';
import { customersWord, daysWord, fmtAmount, fmtDate, fmtDateTime, invoicesWord, norm, round2 } from '@/lib/format';
import { cn } from '@/lib/utils';
import { haptic, isShared, markShared, sharedStyle } from '@/lib/motion';
import { LIST_BOX, LateMark } from '@/features/cheques/ui';
import { Block, KV } from '@/features/cheques/pickers';
import { loadAckStatus, peekAfterAck, setAckCounts, takeAfterAck } from '@/lib/ack';

const STALE_MS = 5 * 60_000;
const PAGE = 40;
const REP_KEY = 'shikati-coll-rep';

// الفئات حسب تأخر أقدم فاتورة غير مسدّدة، كما في قائمة الاتصال
const CATS: [string, string][] = [['', 'الكل'], ['ack', 'بانتظار الإقرار'], ['old', 'أكثر من 90 يوماً'], ['d90', 'من 31 إلى 90'], ['d30', 'حتى 30 يوماً'], ['due', 'لم يحن موعدها'], ['open', 'أرصدة افتتاحية']];
const CAT_NOTE: Record<string, string> = {
  ack: 'عملاء في صورة الدين لم يُقرّ المندوب بدينهم بعد.',
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
type AckItem = { answer: 'ok' | 'dispute' | null; reason: string | null; note: string; at: string | null; by: string | null; zoho: string };
type Unsent = { key: string; path: string; body: object; name: string; rep: string; state: string; error?: string | null; text: string };
type Ack = {
  cycle: string; next: string; state: 'ready' | 'pending' | 'error'; taken_at: string | null; can_ack: boolean;
  items: Record<string, AckItem>;
  admin?: {
    progress: { rep: string; total: number; done: number; disputes: number; last: string | null }[];
    disputes: { cycle: string; id: string; name: string; rep: string; balance: number; reason: string; note: string; at: string; zoho: string }[];
    unsent: { cycle: string; id: string; name: string; rep: string; state: string; error: string | null; text: string }[];
    history: { cycle: string; reps: { rep: string; total: number; done: number; disputes: number }[] }[];
  };
  old_unsent?: { week: string; id: string; name: string; rep: string; state: string; error?: string; text: string }[];
};
type CollData = { at: number; is_admin: boolean; rep: string; own_rep: string; customers: Cust[]; reps?: { rep: string; count: number; total: number; old: number }[]; ack?: Ack };

// أسباب الاعتراض على صورة الدين (نفسها في الخادم، collcomment.ts)
const REASONS: [string, string][] = [['paid', 'دفع ولم يُسجَّل'], ['not_mine', 'ليس عميلي'], ['amount', 'المبلغ خطأ'], ['other', 'سبب آخر']];
const reasonText = (r: string | null) => REASONS.find(([k]) => k === r)?.[1] || 'سبب آخر';

const catOf = (c: Cust) => (c.late === null ? 'open' : c.late > 90 ? 'old' : c.late > 30 ? 'd90' : c.late > 0 ? 'd30' : 'due');
const isOld = (c: Cust) => c.late === null || c.late > 90;
// من يقرّ بدين العميل: صاحب رمز المندوب نفسه، مندوباً كان أو المدير
const isMine = (d: CollData, c: Cust) => !!d.ack?.can_ack && !!d.own_rep && c.owner === d.own_rep;
const total = (list: Cust[]) => round2(list.reduce((t, c) => t + c.balance, 0));
const lateText = (c: Cust) => (c.late === null ? 'رصيد افتتاحي' : c.late > 0 ? `متأخر ${daysWord(c.late)}` : 'لم يحن موعدها');
// الرقم بالصيغة المحلية: 213561765718 يصبح 0561 76 57 18
const localPhone = (p: string) => (p.startsWith('213') && p.length === 12 ? ('0' + p.slice(3)).replace(/^(\d{4})(\d{2})(\d{2})(\d{2})$/, '$1 $2 $3 $4') : '+' + p);
const timeOf = (at: string) => { const t = fmtDateTime(at); return 'يوم ' + t.slice(0, 5) + ' الساعة ' + t.slice(11); };
// يوم الصورة بتوقيت الجزائر، وسبت الدورة التالية: يوم/شهر
const dayOf = (utc: string | null) => (utc ? fmtDateTime(utc).slice(0, 5) : '');
const dm = (iso: string) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}`;

// ‎#coll/ack شاشة الإقرار عميلاً بعد عميل
function parseRoute(hash: string) {
  const h = decodeURIComponent(hash.replace(/^#/, ''));
  const m = h.match(/^coll\/c\/(\d{10,25})$/);
  if (m) return { view: 'customer' as const, id: m[1] };
  if (h === 'coll/ack') return { view: 'ack' as const, id: '' };
  return { view: 'list' as const, id: '' };
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
  const [sheet, setSheet] = useState<'' | 'rep' | 'cat' | 'ack'>('');
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

  // شاشة الإقرار تقرأ صورة المستخدم نفسه من الخادم، وتحدّث القائمة حين يعود منها
  if (route.view === 'ack') return <AckFlow me={me} onChanged={() => load(false)} />;

  if (route.view === 'customer') {
    return (
      <CustomerPage data={data} id={route.id} me={me} onBack={() => { if (fromList.current) history.back(); else location.hash = '#coll'; }} onChanged={() => load(false)} />
    );
  }

  if (error && !data) return <><Slab><div className="pt-2 text-sm font-semibold">التحصيل</div></Slab><ErrorBox>{error}</ErrorBox></>;
  if (!data) return <><Slab><div className="pt-2 text-sm font-semibold">التحصيل</div></Slab><SkeletonList rows={8} /></>;

  const list = data.customers;
  const ackItems = data.ack ? data.ack.items : {};
  const waiting = (c: Cust) => !!ackItems[c.id] && !ackItems[c.id].answer;
  const inCatV = (c: Cust, v: string) => !v || (v === 'old' ? isOld(c) : v === 'ack' ? waiting(c) : catOf(c) === v);
  const match = (c: Cust) => !q || norm(c.name).includes(q) || c.invoices.some((i) => norm(i.number).includes(q));
  const items = list.filter((c) => inCatV(c, cat) && match(c));
  const shown = items.slice(0, limit);
  const more = items.length - shown.length;
  const old = list.filter(isOld);
  const who = data.is_admin ? (rep ? (rep === '-' ? 'العملاء بلا مندوب' : null) : 'كل العملاء') : 'عملائك';
  // الفئات في اللوحة السفلية: كل فئة بعدد عملائها ومجموعها، والفارغة تُخفى
  const catList = CATS.map(([v, t]) => ({ v, t, of: list.filter((c) => inCatV(c, v)) }))
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

      <AckBlock data={data} list={list} rep={rep} cat={cat} setCat={(v) => { setCat(v); setLimit(PAGE); }} onOpen={() => setSheet('ack')} />

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
            {shown.map((c) => <CustomerItem key={c.id} c={c} d={data} rep={rep} />)}
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

      {data.ack && data.is_admin && !rep ? (
        <Sheet open={sheet === 'ack'} onClose={() => setSheet('')} title="إقرار الدين" action={<Button onClick={() => setSheet('')}>إغلاق</Button>}>
          <div className="px-4 pb-3"><AckDetails ack={data.ack} reload={() => load(false)} /></div>
        </Sheet>
      ) : null}

    </>
  );
}

const Dot = () => <span aria-hidden className="text-soft">·</span>;

function CustomerItem({ c, d, rep }: { c: Cust; d: CollData; rep: string }) {
  const a = d.ack?.items[c.id];
  const ref = useRef<HTMLLIElement>(null);
  const open = () => { markShared(c.id, ref.current); location.hash = '#coll/c/' + c.id; };
  const shared = isShared(c.id);
  const mine = isMine(d, c);
  // الإقرار نفسه في شاشته، والقائمة تعرض الجواب فقط
  const said = a?.answer === 'ok' ? (mine ? 'أقررت بدينه' : 'أقرّ بدينه') : a?.answer === 'dispute' ? 'اعتراض: ' + reasonText(a.reason) : '';
  return (
    <li ref={ref} role="link" tabIndex={0} aria-label={`${c.name}، ${fmtAmount(c.balance)}، ${said || lateText(c)}`}
      onClick={open} onKeyDown={(e) => { if (e.target === e.currentTarget && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); open(); } }}
      className="item flex min-h-[60px] cursor-pointer items-center gap-1 bg-surface px-3 py-2 active:bg-surface-alt">
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <div className="flex items-start justify-between gap-3">
          <span data-vt="cust" style={sharedStyle(shared, 'cust')} className="min-w-0"><Ltr className="text-base font-semibold leading-snug [overflow-wrap:anywhere]">{c.name}</Ltr></span>
          <span data-vt="amt" style={sharedStyle(shared, 'amt')}><Amount value={c.balance} className="whitespace-nowrap font-display text-base font-semibold" /></span>
        </div>
        <div className="flex flex-wrap items-center justify-between gap-x-2 gap-y-1">
          <div className={cn('flex min-w-0 flex-wrap items-center gap-x-1 text-sm', said ? 'text-foreground' : 'text-muted')}>
            {a?.answer === 'ok' ? <span className="flex items-center gap-1 font-semibold"><Check aria-hidden className="size-4" strokeWidth={3} />{said}</span>
              : a?.answer === 'dispute' ? <span className="font-semibold text-warning">{said}</span> : <span>{lateText(c)}</span>}
            {a?.answer === 'dispute' && a.zoho !== 'done' ? <><Dot /><span className="font-semibold text-warning">{ZOHO_WORD[a.zoho]}</span></> : null}
            {c.invoices.length > 1 ? <><Dot /><span>{invoicesWord(c.invoices.length)}</span></> : null}
            {d.is_admin && !rep ? <><Dot />{c.owner ? <Ltr>{c.owner}</Ltr> : <span>بلا مندوب</span>}</> : null}
          </div>
          {!said && isOld(c) ? <span className="ms-auto"><LateMark days={99} text={c.late === null ? 'افتتاحي' : <><Ltr>+90</Ltr> يوماً</>} /></span> : null}
        </div>
        {a?.answer === 'dispute' && a.note ? <Note compact className="text-foreground">{a.note}</Note> : null}
      </div>
    </li>
  );
}

// إقرار الدين في شاشة التحصيل: للمدير سطر واحد يفتح التفاصيل في لوحة سفلية، وللمندوب التقدّم وزر الإقرار
function AckBlock({ data, rep, cat, setCat, onOpen }: { data: CollData; list: Cust[]; rep: string; cat: string; setCat: (v: string) => void; onOpen: () => void }) {
  const ak = data.ack;
  // «بلا مندوب»: لا إقرار لهؤلاء العملاء
  if (!ak || rep === '-') return null;
  if (ak.state !== 'ready') {
    return <Note className="mt-3">{ak.state === 'pending' ? 'صورة الدين قيد الإعداد الآن.' : 'تعذّر أخذ صورة الدين من زوهو. تُعاد المحاولة وحدها بعد قليل.'}</Note>;
  }
  const sub = `صورة يوم ${dayOf(ak.taken_at)} · التالية يوم السبت ${dm(ak.next)}`;
  if (data.is_admin && !rep) {
    const ad = ak.admin;
    const prog = ad?.progress || [];
    const unsent = (ad?.unsent.length || 0) + (ak.old_unsent?.length || 0);
    if (!prog.length && !unsent && !ad?.history.length) return null;
    const finished = prog.filter((p) => p.done === p.total).length;
    const disputes = ad?.disputes.length || 0;
    return (
      <button type="button" onClick={onOpen} aria-haspopup="dialog"
        className="ack-btn mt-3 flex min-h-11 w-full items-center gap-2 border-b border-line py-2 text-start active:bg-surface-alt">
        <span className="min-w-0 flex-1">
          <span className="block text-base font-semibold">إقرار الدين: أنهى <Num>{`${finished}/${prog.length}`}</Num>{finished === prog.length && prog.length ? ' ✓' : ''}
            {disputes ? <span className="text-warning"> · اعتراضات مفتوحة {disputes}</span> : null}</span>
          <span className="block text-sm text-muted">{sub}</span>
          {unsent ? <span className="block text-sm font-semibold text-warning">لم تصل إلى زوهو: {unsent}</span> : null}
        </span>
        <ChevronLeft aria-hidden className="size-4.5 flex-none text-soft" />
      </button>
    );
  }
  const items = Object.values(ak.items);
  const total = items.length;
  if (!total) return null;
  // «أنا»: المندوب في قائمته، والمدير حين يختار رمزه
  const self = ak.can_ack && (!data.is_admin || rep === data.own_rep);
  const done = items.filter((a) => a.answer).length;
  const disputes = items.filter((a) => a.answer === 'dispute').length;
  const all = done === total;
  const left = total - done;
  const text = all ? (self ? 'أنهيت إقرار كل عملائك ✓' : 'أنهى إقرار كل عملائه ✓') : `${self ? 'أقررت' : 'أقرّ'} بدين ${done} من ${total}`;
  return (
    <section className="mt-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="m-0 text-base font-bold">إقرار الدين: {text}</h2>
        <span className="text-sm text-muted">{sub}</span>
      </div>
      <div role="progressbar" aria-label="تقدّم الإقرار" aria-valuemin={0} aria-valuemax={total} aria-valuenow={done} className="my-2 h-2 bg-surface-alt">
        <div className={cn('h-full transition-[width] duration-200', all ? 'bg-foreground' : 'bg-warning')} style={{ width: `${Math.round((done / total) * 100)}%` }} />
      </div>
      {disputes ? <p className="mb-2 mt-0 text-sm text-muted">{self ? 'اعترضت على' : 'اعترض على'} دين {customersWord(disputes)}.</p> : null}
      {!all && self ? (
        <Button asChild variant="primary" className="ack-start w-full"><a href="#coll/ack">{done ? `أكمل الإقرار: بقي ${customersWord(left)}` : 'ابدأ الإقرار'}</a></Button>
      ) : !all ? (
        <Button className={cn('cut-sm w-full border-0 bg-chip', cat === 'ack' && 'bg-selected text-selected-ink hover:bg-selected')} aria-pressed={cat === 'ack'} onClick={() => setCat(cat === 'ack' ? '' : 'ack')}>
          {cat === 'ack' ? 'اعرض كل المدينين' : `اعرض من بقي دون إقرار (${left})`}</Button>
      ) : self ? <Button asChild className="w-full"><a href="#coll/ack">راجع أجوبتك</a></Button> : null}
    </section>
  );
}

// تفاصيل الإقرار للمدير في اللوحة السفلية: ما لم يصل إلى زوهو، وتقدّم كل مندوب، والاعتراضات، والدورات الماضية
function AckDetails({ ack, reload }: { ack: Ack; reload: () => void }) {
  const [dispOpen, setDispOpen] = useState(true);
  const [closing, setClosing] = useState('');
  const [closed, setClosed] = useState<Set<string>>(new Set());
  // «عولج»: يُغلق الاعتراض في التطبيق وحده، بعد أن يصحّحه المدير في زوهو
  async function close(x: { cycle: string; id: string; name: string }) {
    const key = x.cycle + x.id;
    setClosing(key);
    try {
      await api('/api/m/coll/ack/close', { method: 'POST', body: { cycle: x.cycle, customer_id: x.id } });
      setClosed((c) => new Set(c).add(key));
      toast('أُغلق الاعتراض على ' + x.name);
      reload();
    } catch (e) {
      toast(errText(e), 'err');
    } finally {
      setClosing('');
    }
  }
  const [histOpen, setHistOpen] = useState(false);
  const ad = ack.admin;
  const prog = ad?.progress || [];
  const disputes = (ad?.disputes || []).filter((x) => !closed.has(x.cycle + x.id));
  const hist = ad?.history || [];
  const missed = hist.reduce((t, c) => t + c.reps.filter((p) => p.done < p.total).length, 0);
  const unsent: Unsent[] = [
    ...(ad?.unsent || []).map((u) => ({ key: 'a' + u.cycle + u.id, path: '/api/m/coll/ack/', body: { cycle: u.cycle, customer_id: u.id }, name: u.name, rep: u.rep, state: u.state, error: u.error, text: u.text })),
    ...(ack.old_unsent || []).map((u) => ({ key: 'r' + u.week + u.id, path: '/api/m/coll/review/', body: { week: u.week, customer_id: u.id }, name: u.name, rep: u.rep, state: u.state, error: u.error, text: u.text })),
  ];
  return (
    <>
      <UnsentList list={unsent} reload={reload} />
      <p className="mb-0 mt-2 text-sm text-muted">صورة يوم {dayOf(ack.taken_at)}، والتالية يوم السبت {dm(ack.next)}.</p>
      {prog.length ? (
        <ul className={cn(LIST_BOX, 'mt-2')}>
          {prog.map((p) => (
            <li key={p.rep} className="flex min-h-[52px] items-center justify-between gap-3 px-3 py-2">
              <span className="min-w-0">
                <Ltr className="block font-semibold">{p.rep}</Ltr>
                <span className="block text-sm text-muted">{p.last ? 'آخر جواب ' + timeOf(p.last) : 'لم يبدأ بعد'}</span>
              </span>
              <span className="flex flex-none flex-col items-end">
                <Num className="font-display font-semibold">{`${p.done}/${p.total}`}</Num>
                <span className={cn('text-sm', p.done === p.total ? 'font-semibold' : 'text-muted')}>
                  {p.done === p.total ? 'أنهى ✓' : 'جارٍ'}{p.disputes ? ` · اعتراض ${p.disputes}` : ''}</span>
              </span>
            </li>
          ))}
        </ul>
      ) : null}
      {disputes.length ? (
        <Fold open={dispOpen} onOpenChange={setDispOpen} tone="warn" className="mt-2"
          head={<div className="flex items-center justify-between gap-3"><span className="font-bold">اعتراضات مفتوحة</span><span className="text-sm text-muted">{disputes.length}</span></div>}>
          <p className="mb-2 mt-0 text-sm text-muted">صحّح الخطأ في زوهو، ثم اضغط «عولج». تبقى هنا من كل الدورات حتى تغلقها.</p>
          <ul className={LIST_BOX}>
            {disputes.map((x) => (
              <li key={x.cycle + x.id} className="px-3 py-2">
                <div className="flex justify-between gap-3"><Ltr className="font-semibold">{x.name}</Ltr><Amount value={x.balance} className="text-sm" /></div>
                <p className="my-1 text-base [overflow-wrap:anywhere]">{reasonText(x.reason)}{x.note ? ': ' + x.note : '.'}</p>
                <div className="flex justify-between gap-3 text-sm text-muted"><Ltr>{x.rep}</Ltr><span>{x.cycle !== ack.cycle ? `دورة السبت ${dm(x.cycle)}` : x.at ? timeOf(x.at) : ''}</span></div>
                <Button className="mt-2 w-full" disabled={closing === x.cycle + x.id} onClick={() => close(x)}>{closing === x.cycle + x.id ? 'جارٍ الإغلاق…' : 'عولج'}</Button>
              </li>
            ))}
          </ul>
        </Fold>
      ) : null}
      {hist.length ? (
        // سجل الالتزام: لكل دورة مضت، كم أقرّ كل مندوب من عملاء صورته، وكم اعترض
        <Fold open={histOpen} onOpenChange={setHistOpen} className="mt-2"
          head={<div className="flex items-center justify-between gap-3"><span className="font-bold">الدورات الماضية</span>
            <span className={cn('text-sm', missed ? 'font-semibold text-danger' : 'text-muted')}>{missed ? `لم يُنهِ: ${missed}` : 'أنهوا كلهم ✓'}</span></div>}>
          <ul className={LIST_BOX}>
            {hist.map((w) => (
              <li key={w.cycle} className="px-3 py-2">
                <div className="mb-1 text-sm font-semibold text-muted">دورة السبت <Num>{dm(w.cycle)}</Num></div>
                {w.reps.map((p) => (
                  <div key={p.rep} className="flex min-h-11 items-center justify-between gap-3">
                    <Ltr className="font-semibold">{p.rep}</Ltr>
                    <span className="flex flex-none flex-col items-end">
                      <Num className="font-display font-semibold">{`${p.done}/${p.total}`}</Num>
                      <span className={cn('text-sm', p.done < p.total ? 'font-semibold text-danger' : 'text-muted')}>
                        {p.done < p.total ? `لم يُقرّ بـ${customersWord(p.total - p.done)}` : 'أنهى ✓'}{p.disputes ? ` · اعتراض ${p.disputes}` : ''}</span>
                    </span>
                  </div>
                ))}
              </li>
            ))}
          </ul>
        </Fold>
      ) : null}
    </>
  );
}

// للمدير: إرسال اعتراض (أو مراجعة قديمة) لم يصل إلى زوهو، أو حسم ما انقطع رده بعد التحقق في زوهو
function UnsentList({ list, reload }: { list: Unsent[]; reload: () => void }) {
  const [open, setOpen] = useState(true);
  const [busy, setBusy] = useState('');
  if (!list.length) return null;
  async function act(u: Unsent, what: 'send' | 'resolve', body: object, okText: string) {
    setBusy(u.key);
    try {
      const res = await api(u.path + what, { method: 'POST', body });
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
          const waiting = u.state === 'unknown' || u.state === 'pending';
          return (
            <li key={u.key} className="bg-raised px-3 py-2">
              <div className="flex justify-between gap-3"><Ltr className="font-semibold">{u.name}</Ltr><Ltr className="text-sm text-muted">{u.rep}</Ltr></div>
              <div className="text-sm font-semibold text-warning">{(waiting ? 'بانتظار التحقق: افتح العميل في زوهو وابحث عن التعليق أدناه.' : ZOHO_WORD[u.state]) + (u.error ? ` (${u.error})` : '')}</div>
              <p className="my-1 text-sm text-muted [overflow-wrap:anywhere]">{u.text}</p>
              <div className="mt-2 flex flex-wrap gap-2 [&>button]:flex-1">
                {waiting ? (
                  <>
                    <Button disabled={busy === u.key} onClick={() => act(u, 'resolve', { ...u.body, found: true }, 'سُجّل كأنه في زوهو')}>موجود في زوهو</Button>
                    <Button disabled={busy === u.key} onClick={() => act(u, 'resolve', { ...u.body, found: false }, 'صار قابلاً للإرسال')}>غير موجود</Button>
                  </>
                ) : <Button disabled={busy === u.key} onClick={() => act(u, 'send', u.body, 'أُرسل إلى زوهو ✓')}>أرسل إلى زوهو</Button>}
              </div>
            </li>
          );
        })}
      </ul>
    </Fold>
  );
}

// ——— شاشة إقرار الدين (8/11/2026، بطلب ZEKRI): عميلاً بعد عميل، بلمسة لكل عميل ———
// اللوح الأحمر: التقدّم، ثم العميل ورصيده في الصورة. تحته المقارنة بالصورة السابقة.
// «الدين صحيح» يُحفظ في التطبيق ويظهر التالي فوراً. «فيه خطأ» يفتح الأسباب، والاعتراض يُكتب في زوهو.
// المندوب الذي لم ينهِ لا يخرج منها إلا إلى تسجيل الشيك (القفل في app.tsx). المدير يرجع إلى التحصيل.
type AckRow = {
  id: string; name: string; balance: number; late: number | null; invoices: number; prev: number | null;
  now: number; opening: number; inv: Inv[];
  answer: 'ok' | 'dispute' | null; reason: string | null; note: string; at: string | null; zoho: string; error: string | null;
};
type AckList = { cycle: string; next: string; state: 'ready' | 'pending' | 'error'; taken_at: string | null; can_ack: boolean; rep?: string; had_prev: boolean; now_ok?: boolean; rows: AckRow[] };
// بعد كل انتقال يتوقف زرّا الجواب لحظة، فلا تقع لمسة مزدوجة على العميل التالي
const COOL_MS = 450;
// اسم الشاشة التي طلبها المندوب والتطبيق مقفل، لزر آخر الإقرار
const afterLabel = (h: string) => (h.startsWith('#cheques/c/') ? 'افتح الشيك' : h === '#cheques/alerts' ? 'إلى التنبيهات' : h.startsWith('#coll') ? 'إلى التحصيل' : 'تابع إلى ما طلبته');

// الاعتراض المرسل إلى زوهو (أو المنقطع) لا يُغيَّر
const fixed = (r: AckRow) => r.answer === 'dispute' && r.zoho !== 'none' && r.zoho !== 'failed';
const snapLate = (r: AckRow) => (r.late === null ? 'رصيد افتتاحي' : r.late > 0 ? `متأخر ${daysWord(r.late)}` : 'لم يحن موعدها');

function AckFlow({ me, onChanged }: { me: Me; onChanged: () => void }) {
  const locked = me.user.role === 'rep';
  const [list, setList] = useState<AckList | null>(null);
  const [error, setError] = useState('');
  const [pos, setPos] = useState(0);
  const [dispute, setDispute] = useState(false);
  const [cool, setCool] = useState(false);
  // آخر عميل أقرّ المندوب بدينه: سطر «تراجع» في أعلى الشاشة حتى الجواب التالي
  const [lastOk, setLastOk] = useState('');
  const coolT = useRef(0);
  const changed = useRef(false);
  const go = (i: number) => {
    setPos(i);
    setCool(true);
    window.clearTimeout(coolT.current);
    coolT.current = window.setTimeout(() => setCool(false), COOL_MS);
  };
  useEffect(() => () => window.clearTimeout(coolT.current), []);

  async function load() {
    setError('');
    try {
      const d = await api<AckList>('/api/m/coll/ack');
      setList(d);
      const first = d.rows.findIndex((r) => !r.answer);
      setPos(first < 0 ? d.rows.length : first);
    } catch (e) {
      setError(errText(e));
    }
  }
  useEffect(() => { load(); document.title = 'إقرار الدين'; }, []);
  // القائمة في التحصيل تُحدَّث بعد الخروج إن تغيّر شيء
  useEffect(() => () => { if (changed.current) onChanged(); }, []);
  // القفل وسطر التذكير يتبعان الأجوبة فوراً
  useEffect(() => { if (list) setAckCounts(list.cycle, list.rows.filter((r) => r.answer).length, list.rows.length); }, [list]);
  useEffect(() => { window.scrollTo(0, 0); }, [pos]);

  const rows = list?.rows || [];
  const r = pos < rows.length ? rows[pos] : null;
  const done = rows.filter((x) => x.answer).length;
  useFixedBottom(68, !!list && list.state === 'ready');

  // التالي: أول من لم يُجب بعد الحالي، ثم أول من لم يُجب، ثم النهاية
  const nextFrom = (i: number, arr: AckRow[]) => {
    const after = arr.findIndex((x, j) => j > i && !x.answer);
    if (after >= 0) return after;
    const any = arr.findIndex((x) => !x.answer);
    return any >= 0 ? any : arr.length;
  };
  const patch = (id: string, p: Partial<AckRow>) => setList((l) => (l ? { ...l, rows: l.rows.map((x) => (x.id === id ? { ...x, ...p } : x)) } : l));

  async function confirm() {
    if (!r || !list || cool) return;
    const before = r;
    const after = rows.map((x) => (x.id === r.id ? { ...x, answer: 'ok' as const, reason: null, note: '', zoho: 'skip' } : x));
    setList({ ...list, rows: after });
    go(nextFrom(pos, after));
    setLastOk(before.id);
    haptic('success');
    changed.current = true;
    try {
      await api('/api/m/coll/ack', { method: 'POST', body: { cycle: list.cycle, customer_id: before.id, answer: 'ok' } });
    } catch (e) {
      // لم يُحفظ: يعود العميل دون جواب
      patch(before.id, before);
      toast(`لم يُحفظ إقرار ${before.name}: ${errText(e)}`, 'err');
    }
  }
  // التراجع عن الإقرار (بطلب ZEKRI يوم 8/11/2026): يعود العميل دون جواب ويظهر من جديد، ويعود القفل حتى يجيب
  async function undo(id: string) {
    if (!list) return;
    const i = rows.findIndex((x) => x.id === id);
    const before = rows[i];
    if (!before || before.answer !== 'ok') return;
    patch(id, { answer: null, at: null });
    setLastOk('');
    go(i);
    changed.current = true;
    try {
      await api('/api/m/coll/ack', { method: 'POST', body: { cycle: list.cycle, customer_id: id, answer: 'clear' } });
      toast('تراجعت عن إقرار دين ' + before.name);
    } catch (e) {
      patch(id, before);
      toast(`لم يُحفظ التراجع: ${errText(e)}`, 'err');
    }
  }
  const last = rows.find((x) => x.id === lastOk && x.answer === 'ok' && x.id !== r?.id);
  const undoLine = last ? (
    <div className="flex min-h-11 items-center justify-between gap-3 border-b border-line text-sm">
      <span className="flex min-w-0 items-center gap-1"><Check aria-hidden className="size-4 flex-none" strokeWidth={3} />أقررت بدين <Ltr className="truncate font-semibold">{last.name}</Ltr></span>
      <Button variant="ghost" className="ack-undo -me-2 flex-none px-2 font-semibold underline underline-offset-4" onClick={() => undo(last.id)}>تراجع</Button>
    </div>
  ) : null;

  function disputed(row: AckRow, res: { zoho: string; error?: string }, reason: string, note: string) {
    const after = rows.map((x) => (x.id === row.id ? { ...x, answer: 'dispute' as const, reason, note, zoho: res.zoho, error: res.error || null } : x));
    setList((l) => (l ? { ...l, rows: after } : l));
    setDispute(false);
    changed.current = true;
    if (res.zoho === 'done') toast('سُجّل الاعتراض على ' + row.name + ' في زوهو ✓');
    else toast(res.zoho === 'unknown'
      ? 'سُجّل الاعتراض في التطبيق، لكن لم يصل رد واضح من زوهو. لا تعد المحاولة: الإدارة تتحقق منه.'
      : 'سُجّل الاعتراض في التطبيق، وزوهو رفض التعليق. الإدارة تعيد إرساله.', 'warn');
    go(nextFrom(pos, after));
  }

  const back = () => { location.hash = '#coll'; };
  const toRegister = () => { location.hash = '#cheques/new'; };
  const head = (
    <>
      <div className="flex min-h-11 items-center justify-between gap-3">
        {locked ? <span className="text-sm font-semibold">إقرار الدين</span> : <SlabBack onClick={back} />}
        {locked ? (
          // تسجيل الشيك مفتوح دائماً، حتى قبل إنهاء الإقرار
          <Button asChild variant="ghost" className="-me-2 gap-1 px-2 text-sm font-semibold text-white hover:bg-press-on-brand active:bg-press-on-brand">
            <a href="#cheques/new"><PenLine aria-hidden className="size-4.5" />سجّل شيكاً</a>
          </Button>
        ) : <span className="text-sm font-semibold">إقرار الدين</span>}
      </div>
      {list && list.state === 'ready' && rows.length ? (
        <>
          <div className="mt-1 flex items-baseline justify-between gap-3 text-sm">
            <span>صورة الدين يوم {dayOf(list.taken_at)}</span>
            <span>أجبت عن <Num>{`${done}/${rows.length}`}</Num></span>
          </div>
          <div role="progressbar" aria-label="تقدّم الإقرار" aria-valuemin={0} aria-valuemax={rows.length} aria-valuenow={done} className="mb-3 mt-2 h-1 bg-press-on-brand">
            <div className="h-full bg-white transition-[width] duration-200" style={{ width: `${Math.round((done / rows.length) * 100)}%` }} />
          </div>
        </>
      ) : null}
    </>
  );
  const bar = 'detailbar fixed inset-x-0 bottom-0 z-20 flex gap-2 border-t border-line-strong bg-surface px-4 pb-[calc(10px+env(safe-area-inset-bottom))] pt-2 [&>*]:flex-1';

  if (error && !list) {
    return <><Slab>{head}</Slab><ErrorBox>{error}</ErrorBox><Button className="mt-3 w-full" onClick={load}>أعد المحاولة</Button></>;
  }
  if (!list) return <><Slab>{head}</Slab><SkeletonList rows={3} /></>;
  if (!list.can_ack) {
    return <><Slab>{head}</Slab><div className="mt-4"><Empty>الإقرار لصاحب رمز المندوب. اطلب من الإدارة ربط حسابك برمزك في زوهو.</Empty></div></>;
  }
  if (list.state !== 'ready') {
    return (
      <>
        <Slab>{head}<h1 className="m-0 text-lg font-bold">صورة الدين</h1></Slab>
        <div className="mt-4 flex flex-col gap-3">
          <Note tone="warn" className="text-base">{list.state === 'pending' ? 'صورة الدين قيد الإعداد الآن. حاول بعد دقيقة.' : 'تعذّرت قراءة الديون من زوهو. حاول بعد دقيقة.'}</Note>
          <Button onClick={load}>أعد المحاولة</Button>
        </div>
      </>
    );
  }

  // النهاية: كل العملاء أُجيب عنهم، أو لا عملاء في الصورة
  if (!r) {
    const ok = rows.filter((x) => x.answer === 'ok');
    const disp = rows.filter((x) => x.answer === 'dispute');
    const stuck = disp.filter((x) => x.zoho !== 'done');
    return (
      <>
        <Slab>{head}<h1 className="m-0 text-lg font-bold">{rows.length ? 'أنهيت إقرار دين عملائك ✓' : 'لا ديون على عملائك في هذه الصورة'}</h1></Slab>
        <div className="mt-4 flex flex-col gap-3">
          {undoLine}
          {rows.length ? (
            <Block title="الخلاصة">
              <dl className="m-0 flex flex-col">
                <KV label="أقررت بدين" after={<Amount value={round2(ok.reduce((t, x) => t + x.balance, 0))} />}>{customersWord(ok.length)}</KV>
                {disp.length ? <KV label="اعترضت على">{customersWord(disp.length)}</KV> : null}
                <KV label="الصورة التالية">يوم السبت <Num>{dm(list.next)}</Num></KV>
              </dl>
            </Block>
          ) : <Empty>{`لم يكن لعملائك دين يوم ${dayOf(list.taken_at)}. الصورة التالية يوم السبت ${dm(list.next)}.`}</Empty>}
          {stuck.length ? <Note tone="warn">{`لم يصل إلى زوهو اعتراضك على ${customersWord(stuck.length)}. الإدارة تتابعه.`}</Note> : null}
        </div>
        <div className={bar}>
          {peekAfterAck() ? <Button variant="primary" className="!flex-[2] py-2" onClick={() => { location.hash = takeAfterAck(); }}>{afterLabel(peekAfterAck())}</Button>
            : <Button variant="primary" className="!flex-[2] py-2" onClick={locked ? toRegister : back}>{locked ? 'إلى التسجيل' : 'رجوع إلى التحصيل'}</Button>}
          {rows.length ? <Button className="py-2" onClick={() => setPos(0)}>راجع أجوبتك</Button> : null}
        </div>
      </>
    );
  }

  const diff = r.prev === null ? null : round2(r.balance - r.prev);
  // الرصيد الآن يختلف عن الصورة (دفع أو اشترى بعدها). لا يُعرض إن تعذّرت قراءة الأرصدة
  const moved = !!list.now_ok && Math.abs(r.now - r.balance) >= 1;
  return (
    <>
      <Slab>
        {head}
        {/* العميل الجديد يظهر بحركة قصيرة، فيرى المندوب أن العميل تغيّر */}
        <div key={r.id} className="animate-fade-in">
          <h1 className="m-0"><Ltr className="block text-lg font-bold leading-snug [overflow-wrap:anywhere]">{r.name}</Ltr></h1>
          <Amount value={r.balance} className="mt-1 block font-display text-3xl font-semibold leading-tight max-[360px]:text-2xl" />
          <div className="mt-2 flex flex-wrap gap-2">
            <Badge tone={r.late === null || r.late > 90 ? 'dark' : 'inverse'}>{snapLate(r)}</Badge>
            {r.invoices ? <Badge tone="inverse">{invoicesWord(r.invoices)}</Badge> : null}
          </div>
        </div>
      </Slab>

      {undoLine ? <div className="mt-2">{undoLine}</div> : null}
      {/* مفتاح مختلف عن مفتاح اللوحة السفلية أدناه: مفتاحان متطابقان بين الإخوة يُبقيان محتوى العميل السابق */}
      <div key={'body-' + r.id} className="mt-4 flex animate-fade-in flex-col gap-3">
        <dl className="m-0 flex flex-col">
          <KV label="في الصورة السابقة" after={diff ? <>{diff > 0 ? 'زاد ' : 'نقص '}<Amount value={Math.abs(diff)} /></> : undefined}>
            {r.prev === null ? <span className="font-normal text-muted">{list.had_prev ? 'جديد في قائمتك' : 'أول صورة'}</span>
              : diff === 0 ? <span className="font-normal">لم يتغير</span> : <Amount value={r.prev} />}
          </KV>
          {moved ? <KV label="رصيده الآن" after={r.now > r.balance ? 'اشترى بعد الصورة' : r.now < 1 ? 'سدّد كل دينه بعد الصورة' : 'دفع بعد الصورة'}><Amount value={r.now} /></KV> : null}
        </dl>
        {moved ? <Note plain>أقِرّ بالرصيد يوم الصورة. ما تغيّر بعدها يظهر في الصورة التالية.</Note> : null}
        {!moved && (r.inv.length || r.opening > 0) ? (
          // الفواتير غير المسدّدة الآن، ليتحقق المندوب مما يقرّ به
          <Block title="الفواتير غير المسدّدة">
            <ul className="m-0 list-none p-0">
              {r.inv.map((i) => (
                <li key={i.number} className="flex flex-wrap items-baseline justify-between gap-x-2 border-b border-line py-2 text-base last:border-b-0">
                  <span><Ltr className="font-semibold">{i.number}</Ltr> <span className="text-sm text-muted">· <Num>{fmtDate(i.date)}</Num></span></span>
                  <Amount value={i.balance} className="font-semibold" />
                </li>
              ))}
              {r.opening > 0 ? (
                <li className="flex items-baseline justify-between gap-x-2 py-2 text-base">
                  <span className="font-semibold">رصيد افتتاحي</span><Amount value={r.opening} className="font-semibold" />
                </li>
              ) : null}
            </ul>
          </Block>
        ) : null}
        {r.answer === 'ok' ? (
          <div className="flex flex-wrap items-center justify-between gap-2">
            <Note plain className="text-foreground">أقررت بدينه.</Note>
            <Button className="ack-clear" onClick={() => undo(r.id)}>تراجع عن الإقرار</Button>
          </div>
        ) : null}
        {r.answer === 'dispute' ? (
          <Block title="اعترضت على دينه" className="border-s-3 border-s-warning ps-3">
            <p className="my-1 text-base [overflow-wrap:anywhere]">{reasonText(r.reason)}{r.note ? ': ' + r.note : '.'}</p>
            <p className={cn('m-0 text-sm', r.zoho === 'done' ? 'text-muted' : 'font-semibold text-warning')}>
              {r.zoho === 'done' ? '✓ مكتوب في سجل العميل في زوهو، فلا يُغيَّر.' : fixed(r) ? 'لم يصل رد واضح من زوهو. لا تعد المحاولة: الإدارة تتحقق منه.' : 'لم يصل إلى زوهو بعد.'}
            </p>
          </Block>
        ) : null}
        {pos > 0 ? <Button variant="ghost" className="self-start px-2 text-muted" onClick={() => go(pos - 1)}>عُد إلى العميل السابق</Button> : null}
      </div>

      <div className={bar}>
        {fixed(r) ? <Button variant="primary" className="!flex-[2] py-2" disabled={cool} onClick={() => go(nextFrom(pos, rows))}>التالي</Button> : (
          <>
            <Button variant="primary" className="ack-ok !flex-[2] py-2 disabled:opacity-100" disabled={cool} onClick={confirm}><Check aria-hidden className="size-5" strokeWidth={3} />الدين صحيح</Button>
            <Button className="ack-no py-2 disabled:opacity-100" disabled={cool} onClick={() => setDispute(true)}>فيه خطأ</Button>
          </>
        )}
      </div>

      <DisputeSheet key={'sheet-' + r.id} open={dispute} row={r} cycle={list.cycle} rep={list.rep || ''} takenAt={list.taken_at} onClose={() => setDispute(false)} onSaved={disputed} />
    </>
  );
}

// الاعتراض: السبب من قائمة، وملاحظة (إجبارية مع «سبب آخر»)، ونص التعليق كما سيُكتب في زوهو قبل الإرسال
function DisputeSheet({ open, row, cycle, rep, takenAt, onClose, onSaved }: {
  open: boolean; row: AckRow; cycle: string; rep: string; takenAt: string | null; onClose: () => void;
  onSaved: (row: AckRow, res: { zoho: string; error?: string }, reason: string, note: string) => void;
}) {
  const [reason, setReason] = useState(row.answer === 'dispute' ? row.reason || '' : '');
  const [note, setNote] = useState(row.answer === 'dispute' ? row.note : '');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const clean = note.replace(/\s+/g, ' ').trim();
  const missing = !reason ? 'اختر سبب الاعتراض.' : reason === 'other' && !clean ? 'اكتب السبب في الملاحظة.' : '';
  // نفس صيغة الخادم في collcomment.ts
  const text = `اعتراض على صورة الدين ليوم ${dayOf(takenAt)}: المندوب ${rep} لا يقرّ برصيد ${fmtAmount(row.balance).replace(' DA', ' دج')}. `
    + `السبب: ${reason ? reasonText(reason) : '(اختر السبب)'}.` + (clean ? ` الملاحظة: ${clean}` : '') + ' — من تطبيق ميداني';
  async function save() {
    if (missing) { setErr(missing); return; }
    setBusy(true); setErr('');
    try {
      const res = await api('/api/m/coll/ack', { method: 'POST', body: { cycle, customer_id: row.id, answer: 'dispute', reason, note: clean } });
      onSaved(row, res, reason, clean);
    } catch (e) {
      setErr(errText(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Sheet open={open} onClose={() => { if (!busy) onClose(); }} title="ما الخطأ في هذا الدين؟" action={<Button disabled={busy} onClick={onClose}>إلغاء</Button>}>
      {REASONS.map(([k, t]) => <SheetOption key={k} selected={reason === k} label={t} onClick={() => { setReason(k); setErr(''); }} />)}
      <div className="flex flex-col gap-3 px-4 pb-3 pt-3">
        <label className="block">
          <span className="mb-2 block text-base font-semibold">ملاحظة{reason === 'other' ? '' : ' (اختيارية)'}</span>
          <Textarea rows={2} maxLength={400} disabled={busy} placeholder="مثال: دفع نقداً يوم الأحد لأمين" value={note} onChange={(e) => setNote(e.target.value)} />
        </label>
        <div>
          <span className="text-sm text-muted">يُكتب في سجل العميل في زوهو، ولا يُعدَّل بعدها:</span>
          <Note className="mt-1 text-foreground">{text}</Note>
        </div>
        {err ? <FormError>{err}</FormError> : null}
        <Button variant="primary" className="w-full py-3" disabled={busy} blocked={!!missing} onClick={save}>{busy ? 'جارٍ التسجيل…' : 'سجّل الاعتراض في زوهو'}</Button>
      </div>
    </Sheet>
  );
}

// ——— بطاقة العميل ———
function CustomerPage({ data, id, me, onBack, onChanged }: { data: CollData | null; id: string; me: Me; onBack: () => void; onChanged: () => void }) {
  const c = data?.customers.find((x) => x.id === id);
  useFixedBottom(68, !!c);
  const [undoing, setUndoing] = useState(false);
  // رأس الصفحة: لوح أحمر ملاصق للشريط العلوي، كما في صفحة الشيك
  const top = <Slab><SlabTop onBack={onBack} /><h1 className="m-0 text-lg font-bold">رصيد العميل</h1></Slab>;
  if (!data) return <>{top}<SkeletonList rows={3} /></>;
  if (!c) return <>{top}<div className="mt-4"><Empty>لم يعد لهذا العميل رصيد مفتوح، أو ليس من عملائك.</Empty></div></>;

  const msg = `السلام عليكم، معك ${me.user.display_name} من ELONAC. نتصل بخصوص رصيدك عندنا، ${fmtAmount(c.balance).replace(' DA', '')} دج. متى يناسبك أن نسوّيه؟`;
  const ak = data.ack;
  const a = ak?.items[c.id];
  const mine = isMine(data, c);
  const day = ak ? dayOf(ak.taken_at) : '';
  // التراجع عن إقرار المستخدم نفسه في الدورة الحالية. للمندوب يعود القفل حتى يجيب من جديد
  async function undoAck() {
    if (!ak || !c) return;
    setUndoing(true);
    try {
      await api('/api/m/coll/ack', { method: 'POST', body: { cycle: ak.cycle, customer_id: c.id, answer: 'clear' } });
      toast('تراجعت عن إقرار دين ' + c.name);
      onChanged();
      loadAckStatus().catch(() => { /* تُحدَّث لاحقاً */ });
    } catch (e) {
      toast(errText(e), 'err');
    } finally {
      setUndoing(false);
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

        {ak && ak.state === 'ready' && c.owner ? (
          !a ? <Note>{`دين جديد بعد صورة يوم ${day}، يدخل في الصورة التالية يوم السبت ${dm(ak.next)}.`}</Note>
            : !a.answer ? (mine ? (
              <Block title="إقرار الدين: لم تُقرّ بعد" className="border-s-3 border-s-warning ps-3">
                <Button asChild className="w-full"><a href="#coll/ack">أكمل الإقرار</a></Button>
              </Block>
            ) : <Note tone="warn">{`لم يُقرّ المندوب بدين هذا العميل في صورة يوم ${day}.`}</Note>)
              : a.answer === 'ok' ? (
                <div className="flex flex-col gap-2">
                  <Note plain className="text-foreground">{`${mine ? 'أقررت' : 'أقرّ ' + (a.by || '')} بدينه في صورة يوم ${day}، ${a.at ? timeOf(a.at) : ''}.`.replace('  ', ' ')}</Note>
                  {mine ? <Button className="w-full" disabled={undoing} onClick={undoAck}>{undoing ? 'جارٍ التراجع…' : 'تراجع عن إقرارك'}</Button> : null}
                </div>
              ) : (
                <Block title={`اعتراض ${mine ? '' : (a.by || '') + ' '}${a.at ? timeOf(a.at) : ''}`.replace('  ', ' ')} className="border-s-3 border-s-warning ps-3">
                  <p className="my-1 text-base [overflow-wrap:anywhere]">{reasonText(a.reason)}{a.note ? ': ' + a.note : '.'}</p>
                  <p className={cn('m-0 text-sm', a.zoho === 'done' ? 'text-muted' : 'font-semibold text-warning')}>
                    {a.zoho === 'done' ? '✓ مكتوب في سجل العميل في زوهو.' : a.zoho === 'unknown' || a.zoho === 'pending'
                      ? 'لم يصل رد واضح من زوهو. لا تعد المحاولة: الإدارة تتحقق منه.' : 'لم يصل إلى زوهو بعد.'}
                  </p>
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
