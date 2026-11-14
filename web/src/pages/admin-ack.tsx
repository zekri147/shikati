// تبويب «الإقرار» في صفحة الإدارة (14/11/2026، بطلب ZEKRI): تقرير إقرار الدين لدورة يختارها المدير.
// ملخص لكل مندوب، ثم تفصيل كل عميل، وزر لتنزيل التقرير ملف إكسل. قراءة فقط، والخادم في src/modules/ackreport.ts.
import { useCallback, useEffect, useState } from 'react';
import { ChevronDown, Download } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Segmented } from '@/components/ui/segmented';
import { LIST_BOX } from '@/features/cheques/ui';
import { Amount, Ltr, Num } from '@/components/ltr';
import { ErrorBox, Note, SkeletonList } from '@/components/shell';
import { api, errText } from '@/lib/api';
import { customersWord, fmtAmount, fmtDateTime } from '@/lib/format';
import { cn } from '@/lib/utils';

type RepSum = {
  rep: string; name: string; total: number; ok: number; disputes: number; open: number; left: number;
  debt: number; remaining: number | null; collected: number | null; last: string | null;
};
type Row = {
  id: string; name: string; rep: string; balance: number; prev: number | null; late: number | null; invoices: number;
  remaining: number | null; answer: string | null; reason: string | null; note: string; by: string | null; at: string | null;
  zoho: string; resolved_at: string | null; resolved_by: string | null;
};
type Report = {
  cycle: string | null; next?: string; taken_at?: string; current?: boolean; cycles: { cycle: string; taken_at: string }[];
  balances_at?: number | null; reps: RepSum[]; rows: Row[];
};

const REASON: Record<string, string> = { paid: 'دفع ولم يُسجَّل', not_mine: 'ليس عميلي', amount: 'المبلغ خطأ', other: 'سبب آخر' };
const ZOHO: Record<string, string> = { failed: 'رفضه زوهو', unknown: 'بانتظار التحقق', pending: 'قيد الإرسال', none: 'لم يُرسل إلى زوهو' };
const dmy = (iso: string) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}`;
const pct = (part: number, whole: number) => (whole ? Math.min(100, Math.round((part / whole) * 100)) : 0);
const PAGE = 60;

type Filter = '' | 'left' | 'dispute' | 'ok';

export function AckTab() {
  const [data, setData] = useState<Report | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [rep, setRep] = useState('');
  const [filter, setFilter] = useState<Filter>('');
  const [limit, setLimit] = useState(PAGE);

  const load = useCallback(async (cycle?: string) => {
    setBusy(true); setError('');
    try {
      setData(await api<Report>('/api/admin/ack' + (cycle ? '?cycle=' + encodeURIComponent(cycle) : '')));
      setLimit(PAGE);
    } catch (e) { setError(errText(e)); } finally { setBusy(false); }
  }, []);
  useEffect(() => { load(); }, [load]);

  if (!data) return error ? <ErrorBox>{error}</ErrorBox> : <SkeletonList rows={5} />;
  if (!data.cycle) return <p className="m-0 text-muted">لا صورة دين بعد. تُؤخذ أول صورة في أول تشغيل للمهمة المجدولة أو عند فتح التحصيل.</p>;

  const t = data.reps.reduce((a, s) => ({
    total: a.total + s.total, ok: a.ok + s.ok, disputes: a.disputes + s.disputes, open: a.open + s.open, left: a.left + s.left,
    debt: a.debt + s.debt, collected: a.collected + (s.collected || 0),
  }), { total: 0, ok: 0, disputes: 0, open: 0, left: 0, debt: 0, collected: 0 });
  const canCollect = data.balances_at != null;
  const repRows = rep ? data.rows.filter((r) => r.rep === rep) : data.rows;
  const count = (f: Filter) => repRows.filter((r) => match(r, f)).length;
  const rows = repRows.filter((r) => match(r, filter));
  const repName = (code: string) => data.reps.find((s) => s.rep === code)?.name || code;

  return (
    <div>
      {/* الدورة: الحالية أولاً ثم الماضية */}
      <label className="block">
        <span className="mb-1 block text-sm font-semibold text-muted">الدورة</span>
        <span className="relative block">
          <select className="block min-h-11 w-full appearance-none border border-line-strong bg-surface pe-9 ps-3 py-2 text-foreground" value={data.cycle} disabled={busy}
            onChange={(e) => { setRep(''); setFilter(''); load(e.target.value); }}>
            {data.cycles.map((c, i) => <option key={c.cycle} value={c.cycle}>دورة السبت {dmy(c.cycle)}{i === 0 ? ' (الحالية)' : ''}</option>)}
          </select>
          <ChevronDown aria-hidden className="pointer-events-none absolute end-3 top-1/2 size-4.5 -translate-y-1/2 text-muted" />
        </span>
      </label>
      <p className="mb-0 mt-2 text-sm text-muted">
        صورة الدين يوم <Num>{fmtDateTime(data.taken_at || '').slice(0, 10)}</Num>{data.current ? <>، والتالية يوم السبت <Num>{dmy(data.next || '')}</Num></> : <>، والدورة التي بعدها بدأت يوم السبت <Num>{dmy(data.next || '')}</Num></>}.
      </p>
      {error ? <ErrorBox>{error}</ErrorBox> : null}

      {/* الخلاصة: الإقرار سطراً، والمال سطراً */}
      <div className={cn('mt-3 border border-line bg-surface px-4 py-3', busy && 'opacity-55')}>
        <p className="m-0 text-base font-bold">أجاب عن <Num>{`${t.ok + t.disputes}/${t.total}`}</Num> عميلاً{t.left ? '' : ' ✓'}</p>
        <p className="m-0 mt-1 text-sm text-muted">
          أقرّ <Num>{t.ok}</Num> · اعترض <Num>{t.disputes}</Num>{t.open ? <> (مفتوح <Num>{t.open}</Num>)</> : null}
          {t.left ? <span className="font-semibold text-warning"> · لم يُجب <Num>{t.left}</Num></span> : null}
        </p>
        <p className="m-0 mt-2 text-base">دين الصورة <Amount value={t.debt} className="font-semibold" /></p>
        {canCollect ? (
          <p className="m-0 mt-1 text-sm text-muted">حُصّل منه حتى الآن <Amount value={t.collected} /> (<Num>{pct(t.collected, t.debt) + '%'}</Num>)</p>
        ) : <p className="m-0 mt-1 text-sm text-muted">تعذّرت قراءة الأرصدة الآن، فلا يظهر ما حُصّل.</p>}
      </div>

      {/* لكل مندوب: لمسه يصفّي العملاء تحته */}
      <h3 className="mb-2 mt-4 text-sm font-semibold text-muted">المندوبون</h3>
      <ul className={LIST_BOX}>
        {data.reps.map((s) => {
          const on = rep === s.rep;
          return (
            <li key={s.rep}>
              <button type="button" aria-pressed={on} onClick={() => { setRep(on ? '' : s.rep); setLimit(PAGE); }}
                className={cn('ack-rep flex min-h-[60px] w-full items-center justify-between gap-3 px-3 py-2 text-start', on ? 'bg-selected text-selected-ink' : 'bg-surface active:bg-surface-alt')}>
                <span className="min-w-0">
                  <span className="block font-semibold">{s.name}{s.name !== s.rep ? <span className={cn('text-sm font-normal', on ? '' : 'text-muted')}> · <Ltr>{s.rep}</Ltr></span> : null}</span>
                  <span className={cn('block text-sm', on ? '' : 'text-muted')}>
                    دين <Amount value={s.debt} />{s.collected != null ? <> · حُصّل <Num>{pct(s.collected, s.debt) + '%'}</Num></> : null}
                    {s.disputes ? <> · اعتراض <Num>{s.disputes}</Num></> : null}
                  </span>
                </span>
                <span className="flex flex-none flex-col items-end">
                  <Num className="font-display font-semibold">{`${s.ok + s.disputes}/${s.total}`}</Num>
                  <span className={cn('text-sm', on ? '' : s.left ? 'font-semibold text-warning' : 'text-muted')}>{s.left ? `بقي ${s.left}` : 'أنهى ✓'}</span>
                </span>
              </button>
            </li>
          );
        })}
      </ul>

      <Button asChild variant="primary" size="lg" className="mt-4 w-full">
        <a href={'/api/admin/ack/xlsx?cycle=' + encodeURIComponent(data.cycle)} download><Download aria-hidden className="size-4.5" />نزّل التقرير ملف إكسل</a>
      </Button>
      <p className="mb-0 mt-2 text-sm text-muted">فيه ورقتان: ملخص المندوبين، وكل العملاء بجواب كل واحد. للدورة المختارة وكل المندوبين.</p>

      {/* تفصيل العملاء */}
      <div className="mb-2 mt-6 flex items-baseline justify-between gap-3">
        <h3 className="m-0 text-base font-bold">{rep ? `عملاء ${repName(rep)}` : 'كل العملاء'}</h3>
        <span className="text-sm text-muted">{customersWord(rows.length)}</span>
      </div>
      {rep ? <Button className="mb-2 w-full" onClick={() => setRep('')}>اعرض عملاء كل المندوبين</Button> : null}
      <Segmented label="تصفية بالجواب" className="mb-2 grid grid-cols-4" value={filter} onChange={(v) => { setFilter(v); setLimit(PAGE); }}
        options={[{ value: '', label: 'الكل' }, { value: 'left', label: `لم يُجب ${count('left')}` }, { value: 'dispute', label: `اعترض ${count('dispute')}` }, { value: 'ok', label: `أقرّ ${count('ok')}` }]} />
      {rows.length ? (
        <ul className={LIST_BOX}>
          {rows.slice(0, limit).map((r) => <AckRow key={r.id} r={r} repName={rep ? '' : repName(r.rep)} />)}
        </ul>
      ) : <p className="m-0 py-4 text-center text-muted">{filter === 'left' ? 'لا أحد دون جواب ✓' : 'لا عملاء بهذه التصفية.'}</p>}
      {rows.length > limit ? <Button className="mt-2 w-full" onClick={() => setLimit(limit + PAGE)}>عرض {customersWord(Math.min(PAGE, rows.length - limit))} آخرين</Button> : null}
    </div>
  );
}

function match(r: Row, f: Filter) {
  if (!f) return true;
  if (f === 'left') return !r.answer;
  return r.answer === f;
}

function AckRow({ r, repName }: { r: Row; repName: string }) {
  const paid = r.remaining != null ? Math.round((r.balance - r.remaining) * 100) / 100 : 0;
  return (
    <li className="ack-row px-3 py-2">
      <div className="flex justify-between gap-3">
        <Ltr className="min-w-0 font-semibold [overflow-wrap:anywhere]">{r.name}</Ltr>
        <Amount value={r.balance} className="flex-none" />
      </div>
      <div className="mt-1 flex flex-wrap justify-between gap-x-3 text-sm">
        <span className="text-muted">
          {repName ? <>{repName} · </> : null}
          {!r.answer ? <span className="font-semibold text-warning">لم يُجب</span>
            : r.answer === 'ok' ? <span>أقرّ</span>
            : <span className="font-semibold text-warning">اعترض</span>}
          {r.at ? <> · <Num>{fmtDateTime(r.at)}</Num></> : null}
        </span>
        {paid > 0 ? <span className="text-muted">حُصّل <bdi dir="ltr" className="num">{fmtAmount(paid)}</bdi></span> : null}
      </div>
      {r.answer === 'dispute' ? (
        <>
          <p className="my-1 text-base [overflow-wrap:anywhere]">{REASON[r.reason || ''] || 'سبب آخر'}{r.note ? ': ' + r.note : '.'}</p>
          <p className="m-0 text-sm text-muted">
            {r.resolved_at ? <>عولج <Num>{fmtDateTime(r.resolved_at).slice(0, 10)}</Num>{r.resolved_by ? ' · ' + r.resolved_by : ''}</> : <span className="font-semibold text-warning">مفتوح</span>}
            {ZOHO[r.zoho] ? <> · {ZOHO[r.zoho]}</> : null}
          </p>
        </>
      ) : null}
    </li>
  );
}
