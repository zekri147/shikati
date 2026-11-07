// صفحة الإدارة: المستخدمون، وإضافة مستخدم، ومطابقة الأسبوع، والإيداعات، وسجل العمليات.
import { useCallback, useEffect, useState } from 'react';
import { ChevronDown } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Field, Input, PasswordInput } from '@/components/ui/input';
import { CLOSE_MS, Modal, ModalActions, Sheet } from '@/components/ui/dialog';
import { Segmented } from '@/components/ui/segmented';
import { LIST_BOX } from '@/features/cheques/ui';
import { load, save } from '@/lib/storage';
import { afterOverlay } from '@/lib/back';
import { Amount, Ltr, Num } from '@/components/ltr';
import { ErrorBox, Footer, FormError, Main, Note, TopBar } from '@/components/shell';
import { toast } from '@/components/toast';
import { api, errText, type Me } from '@/lib/api';
import { fmtDateTime } from '@/lib/format';
import { cn } from '@/lib/utils';

// دوران فقط منذ 7/11/2026: كل مستخدم غير المدير مندوب، يرى كل الشيكات ويسجّل ويودع
const ROLE: Record<string, string> = { admin: 'مدير', rep: 'مندوب' };
const ACTION: Record<string, string> = {
  login: 'دخول', 'user.create': 'إنشاء مستخدم', 'user.disable': 'إيقاف مستخدم', 'user.enable': 'تفعيل مستخدم',
  'user.password': 'تغيير رمز سري', 'user.rep': 'تغيير رمز المندوب', 'coll.review': 'مراجعة عميل', 'coll.review.cancel': 'إلغاء مراجعة',
  'coll.comment': 'تعليق مراجعة في زوهو', 'passkey.add': 'تفعيل البصمة', 'passkey.clear': 'حذف البصمة', 'coll.comment.resolve': 'حسم تعليق مراجعة', setup: 'الإعداد الأولي',
  deposit: 'إيداع شيك', 'deposit.release': 'تحرير إيداع', 'deposit.reverted': 'إيداع أُلغي في زوهو',
};
const RESULT: Record<string, string> = { ok: 'تمّ', denied: 'مرفوض', error: 'خطأ' };
const DEP_STATE: Record<string, string> = { pending: 'قيد التنفيذ', done: 'تم', failed: 'لم يتم', unknown: 'بانتظار التحقق' };

type Ask = { title: string; text: string; okText: string; danger?: boolean; password?: boolean; field?: { label: string; value: string; placeholder: string }; run: (v?: string) => Promise<void> };

// بطاقة تأكيد بدل نوافذ المتصفح. مع password يطلب رمزاً سرياً في حقل مخفي، ومع field نصاً قصيراً.
function AskDialog({ a, onClose }: { a: Ask; onClose: () => void }) {
  const [v, setV] = useState(a.field ? a.field.value : '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [open, setOpen] = useState(true);
  const finish = () => { setOpen(false); setTimeout(onClose, CLOSE_MS); };
  async function ok() {
    if (a.password && v.length < 8) { setError('الرمز السري 8 أحرف على الأقل.'); return; }
    setBusy(true);
    try { await a.run(a.password || a.field ? v : undefined); setBusy(false); finish(); }
    catch (e) { setBusy(false); setError(errText(e)); }
  }
  return (
    <Modal open={open} onClose={finish} busy={busy} title={a.title}>
      <p>{a.text}</p>
      {a.password || a.field ? (
        <Field label={a.field ? a.field.label : 'الرمز السري الجديد (8 أحرف على الأقل)'}>
          <Input autoFocus type={a.password ? 'password' : 'text'} dir="ltr" autoComplete={a.password ? 'new-password' : 'off'}
            autoCapitalize={a.field ? 'characters' : undefined} spellCheck={false} placeholder={a.field?.placeholder} value={v} onChange={(e) => setV(e.target.value)} />
        </Field>
      ) : null}
      {error ? <FormError>{error}</FormError> : null}
      <ModalActions>
        <Button variant={a.danger ? 'danger' : 'primary'} disabled={busy} onClick={ok}>{a.okText}</Button>
        <Button disabled={busy} onClick={finish} autoFocus={!a.password && !a.field}>إلغاء</Button>
      </ModalActions>
    </Modal>
  );
}

function Section({ title, meta, children, className }: { title: string; meta?: string; children: React.ReactNode; className?: string }) {
  return (
    <section className={cn('mt-4 border border-line bg-surface px-4 pb-4 pt-1', className)}>
      <div className="mb-3 flex items-center justify-between gap-3 border-b border-line pb-2 pt-2">
        <h2 className="m-0 text-lg font-bold">{title}</h2>{meta ? <span className="text-sm text-muted">{meta}</span> : null}
      </div>
      {children}
    </section>
  );
}

function Table({ head, children, empty, cols }: { head: string[]; children: React.ReactNode; empty?: string | null; cols: number }) {
  return (
    <div className="-mx-4 overflow-x-auto">
      <table className="w-full border-collapse text-base">
        <thead><tr>{head.map((h, i) => <th key={i} className="whitespace-nowrap border-b-2 border-line-strong bg-surface-alt px-2 py-2 text-start text-sm font-semibold text-muted">{h}</th>)}</tr></thead>
        <tbody className="[&>tr:nth-child(even)>td]:bg-surface-alt [&_td]:border-b [&_td]:border-line [&_td]:px-2 [&_td]:py-2 [&_td]:align-top">
          {empty ? <tr><td colSpan={cols} className="!bg-transparent py-4 text-center text-muted">{empty}</td></tr> : children}
        </tbody>
      </table>
    </div>
  );
}

const TAB_KEY = 'shikati-admin-tab';

// إجراءات المستخدم في اللوحة السفلية: الرمز السري، ورمز المندوب، ثم الإيقاف أو التفعيل في آخرها.
// لا إيقاف لحسابك أنت: الخادم يرفضه، فلا يظهر.
function UserActions({ u, self, setAsk, refresh }: { u: any; self: boolean; setAsk: (a: Ask) => void; refresh: () => Promise<void> }) {
  const post = (path: string, body?: object) => api(`/api/admin/users/${u.id}/${path}`, { method: 'POST', body: body || {} });
  return (
    <div className="flex flex-col gap-2 px-4 pb-2">
      <p className="m-0 text-sm text-muted"><Ltr>{u.username}</Ltr> · {ROLE[u.role] || u.role} · {u.active ? 'نشط' : 'موقوف'}{u.passkeys ? ' · البصمة مفعّلة' : ''}</p>
      <Button onClick={() => setAsk({ title: 'رمز سري جديد لـ ' + u.display_name, text: 'أعطه الرمز الجديد بنفسك، لا في رسالة مكتوبة.', okText: 'حفظ الرمز', password: true,
        run: async (p) => { await post('password', { password: p }); toast('حُفظ الرمز السري الجديد'); await refresh(); } })}>رمز سري جديد</Button>
      {/* رمز المندوب: يربط المستخدم بعملائه في زوهو (حقل «Owner») فيرى تحصيلهم */}
      <Button onClick={() => setAsk({ title: 'رمز المندوب لـ ' + u.display_name,
        text: u.role === 'rep' ? 'اكتبه كما في حقل «Owner» على العميل في زوهو. يرى المندوب في التحصيل عملاء هذا الرمز فقط.' : 'اكتبه كما في حقل «Owner» في زوهو ليرى قسم التحصيل لعملائه. اتركه فارغاً لإزالته.',
        okText: 'حفظ الرمز', field: { label: 'رمز المندوب', value: u.rep_code || '', placeholder: 'AMINE' },
        run: async (code) => { await post('rep', { rep_code: code }); toast('حُفظ رمز المندوب'); await refresh(); } })}>رمز المندوب{u.rep_code ? <> (<Ltr>{u.rep_code}</Ltr>)</> : null}</Button>
      {/* حذف أجهزة البصمة: لهاتف ضاع أو تغيّر. يبقى الدخول بالرمز السري */}
      {u.passkeys ? (
        <Button onClick={() => setAsk({ title: 'حذف البصمة لـ ' + u.display_name, okText: 'احذف البصمة', danger: true,
          text: `سيُحذف الدخول بالبصمة من ${u.passkeys === 1 ? 'جهازه' : 'أجهزته (' + u.passkeys + ')'}. يبقى دخوله بالاسم والرمز السري، ويمكنه تفعيل البصمة من جديد.`,
          run: async () => { await post('passkeys'); toast('حُذفت البصمة'); await refresh(); } })}>حذف البصمة ({u.passkeys})</Button>
      ) : null}
      {self ? null : u.active ? (
        <Button variant="danger" className="mt-4" onClick={() => setAsk({ title: 'إيقاف ' + u.display_name, text: 'سيُخرج من التطبيق فوراً، ولن يستطيع الدخول حتى تعيد تفعيله.', okText: 'إيقاف', danger: true,
          run: async () => { await post('disable'); toast('أُوقف ' + u.display_name); await refresh(); } })}>إيقاف الحساب</Button>
      ) : (
        <Button className="mt-4" onClick={async () => { try { await post('enable'); toast('فُعّل ' + u.display_name); await refresh(); } catch (e) { toast(errText(e), 'err'); } }}>تفعيل الحساب</Button>
      )}
    </div>
  );
}

export function AdminPage() {
  const [me, setMe] = useState<Me | null>(null);
  const [users, setUsers] = useState<any[] | null>(null);
  const [deposits, setDeposits] = useState<any[] | null>(null);
  const [audit, setAudit] = useState<any[] | null>(null);
  const [ask, setAsk] = useState<Ask | null>(null);
  const [tab, setTab] = useState(() => load(TAB_KEY) || 'users');
  const [userSheet, setUserSheet] = useState<any | null>(null);
  const [adding, setAdding] = useState(false);
  const [nu, setNu] = useState({ display_name: '', username: '', role: 'rep', rep_code: '', password: '' });
  const [nuError, setNuError] = useState('');
  const [rec, setRec] = useState<any>(null);
  const [recBusy, setRecBusy] = useState(false);
  const [recError, setRecError] = useState('');

  const refresh = useCallback(async () => {
    try {
      const [u, d, a] = await Promise.all([api('/api/admin/users'), api('/api/admin/deposits'), api('/api/admin/audit')]);
      setUsers(u.users); setDeposits(d.deposits); setAudit(a.entries);
    } catch (e) { toast(errText(e), 'err'); }
  }, []);
  useEffect(() => { api<Me>('/api/me').then(setMe).catch(() => {}); refresh(); }, [refresh]);

  async function addUser(e: React.FormEvent) {
    e.preventDefault();
    setNuError('');
    try {
      await api('/api/admin/users', { method: 'POST', body: { ...nu, display_name: nu.display_name.trim(), username: nu.username.trim(), rep_code: nu.rep_code.trim() } });
      setNu({ display_name: '', username: '', role: 'rep', rep_code: '', password: '' });
      toast('أُضيف المستخدم');
      setAdding(false);
      await refresh();
    } catch (ex) { setNuError(errText(ex)); }
  }

  async function runReconcile() {
    setRecBusy(true); setRecError('');
    try { setRec(await api('/api/admin/reconcile')); } catch (e) { setRecError(errText(e)); } finally { setRecBusy(false); }
  }
  const fmtIso = (iso: string) => {
    const t = new Date(String(iso || '').replace(/([+-]\d{2})(\d{2})$/, '$1:$2'));
    return Number.isNaN(t.getTime()) ? '—' : fmtDateTime(t.toISOString().slice(0, 19).replace('T', ' '));
  };

  const attention = (deposits || []).some((d) => (d.stale ? 'unknown' : d.state) === 'unknown');

  return (
    <>
      <TopBar name={me?.user.display_name} links={[{ href: '/', label: 'التطبيق' }, { href: '/help', label: 'المساعدة وطريقة الاستعمال' }]} />
      <Main>
        <h1 className="m-0 text-2xl font-bold">الإدارة</h1>
        {/* تبويبات بدل صفحة طويلة: يفتح المدير ما يريده مباشرة، وتنبيه الإيداعات المعلّقة على تبويبها */}
        <Segmented label="أقسام الإدارة" className="mt-3" value={tab} onChange={(v) => { setTab(v); save(TAB_KEY, v); }}
          options={[{ value: 'users', label: 'المستخدمون' }, { value: 'deposits', label: attention ? '⚠ الإيداعات' : 'الإيداعات' }, { value: 'audit', label: 'السجل' }, { value: 'reconcile', label: 'المطابقة' }]} />

        {tab === 'users' ? <Section title="المستخدمون">
          {!users ? <p className="text-muted">جارٍ التحميل…</p> : (
            <ul className={LIST_BOX}>
              {users.map((u) => (
                // لمس المستخدم يفتح إجراءاته في لوحة سفلية: الصف يبقى سطرين هادئين
                <li key={u.id}>
                  <button type="button" className="user-row flex min-h-[60px] w-full items-center justify-between gap-3 bg-surface px-3 py-2 text-start active:bg-surface-alt" onClick={() => setUserSheet(u)}>
                    <span className="min-w-0">
                      <span className={cn('block font-semibold', !u.active && 'text-muted')}>{u.display_name}</span>
                      <span className="flex flex-wrap items-center gap-x-1 text-sm text-muted">
                        <Ltr>{u.username}</Ltr><span aria-hidden>·</span><span>{u.active ? 'نشط' : 'موقوف'}</span>
                        {u.rep_code ? <><span aria-hidden>·</span><span>الرمز <Ltr>{u.rep_code}</Ltr></span></> : u.role === 'rep' ? <><span aria-hidden>·</span><span className="text-warning">بلا رمز، فلا يرى التحصيل</span></> : null}
                      </span>
                    </span>
                    <Badge tone={u.active ? 'neutral' : 'warn'}>{ROLE[u.role] || u.role}</Badge>
                  </button>
                </li>
              ))}
            </ul>
          )}
          <Button variant="primary" size="lg" className="mt-4" onClick={() => { setNuError(''); setAdding(true); }}>إضافة مستخدم</Button>
        </Section> : null}

        {tab === 'reconcile' ? <Section title="مطابقة الأسبوع" meta="آخر 7 أيام">
          <p className="mt-0 text-sm text-muted">تقرأ من زوهو فقط ولا تغيّر شيئاً. شغّلها مرة كل يوم خلال أسبوع التشغيل المتوازي.</p>
          <Button size="lg" disabled={recBusy} onClick={runReconcile}>{recBusy ? 'جارٍ المطابقة…' : 'تشغيل المطابقة'}</Button>
          {recError ? <ErrorBox>{recError}</ErrorBox> : null}
          {rec ? (
            <div>
              <h3 className="mb-2 mt-4 text-base">إيداعات سجّلها التطبيق: {rec.app.count}، منها للمراجعة: {rec.app.problems}</h3>
              {rec.app.count ? (
                <Table cols={6} head={['النتيجة', 'العميل', 'الشيك', 'المبلغ', 'الموظف', 'الوقت']}>
                  {rec.app.items.map((d: any, i: number) => (
                    <tr key={i}>
                      <td className={d.ok ? '' : 'font-semibold'}>{d.ok ? 'سليم' : 'للمراجعة: ' + d.problem}</td>
                      <td>{d.customer || '—'}</td><td>{d.cheque_number ? <Num>{d.cheque_number}</Num> : '—'}</td>
                      <td className="whitespace-nowrap">{d.amount != null ? <Amount value={d.amount} /> : '—'}</td>
                      <td>{d.display_name || '—'}</td><td className="whitespace-nowrap"><Num>{fmtDateTime(d.finished_at || '')}</Num></td>
                    </tr>
                  ))}
                </Table>
              ) : <p className="text-muted">لا إيداعات من التطبيق في آخر 7 أيام.</p>}
              <h3 className="mb-2 mt-4 text-base">شيكات AGB مودعة من خارج التطبيق: {rec.outside.count}</h3>
              <p className="text-sm text-muted">من القسم القديم أو يدوياً في زوهو. التاريخ هو آخر تعديل للدفعة، وهو تقريبي.</p>
              {rec.outside.count ? (
                <Table cols={5} head={['العميل', 'الشيك', 'المبلغ', 'الحالة', 'آخر تعديل']}>
                  {rec.outside.items.map((d: any, i: number) => (
                    <tr key={i}><td>{d.customer}</td><td>{d.cheque_number ? <Num>{d.cheque_number}</Num> : '—'}</td>
                      <td className="whitespace-nowrap"><Amount value={d.amount} /></td><td>{d.status}</td><td className="whitespace-nowrap"><Num>{fmtIso(d.modified)}</Num></td></tr>
                  ))}
                </Table>
              ) : <p className="text-muted">لا شيء.</p>}
            </div>
          ) : null}
        </Section> : null}

        {tab === 'deposits' ? <Section title="الإيداعات" meta="آخر 100 محاولة">
          {attention ? <Note tone="warn" className="mb-3">إيداعات «بانتظار التحقق»: افتح الدفعة في زوهو وتأكد هل أُنشئ إيداعها، ثم اضغط «تحرير» فقط إن لم يُنشأ أو بعد تصحيحه يدوياً.</Note> : null}
          <Table cols={8} head={['الوقت', 'الموظف', 'العميل', 'الشيك', 'المبلغ', 'الحالة', 'الرسالة', '']} empty={!deposits ? 'جارٍ التحميل…' : deposits.length ? null : 'لا محاولات إيداع بعد.'}>
            {(deposits || []).map((d, i) => {
              const state = d.stale ? 'unknown' : d.state;
              return (
                <tr key={i}>
                  <td className="whitespace-nowrap"><Num>{fmtDateTime(d.started_at)}</Num></td><td>{d.display_name || '—'}</td><td>{d.customer || '—'}</td>
                  <td>{d.cheque_number ? <Num>{d.cheque_number}</Num> : '—'}</td>
                  <td className="whitespace-nowrap">{d.amount != null ? <Amount value={d.amount} /> : '—'}</td>
                  <td className="whitespace-nowrap">{DEP_STATE[state] || state}</td><td>{d.message || ''}</td>
                  <td>{state === 'unknown' ? (
                    <Button variant="danger" size="sm" onClick={() => setAsk({ title: 'تحرير قفل الإيداع', danger: true, okText: 'تحرير القفل',
                      text: 'هل تحققت في زوهو أن الإيداع لم يُنشأ، أو صحّحته يدوياً؟ التحرير يسمح بمحاولة إيداع جديدة لهذا الشيك.',
                      run: async () => { await api(`/api/admin/deposits/${d.payment_id}/release`, { method: 'POST', body: {} }); toast('حُرّر القفل'); await refresh(); } })}>تحرير</Button>
                  ) : null}</td>
                </tr>
              );
            })}
          </Table>
        </Section> : null}

        {tab === 'audit' ? <Section title="سجل العمليات" meta="آخر 200 عملية">
          <Table cols={5} head={['الوقت', 'المستخدم', 'العملية', 'الهدف', 'النتيجة']} empty={!audit ? 'جارٍ التحميل…' : audit.length ? null : 'لا عمليات مسجّلة بعد.'}>
            {(audit || []).map((a, i) => (
              <tr key={i}>
                <td className="whitespace-nowrap"><Num>{fmtDateTime(a.at)}</Num></td>
                <td>{a.username ? <Ltr>{a.username}</Ltr> : <span className="text-muted">—</span>}</td>
                <td>{ACTION[a.action] || a.action}</td><td>{a.target ? <Ltr>{a.target}</Ltr> : ''}</td><td>{RESULT[a.result] || a.result}</td>
              </tr>
            ))}
          </Table>
        </Section> : null}
      </Main>
      <Footer />
      <Sheet open={!!userSheet} onClose={() => setUserSheet(null)} title={userSheet ? userSheet.display_name : ''} action={<Button onClick={() => setUserSheet(null)}>إغلاق</Button>}>
        {userSheet ? <UserActions u={userSheet} self={userSheet.username === me?.user.username} setAsk={(a) => { setUserSheet(null); afterOverlay(() => setAsk(a)); }} refresh={refresh} /> : null}
      </Sheet>
      <Modal open={adding} onClose={() => setAdding(false)} title="إضافة مستخدم">
          <form onSubmit={addUser} noValidate>
            <div className="grid grid-cols-1 gap-x-3 sm:grid-cols-2">
              <Field label="الاسم الظاهر"><Input value={nu.display_name} onChange={(e) => setNu({ ...nu, display_name: e.target.value })} /></Field>
              <Field label="اسم الدخول"><Input dir="ltr" autoCapitalize="none" spellCheck={false} value={nu.username} onChange={(e) => setNu({ ...nu, username: e.target.value })} /></Field>
              <Field label="الدور">
                <span className="relative block">
                  <select className="block min-h-11 w-full appearance-none border border-line-strong bg-surface pe-9 ps-3 py-2 text-foreground" value={nu.role} onChange={(e) => setNu({ ...nu, role: e.target.value })}>
                    <option value="rep">مندوب</option><option value="admin">مدير</option>
                  </select>
                  <ChevronDown aria-hidden className="pointer-events-none absolute end-3 top-1/2 size-4.5 -translate-y-1/2 text-muted" />
                </span>
              </Field>
              <Field label="رمز المندوب (كما في حقل «Owner» في زوهو)"><Input dir="ltr" autoCapitalize="characters" spellCheck={false} placeholder="AMINE" value={nu.rep_code} onChange={(e) => setNu({ ...nu, rep_code: e.target.value })} /></Field>
              <Field label="الرمز السري (8 أحرف على الأقل)"><PasswordInput autoComplete="new-password" dir="ltr" value={nu.password} onChange={(e) => setNu({ ...nu, password: e.target.value })} /></Field>
            </div>
            <FormError>{nuError}</FormError>
            <ModalActions><Button type="submit" variant="primary">إضافة المستخدم</Button><Button onClick={() => setAdding(false)}>إلغاء</Button></ModalActions>
          </form>
      </Modal>
      {ask ? <AskDialog a={ask} onClose={() => setAsk(null)} /> : null}
    </>
  );
}
