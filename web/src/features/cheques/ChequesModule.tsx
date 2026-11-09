// قسم «الشيكات»: ثلاث شاشات (الإيداع، كل الشيكات، التنبيهات)، والتسجيل، وصفحة تفاصيل لكل شيك.
// العنوان بعد # يحدد الشاشة: #cheques و#cheques/all و#cheques/alerts و#cheques/new و#cheques/c/<معرّف الدفعة>
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { FilterButton, ListTools } from '@/components/search';
import { Button } from '@/components/ui/button';
import { DateField } from '@/components/ui/datefield';
import { CLOSE_MS, Modal, ModalActions, Sheet, SheetOption } from '@/components/ui/dialog';
import { Segmented } from '@/components/ui/segmented';
import { AnimatedAmount, Amount, Num } from '@/components/ltr';
import { haptic } from '@/lib/motion';
import { PullToRefresh } from '@/components/pull';
import { setAlertCount } from '@/components/nav';
import { Empty, ErrorBox, FormError, Note, RefreshButton, SkeletonList, Slab } from '@/components/shell';
import { toast } from '@/components/toast';
import { api, errText, isCutOff, type Me } from '@/lib/api';
import { useFixedBottom } from '@/lib/layout';
import { cameFrom, savedScroll } from '@/lib/hash';
import { readCache, writeCache } from '@/lib/cache';
import { load as loadKey, save as saveKey } from '@/lib/storage';
import { cn } from '@/lib/utils';
import { chequeWord, fmtAmount, isoAddDays, norm, sum, todayIso } from '@/lib/format';
import { CardList, ChequeCard, ChequeSection, SectionHead, URGENT_DAYS } from './ui';
import { Fold } from '@/components/ui/collapsible';
import { ChequeImage } from './media';
import { DetailPage } from './detail';
import { RegisterPage } from './register';
import { DepositDialog } from './deposit';
import { byCustody, CUSTODY_FILTERS } from './custody';
import type { AlertKind, Cheque, ChequesData } from './types';

const MAX_BATCH = 15;
const STALE_MS = 60_000;
const PAGE = 60;
const LOC_KEY = 'shikati-location';
const CUSTODY_KEY = 'shikati-custody';
// نطاق التنبيهات: «لي» (عملائي وعهدتي) أو كل الشركة. المندوب يبدأ على «لي» (8/11/2026، بطلب ZEKRI)
const SCOPE_KEY = 'shikati-alerts-scope';
const SCOPES: [string, string, string][] = [['mine', 'عملائي وعهدتي', 'عملائي'], ['', 'كل الشركة', 'كل الشركة']];
// القيمة المحفوظة على الجهاز، وإلا ما يناسب الدور
const savedOr = (key: string, fallback: string) => { const v = loadKey(key, '\u0000'); return v === '\u0000' ? fallback : v; };
// التلميح في شريط الإيداع يظهر حتى أول إيداع على هذا الجهاز
const HINT_KEY = 'shikati-deposit-learned';
const LOCATIONS = [{ value: '', label: 'الكل' }, { value: 'الجزائر', label: 'الجزائر' }, { value: 'العلمة', label: 'العلمة' }];
const MAIN_STATUSES = ['في الحوزة', 'مودع في البنك', 'محصّل', 'مظهّر لمورد', 'مرفوض'];
const STATUS_FILTERS: [string, string][] = [['', 'كل الحالات'], ['في الحوزة', 'في الحوزة'], ['مودع في البنك', 'في البنك'], ['محصّل', 'محصّل'],
  ['مظهّر لمورد', 'مظهّر'], ['مرفوض', 'مرفوض'], ['other', 'أخرى']];
// أسباب التنبيه مرتبة من الأعجل. كل شيك يظهر مرة واحدة في مجموعة أعجل أسبابه، وتحته أسبابه كلها.
// text: سطر السبب تحت البطاقة. «متأخر» و«تحصيل متأخر» تظهر في شارة البطاقة نفسها، فلا سطر لهما.
// quiet: لا يُحسب في عدد التبويب.
type Tier = 'urgent' | 'follow' | 'info';
// admin: المدير يرى التفصيل كما في زوهو، والموظف يرى جملة تقول ما يفعل
const REASONS: Record<AlertKind, { rank: number; tier: Tier; text: (t: string | undefined, admin: boolean) => string | null; quiet?: boolean }> = {
  unknown_lock: { rank: 0, tier: 'urgent', text: (_t, admin) => admin
    ? 'بانتظار التحقق: انقطع الرد بعد محاولة الإيداع. تحقق في زوهو، ثم حرّر القفل من صفحة الإدارة.'
    : 'انقطع الرد أثناء إيداعه، فلا نعرف هل سُجّل. لا تعد إيداعه، وأبلغ المدير.' },
  rejected: { rank: 1, tier: 'urgent', text: () => 'تابعه مع العميل.' },
  endorse_incomplete: { rank: 2, tier: 'urgent', text: () => 'تظهير غير مكتمل: لم تُنشأ دفعة المورد. افتح الشيك وأتمّ التظهير.' },
  // سُلّم إليك شيك: أكّد استلامه من صفحته (العهدة)
  handover: { rank: 2.9, tier: 'follow', text: (t) => `سلّمه إليك ${t || 'زميل'}. افتح الشيك وأكّد استلامه أو ارفضه.` },
  collect_late: { rank: 3, tier: 'follow', text: () => null },
  late: { rank: 4, tier: 'follow', text: () => null },
  wrong_account: { rank: 5, tier: 'follow', text: (t, admin) => admin && t ? t + '.' : 'سُجّل في حساب خطأ في زوهو. أبلغ المدير ليصحّحه.' },
  box: { rank: 6, tier: 'follow', text: (t, admin) => admin && t ? 'الصندوق غير مطابق: ' + t.replace(/\s*\|\s*/g, ' · ') : 'الصندوق المسجّل لا يطابق من استلم الشيك. أبلغ المدير.' },
  fiscal: { rank: 7, tier: 'info', text: (t) => 'الملف الجبائي للعميل ناقص' + (t ? ': ' + t : '.'), quiet: true },
};
// التأخر بعد 14 يوماً عاجل، كما يرسمه شريط البطاقة الأحمر
function reasonOf(kind: AlertKind, c: Cheque): { rank: number; tier: Tier } {
  const late = kind === 'late' ? c.days : kind === 'collect_late' ? c.deposit_days || 0 : 0;
  return late > URGENT_DAYS ? { rank: 2.5, tier: 'urgent' } : REASONS[kind];
}
const TIERS: { id: Tier; title: string; tone: 'alert' | 'warn' | 'info' }[] = [
  { id: 'urgent', title: 'عاجل', tone: 'alert' },
  { id: 'follow', title: 'للمتابعة', tone: 'warn' },
  { id: 'info', title: 'للعلم', tone: 'info' },
];

type View = 'deposit' | 'all' | 'alerts' | 'new' | 'detail';
function parseRoute(hash: string): { view: View; id?: string } {
  const h = decodeURIComponent(hash.replace(/^#/, ''));
  const m = h.match(/^cheques\/c\/(\d{10,25})$/);
  if (m) return { view: 'detail', id: m[1] };
  if (h === 'cheques/all') return { view: 'all' };
  if (h === 'cheques/alerts') return { view: 'alerts' };
  if (h === 'cheques/new') return { view: 'new' };
  return { view: 'deposit' };
}

// فواصل زمنية في «كل الشيكات» بتاريخ الاستلام (القائمة مرتبة من الأحدث). الأسبوع يبدأ السبت
function weekGroups(items: Cheque[]): { title: string; items: Cheque[] }[] {
  const today = todayIso();
  const [y, m, d] = today.split('-').map(Number);
  const sinceSat = (new Date(Date.UTC(y, m - 1, d)).getUTCDay() + 1) % 7;
  const thisWeek = isoAddDays(today, -sinceSat);
  const lastWeek = isoAddDays(thisWeek, -7);
  const groups = [{ title: 'هذا الأسبوع', items: [] as Cheque[] }, { title: 'الأسبوع الماضي', items: [] as Cheque[] }, { title: 'أقدم', items: [] as Cheque[] }];
  for (const c of items) {
    const day = String(c.date || '').slice(0, 10);
    groups[day >= thisWeek ? 0 : day >= lastWeek ? 1 : 2].items.push(c);
  }
  return groups.filter((g) => g.items.length);
}

const byStatus = (c: Cheque, s: string) => !s || (s === 'other' ? !MAIN_STATUSES.includes(c.status) : c.status === s);
const learned = () => loadKey(HINT_KEY) === '1';
// المندوب يودع ما في عهدته وحده (بطلب ZEKRI يوم 9/11/2026)، والخادم يرفض غيره. المدير يودع أي شيك
const heldByMe = (c: Cheque) => !!c.custody?.mine && !c.custody.outgoing;
const whyNotHeld = (c: Cheque) => {
  const k = c.custody;
  if (k?.incoming) return 'سُلّم إليك: أكّد استلامه من صفحته، ثم أودِعه.';
  if (k?.outgoing) return 'سلّمته وينتظر تأكيد المستلم، فلا تودعه.';
  if (!k?.holder) return 'عهدته غير محددة: إن كان معك، افتحه واضغط «هو في عهدتي».';
  return `في عهدة ${k.holder}: يودعه هو، أو يسلّمه إليك.`;
};

export function ChequesModule({ me, hash }: { me: Me; hash: string }) {
  const isAdmin = me.user.role === 'admin';
  const route = useMemo(() => parseRoute(hash), [hash]);
  // آخر بيانات على الهاتف تُعرض فوراً، ثم تُحدَّث. الإيداع ينتظر البيانات الجديدة (fresh)
  const cacheKey = 'cheques:' + me.user.username;
  const [cached] = useState(() => readCache<ChequesData>(cacheKey));
  const [data, setData] = useState<ChequesData | null>(cached ? cached.data : null);
  const [fresh, setFresh] = useState(false);
  const [error, setError] = useState('');
  const [loadedAt, setLoadedAt] = useState(cached ? cached.at : 0);
  const [busy, setBusy] = useState(false);
  const [, tick] = useState(0);
  const [loc, setLoc] = useState(() => loadKey(LOC_KEY));
  const [q, setQ] = useState('');
  const [status, setStatus] = useState('');
  const [limit, setLimit] = useState(PAGE);
  const [selected, setSelected] = useState<Map<string, Cheque>>(new Map());
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const [sheet, setSheet] = useState(false);
  const hasRep = !!(me.user.rep_code || '').trim();
  // المندوب يبدأ على عهدته في الإيداع، وعلى عملائه وعهدته في التنبيهات، حتى يختار غير ذلك
  const [custody, setCustody] = useState(() => savedOr(CUSTODY_KEY, isAdmin ? '' : 'mine'));
  const [scope, setScope] = useState(() => (hasRep ? savedOr(SCOPE_KEY, isAdmin ? '' : 'mine') : ''));
  const [scopeSheet, setScopeSheet] = useState(false);
  const [custodySheet, setCustodySheet] = useState(false);
  const [depositing, setDepositing] = useState<Cheque[] | null>(null);
  // بعد الإيداع: الشيكات المودَعة تنطوي (leaving) ثم تُخفى (gone) حتى تصل البيانات الجديدة
  const [leaving, setLeaving] = useState<Set<string>>(new Set());
  const [gone, setGone] = useState<Set<string>>(new Set());
  const [, setLearnedTick] = useState(0);
  const busyRef = useRef(false);
  const dialogRef = useRef(false);
  const prevView = useRef<View>(route.view);
  const fromList = useRef(false);

  const load = useCallback(async (refresh: boolean) => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    try {
      const d = await api<ChequesData>('/api/m/cheques' + (refresh ? '?refresh=1' : ''));
      setData(d);
      setLoadedAt(Date.now());
      setFresh(true);
      setError('');
      writeCache(cacheKey, d);
    } catch (e) {
      setData((old) => { if (old) toast(errText(e), 'err'); else setError(errText(e)); return old; });
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }, [cacheKey]);

  useEffect(() => { load(false); }, [load]);
  useEffect(() => { const t = setInterval(() => tick((n) => n + 1), 30_000); return () => clearInterval(t); }, []);
  // تحديث تلقائي حين يعود الموظف إلى التطبيق، إلا أثناء التأكيد أو التحديد
  useEffect(() => {
    const onVis = () => {
      if (document.visibilityState !== 'visible' || dialogRef.current || selected.size) return;
      if (Date.now() - loadedAt > STALE_MS) load(false);
    };
    document.addEventListener('visibilitychange', onVis);
    return () => document.removeEventListener('visibilitychange', onVis);
  }, [load, loadedAt, selected.size]);

  // حفظ موضع التمرير لكل شاشة، والرجوع إليه
  useEffect(() => {
    const prev = prevView.current;
    const next = route.view;
    fromList.current = next === 'detail' && prev !== 'detail' ? true : next === 'detail' ? fromList.current : false;
    prevView.current = next;
    document.title = 'ميداني';
    window.scrollTo(0, next === 'detail' || next === 'new' ? 0 : savedScroll(hash));
  }, [route.view, route.id]);

  // البحث يُمسح عند تغيير الشاشة، لأن حقله يُغلق معها: لا تصفية خفية
  useEffect(() => { setQ(''); }, [route.view]);

  const isList = route.view === 'deposit' || route.view === 'all' || route.view === 'alerts';

  const matches = (c: Cheque) =>
    (!loc || c.location === loc) &&
    (!q || norm(c.customer).includes(q) || norm(c.cheque_number).includes(q) || norm(c.invoices).includes(q) || norm(c.number) === q);
  const pick = (items: Cheque[]) => items.filter(matches);

  // عدد التنبيهات في التبويب: الشيكات لا الأسباب، ودون التنبيهات الهادئة
  const inScope = (c: Cheque | undefined) => !scope || !!c?.own;
  const allById = useMemo(() => new Map((data?.all || []).map((c) => [c.id, c])), [data]);
  const alertCount = data ? new Set(data.alerts.filter((x) => REASONS[x.kind] && !REASONS[x.kind].quiet && inScope(allById.get(x.id))).map((x) => x.id)).size : 0;
  useEffect(() => { setAlertCount(alertCount); }, [alertCount]);

  // إزالة ما لم يعد قابلاً للإيداع من التحديد
  useEffect(() => {
    if (!data) return;
    const available = new Set(data.agb_in_hand.items.filter((c) => !c.lock).map((c) => c.id));
    setSelected((s) => {
      const n = new Map([...s].filter(([id]) => available.has(id)));
      return n.size === s.size ? s : n;
    });
  }, [data]);

  function toggle(c: Cheque) {
    haptic();
    setSelected((s) => {
      const n = new Map(s);
      if (n.has(c.id)) n.delete(c.id);
      else if (n.size >= MAX_BATCH) { toast(`يمكن تحديد ${MAX_BATCH} شيكاً على الأكثر في المرة الواحدة.`, 'warn'); return s; }
      else n.set(c.id, c);
      return n;
    });
  }

  const openFold = (id: string, has: boolean) => (q ? has : !!open[id]);
  const setFold = (id: string) => (v: boolean) => { if (!q) setOpen((o) => ({ ...o, [id]: v })); };

  // ——— الأشرطة الثابتة ———
  const selItems = route.view === 'deposit' ? [...selected.values()] : [];
  const hint = route.view === 'deposit' && !selItems.length && !!data && data.can_deposit && !learned() && data.agb_in_hand.items.some((c) => !c.lock);
  const barShown = selItems.length > 0 || hint;
  useFixedBottom(selItems.length ? 68 : 44, barShown);

  async function afterDeposit(r: { done: Cheque[]; failed: Cheque[]; attempted: boolean }) {
    dialogRef.current = false;
    setDepositing(null);
    if (!r.attempted) return;
    if (r.done.length) { saveKey(HINT_KEY, '1'); setLearnedTick((n) => n + 1); }
    setSelected(new Map());
    if (r.done.length) {
      haptic('success');
      const ids = new Set(r.done.map((c) => c.id));
      setLeaving(ids);
      setTimeout(() => { setGone(ids); setLeaving(new Set()); }, 320);
    }
    if (r.done.length && !r.failed.length) toast(`تم إيداع ${chequeWord(r.done.length, true)} · ${fmtAmount(sum(r.done))}`);
    else if (r.done.length) toast(`أُودع ${chequeWord(r.done.length)}، وبقي ${chequeWord(r.failed.length)} دون إيداع`, 'warn');
    else toast('لم يُسجَّل أي إيداع. راجع الرسائل.', 'err');
    await load(true);
    setGone(new Set());
  }

  // ——— الشاشات ———
  // زر التحديث بوقته: في اللوح الأحمر في شاشة الإيداع، وفي سطر الحالة في غيرها
  const refresh = (onRed: boolean) => <RefreshButton busy={busy} loadedAt={loadedAt} onClick={() => load(true)} onRed={onRed} />;
  const onDeposit = route.view === 'deposit';
  let summary: React.ReactNode = null;
  let statusText: React.ReactNode = null;
  let body: React.ReactNode = null;

  if (data && route.view === 'deposit') {
    // العهدة تصفّي ما في الحوزة وحده
    const held = (items: Cheque[]) => pick(items).filter((c) => byCustody(c.custody, custody));
    const agb = held(data.agb_in_hand.items).filter((c) => !gone.has(c.id));
    const rost = held(data.rostomia_in_hand.items);
    const noDest = held(data.no_destination.items);
    const waiting = [...agb, ...rost, ...noDest];
    // ما أُودع اليوم: من تاريخ الإيداع في زوهو، فيشمل ما أودعته دالة رسائل البنك أيضاً
    const today = todayIso();
    const doneToday = pick(data.all.filter((c) => c.deposit_date && c.deposit_date.slice(0, 10) === today));
    const lateCount = agb.filter((c) => c.days > 7).length;
    const others = [...rost, ...noDest];
    // اللوح الأحمر ملاصق للشريط العلوي: رقم واحد هو ما يؤخذ إلى بنك AGB، وهو مجموع القائمة تحته نفسها.
    // ما في الحوزة لغير AGB سطر صغير، حتى لا يختلف الرقم الكبير عن مجموع القائمة
    summary = (
      <Slab>
        <div className="flex items-center justify-between gap-3 text-sm">
          <span className="font-semibold">للإيداع في بنك AGB{loc ? ` — ${loc}` : ''}</span>
          {refresh(true)}
        </div>
        <AnimatedAmount value={sum(agb.filter((c) => !leaving.has(c.id)))} className="block font-display text-3xl font-semibold leading-tight tracking-tight [overflow-wrap:anywhere] max-[360px]:text-2xl" />
        <div className="mt-2 flex flex-wrap gap-x-3 text-sm" aria-live="polite">
          <span>{agb.length ? chequeWord(agb.length) : 'لا شيكات'}</span>
          {lateCount ? <span><span className="font-semibold">{lateCount}</span> متأخرة</span> : null}
          <span>{doneToday.length ? <>أُودع اليوم <span className="font-semibold">{doneToday.length}</span> · <Amount value={sum(doneToday)} /></> : 'لم يُودَع شيء اليوم بعد'}</span>
        </div>
        {others.length ? <div className="mt-1 text-sm opacity-90">وفي الحوزة لغير AGB: {chequeWord(others.length)} · <Amount value={sum(others)} /></div> : null}
      </Slab>
    );
    const opts = { selected: false, onToggle: toggle, link: true };
    const rejected = pick(data.rejected.items);
    const inBank = pick(data.agb_pending_collection.items);
    body = (
      <>
        <section className="mt-4">
          <div className="mb-2 border-b border-line-strong pb-2">
            <SectionHead title="في الحوزة لبنك AGB" count={agb.length} primary meta={agb.length > 1 ? 'الأقدم أولاً' : null} />
          </div>
          {agb.length ? (
            <CardList>
              {agb.map((c) => {
                const mayDeposit = data.can_deposit && (isAdmin || heldByMe(c));
                return <ChequeCard key={c.id} c={c} o={{ ...opts, selectable: mayDeposit, link: !mayDeposit, selected: selected.has(c.id), leaving: leaving.has(c.id),
                  note: data.can_deposit && !mayDeposit ? whyNotHeld(c) : undefined }} />;
              })}
            </CardList>
          ) : <Empty>{q || loc || custody ? 'لا شيك يطابق البحث أو التصفية.' : 'لا شيكات تنتظر الإيداع في بنك AGB.'}</Empty>}
        </section>
        <div className="mt-6 flex flex-col gap-2">
          {rejected.length ? <ChequeSection title="شيكات مرفوضة" items={rejected} opts={opts} collapsible note="تحتاج متابعة مع العميل." noteTone="alert"
            open={openFold('rejected', rejected.length > 0)} onOpenChange={setFold('rejected')} /> : null}
          {noDest.length ? <ChequeSection title="في الحوزة والوجهة غير محددة" items={noDest} opts={opts} collapsible noteTone="warn"
            note="لا تأخذها إلى البنك قبل أن يحدد المدير وجهتها." open={openFold('nodest', noDest.length > 0)} onOpenChange={setFold('nodest')} /> : null}
          <ChequeSection title="لبنك الرستمية" items={rost} opts={opts} collapsible note="إيداعها في الرستمية لا يُسجَّل من التطبيق بعد. القائمة للاطلاع فقط."
            open={openFold('rost', rost.length > 0)} onOpenChange={setFold('rost')} />
          <ChequeSection title="في بنك AGB بانتظار التحصيل" items={inBank} opts={opts} collapsible
            open={openFold('pending', inBank.length > 0)} onOpenChange={setFold('pending')} />
          <ChequeSection title="آخر 5 شيكات أُودعت في بنك AGB" items={pick(data.agb_recent.items)} opts={{ ...opts, showStatus: true, noAge: true }} collapsible hideTotal
            emptyText="لا توجد إيداعات بعد." open={openFold('recent', pick(data.agb_recent.items).length > 0)} onOpenChange={setFold('recent')} />
        </div>
      </>
    );
  } else if (data && route.view === 'all') {
    const items = data.all.filter((c) => byStatus(c, status) && matches(c));
    const shown = items.slice(0, limit);
    const more = items.length - shown.length;
    statusText = items.length ? <><span className="font-semibold text-foreground">{chequeWord(items.length)}</span> · <Amount value={sum(items)} /></> : 'لا نتائج';
    body = (
      <>
        {items.length ? weekGroups(shown).map((g) => (
          <section key={g.title}>
            <h2 className="mb-2 mt-4 flex justify-between gap-3 text-sm font-semibold text-muted"><span>{g.title}</span><span>{chequeWord(g.items.length)}</span></h2>
            <CardList>
              {g.items.map((c) => <ChequeCard key={c.id} c={c} o={{ link: true, showStatus: !status || status === 'other', ageInHandOnly: true, lateOnly: true }} />)}
            </CardList>
          </section>
        )) : <div className="mt-3"><Empty>لا شيك يطابق البحث أو التصفية.</Empty></div>}
        {more > 0 ? <Button className="mt-2 w-full py-3" onClick={() => setLimit(limit + PAGE)}>عرض المزيد ({more})</Button> : null}
      </>
    );
  } else if (data && route.view === 'alerts') {
    const byId = new Map(data.all.map((c) => [c.id, c]));
    // ما في بنك AGB بانتظار التحصيل: متابعة للمدير، لا عمل يومي للمودِع
    const inBank = pick(data.agb_pending_collection.items);
    summary = (
      <div className="cut-sm flex items-center justify-between gap-3 bg-tile px-4 py-2 text-white">
        <div className="text-sm font-semibold">في بنك AGB بانتظار التحصيل<span className="block font-normal">{chequeWord(inBank.length)}</span></div>
        <Amount value={sum(inBank)} className="whitespace-nowrap font-display text-lg font-semibold" />
      </div>
    );
    statusText = alertCount ? <>تحتاج متابعة: <span className="font-semibold text-foreground">{chequeWord(alertCount)}</span></> : 'لا شيك يحتاج متابعة.';
    // كل شيك مرة واحدة: أسبابه كلها، وأعجلها يحدد مجموعته وترتيبه
    const groups = new Map<string, { c: Cheque; kinds: { kind: AlertKind; text?: string }[]; rank: number; tier: Tier }>();
    for (const x of data.alerts) {
      const c = byId.get(x.id);
      if (!REASONS[x.kind] || !c || !matches(c) || !inScope(c)) continue;
      const def = reasonOf(x.kind, c);
      const g = groups.get(x.id) || { c, kinds: [], rank: 99, tier: 'info' as Tier };
      if (!g.kinds.some((k) => k.kind === x.kind)) g.kinds.push({ kind: x.kind, text: x.text });
      if (def.rank < g.rank) { g.rank = def.rank; g.tier = def.tier; }
      groups.set(x.id, g);
    }
    const sorted = [...groups.values()].sort((a, b) => a.rank - b.rank || b.c.days - a.c.days);
    const parts = TIERS.map((t) => {
      const list = sorted.filter((g) => g.tier === t.id);
      if (!list.length) return null;
      const cards = (
        <CardList>
          {list.map((g) => {
            const reasons = g.kinds.sort((a, b) => REASONS[a.kind].rank - REASONS[b.kind].rank)
              .map((k) => ({ tone: REASONS[k.kind].tier === 'urgent' ? 'alert' as const : REASONS[k.kind].tier === 'follow' ? 'warn' as const : 'info' as const, text: REASONS[k.kind].text(k.text, isAdmin) }))
              .filter((r): r is { tone: 'alert' | 'warn' | 'info'; text: string } => !!r.text);
            return <ChequeCard key={g.c.id} c={g.c} o={{ link: true, showStatus: true, lateOnly: true, ageInHandOnly: true, reasons }} />;
          })}
        </CardList>
      );
      const items = list.map((g) => g.c);
      // «للعلم» مطوي: ليس عملاً للمودِع
      if (t.id === 'info') {
        return (
          <Fold key={t.id} open={openFold('al-info', true)} onOpenChange={setFold('al-info')} className="fold mt-2"
            head={<SectionHead title={t.title} count={items.length} total={sum(items)} inTrigger />}>
            <div className="[&_.item]:bg-raised">{cards}</div>
          </Fold>
        );
      }
      return (
        <section key={t.id} className="mt-4">
          <div className={cn('mb-2 border-b pb-2', t.id === 'urgent' ? 'border-brand' : 'border-warning')}>
            <SectionHead title={t.title} count={items.length} total={sum(items)} primary />
          </div>
          {cards}
        </section>
      );
    }).filter(Boolean);
    body = parts.length ? <div>{parts}</div>
      : <div className="mt-4"><Empty>{q || loc ? 'لا تنبيه يطابق البحث أو الموقع.' : scope ? 'لا تنبيهات لعملائك ولا لشيكات عهدتك. لرؤية تنبيهات الشركة كلها اختر «كل الشركة».' : 'لا توجد تنبيهات. كل الشيكات في وضع سليم.'}</Empty></div>;
  }

  const statusDef = STATUS_FILTERS.find(([v]) => v === status) || STATUS_FILTERS[0];
  const custodyDef = CUSTODY_FILTERS.find(([v]) => v === custody) || CUSTODY_FILTERS[0];
  const scopeDef = SCOPES.find(([v]) => v === scope) || SCOPES[1];

  return (
    <>
      {isList ? (
        <>
          <PullToRefresh busy={busy} onRefresh={() => load(true)} disabled={selected.size > 0} />
          {onDeposit && !data ? <Slab><div className="pt-2 text-sm font-semibold">للإيداع في بنك AGB</div></Slab> : summary}
          {/* سطر الحالة: معلومة قصيرة يميناً، وزر التحديث بوقته يساراً. في الإيداع صار في اللوح الأحمر */}
          {!onDeposit ? (
            <div className={cn('flex min-h-11 items-center justify-between gap-3', summary && 'mt-2')}>
              <div className="min-w-0 text-sm text-muted" aria-live="polite">{data ? statusText : null}</div>
              {refresh(false)}
            </div>
          ) : null}
          {/* شريط الأدوات الموحّد: الموقع، والحالة في «كل الشيكات»، ثم العدسة */}
          <ListTools key={route.view} className={onDeposit ? 'mt-3' : 'mt-2'} placeholder="بحث باسم العميل أو رقم الشيك أو الفاتورة"
            onSearch={(v) => { setQ(norm(v)); setLimit(PAGE); }}>
            <Segmented label="الموقع" className="min-w-0 flex-[2]" value={loc} options={LOCATIONS} onChange={(v) => { setLoc(v); saveKey(LOC_KEY, v); setLimit(PAGE); }} />
            {route.view === 'deposit' ? (
              <FilterButton className="custody-btn max-w-[38%]" label={'تصفية بالعهدة: ' + custodyDef[1]} value={custodyDef[1]} active={!!custody} onClick={() => { if (data) setCustodySheet(true); }} />
            ) : null}
            {route.view === 'alerts' && hasRep ? (
              <FilterButton className="scope-btn max-w-[38%]" label={'نطاق التنبيهات: ' + scopeDef[1]} value={scopeDef[2]} active={!!scope} onClick={() => { if (data) setScopeSheet(true); }} />
            ) : null}
            {route.view === 'all' ? (
              <FilterButton className="status-btn max-w-[38%]" label={'تصفية بالحالة: ' + statusDef[1]} value={statusDef[1]} active={!!status} onClick={() => { if (data) setSheet(true); }} />
            ) : null}
          </ListTools>
          {error && !data ? <ErrorBox>{error}</ErrorBox> : !data ? <SkeletonList rows={route.view === 'deposit' ? 5 : 8} /> : <div aria-live="polite">{body}</div>}
        </>
      ) : route.view === 'detail' && route.id ? (
        <DetailPage id={route.id} isAdmin={isAdmin} preview={data?.all.find((c) => c.id === route.id)}
          // «أودِع هذا الشيك» في صفحته: لشيك في الحوزة لبنك AGB، دون قفل، وبعد وصول البيانات الجديدة
          depositable={fresh && data?.can_deposit ? data.agb_in_hand.items.find((c) => c.id === route.id && !c.lock && (isAdmin || heldByMe(c))) || null : null}
          onDeposited={() => load(true)} onBack={() => { if (fromList.current || cameFrom()) history.back(); else location.hash = '#cheques'; }} />
      ) : route.view === 'new' ? (
        <RegisterPage onDone={(pid) => { load(true); location.hash = '#cheques/c/' + pid; }} />
      ) : null}

      {/* شريط الإيداع فوق شريط التنقل: المحدد والمجموع والزران، أو شرح المس والإيداع قبل أول إيداع */}
      {barShown ? (
        selItems.length ? (
          <div className="actionbar fixed inset-x-0 z-[21] flex animate-bar-in items-center justify-between gap-2 border-t-3 border-t-brand bg-bar px-4 py-2 text-white bottom-[calc(var(--nav-h,60px)+env(safe-area-inset-bottom))]">
            <div className="flex flex-col text-sm leading-snug">
              <span className="font-semibold">المحدد: {chequeWord(selItems.length)}</span>
              <Amount value={sum(selItems)} className="font-display text-base font-semibold" />
            </div>
            <div className="flex gap-2">
              <Button variant="primary" className="px-4 py-2" blocked={!fresh} onClick={() => {
                // البيانات المعروضة من آخر فتح: لا إيداع قبل وصول الجديدة، فقد يكون الشيك تغيّر
                if (!fresh) { toast(busy ? 'انتظر لحظة حتى يكتمل التحديث، ثم أودع.' : 'البيانات قديمة. حدّث الشاشة أولاً، ثم أودع.', 'warn'); return; }
                dialogRef.current = true; setDepositing(selItems);
              }}>أودعت المحدد</Button>
              <Button className="border-line-on-dark bg-transparent px-2 py-2 text-white hover:bg-press-on-dark active:bg-press-on-dark" onClick={() => setSelected(new Map())}>إلغاء التحديد</Button>
            </div>
          </div>
        ) : (
          <div className="actionbar fixed inset-x-0 z-[21] flex min-h-11 items-center border-t border-line-strong bg-surface px-4 py-2 text-sm text-muted bottom-[calc(var(--nav-h,60px)+env(safe-area-inset-bottom))]">
            المس الشيكات التي سلّمتها للبنك، ثم «أودعت المحدد».
          </div>
        )
      ) : null}


      <Sheet open={sheet} onClose={() => setSheet(false)} title="تصفية بالحالة" action={<Button onClick={() => setSheet(false)}>إغلاق</Button>}>
        {data ? STATUS_FILTERS.map(([value, label]) => {
          const items = data.all.filter((c) => matches(c) && byStatus(c, value));
          const on = value === status;
          return (
            <SheetOption key={value || 'all'} selected={on} empty={!items.length} label={label}
              meta={<><span>{items.length ? chequeWord(items.length) : 'لا شيكات'}</span>{items.length ? <Amount value={sum(items)} /> : null}</>}
              onClick={() => { setSheet(false); if (value !== status) { setStatus(value); setLimit(PAGE); window.scrollTo(0, 0); } }} />
          );
        }) : null}
      </Sheet>

      <Sheet open={custodySheet} onClose={() => setCustodySheet(false)} title="تصفية بالعهدة" action={<Button onClick={() => setCustodySheet(false)}>إغلاق</Button>}>
        {data ? CUSTODY_FILTERS.map(([value, label]) => {
          const items = data.agb_in_hand.items.filter((c) => matches(c) && byCustody(c.custody, value));
          const on = value === custody;
          return (
            <SheetOption key={value || 'all'} selected={on} empty={!items.length} label={label}
              meta={<><span>{items.length ? chequeWord(items.length) + ' لبنك AGB' : 'لا شيكات لبنك AGB'}</span>{items.length ? <Amount value={sum(items)} /> : null}</>}
              onClick={() => { setCustodySheet(false); setCustody(value); saveKey(CUSTODY_KEY, value); window.scrollTo(0, 0); }} />
          );
        }) : null}
      </Sheet>

      <Sheet open={scopeSheet} onClose={() => setScopeSheet(false)} title="نطاق التنبيهات" action={<Button onClick={() => setScopeSheet(false)}>إغلاق</Button>}>
        {data ? SCOPES.map(([value, label]) => {
          const n = new Set(data.alerts.filter((x) => REASONS[x.kind] && (!value || allById.get(x.id)?.own)).map((x) => x.id)).size;
          return (
            <SheetOption key={value || 'all'} selected={value === scope} empty={!n} label={label}
              meta={<span>{n ? chequeWord(n) : 'لا تنبيهات'}</span>}
              onClick={() => { setScopeSheet(false); setScope(value); saveKey(SCOPE_KEY, value); window.scrollTo(0, 0); }} />
          );
        }) : null}
        <p className="m-0 px-4 pb-2 pt-3 text-sm text-muted">«عملائي وعهدتي»: شيكات عملائك في التحصيل، والشيكات التي في عهدتك أو سُلّمت إليك.</p>
      </Sheet>

      {depositing ? <DepositDialog items={depositing} onClosed={afterDeposit} /> : null}
    </>
  );
}
