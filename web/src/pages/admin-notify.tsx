// تبويب «الإشعارات» في صفحة الإدارة (8/11/2026، بطلب ZEKRI): تشغيل كل نوع وإيقافه، والمواعيد،
// وأيام التأخر، وإشعار يدوي للمندوبين مع سجله. الإعدادات للجميع معاً، والخادم في src/notifysettings.ts.
import { useCallback, useEffect, useState } from 'react';
import { ChevronDown } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Field, Textarea } from '@/components/ui/input';
import { Modal, ModalActions } from '@/components/ui/dialog';
import { Segmented, ToggleChips } from '@/components/ui/segmented';
import { Block } from '@/features/cheques/pickers';
import { FormError, Note } from '@/components/shell';
import { Num } from '@/components/ltr';
import { toast } from '@/components/toast';
import { api, errText } from '@/lib/api';
import { fmtDateTime } from '@/lib/format';

type Settings = {
  handover: boolean; rejected: boolean; late: boolean; review: boolean; admin_daily: boolean;
  morning_hour: number; review_hour: number; review_days: number[]; late_days: number;
};
type Person = { id: number; display_name: string; role: string; devices: number };
type LogRow = { id: number; at: string; body: string; devices: number; to_id: number | null; to_name: string | null; by_name: string | null };

const TYPES: { key: keyof Settings; title: string; desc: string }[] = [
  { key: 'handover', title: 'شيك سُلّم إليك', desc: 'فوراً للمستلم، ولمن سلّمه إن رُفض الاستلام.' },
  { key: 'rejected', title: 'شيك مرفوض', desc: 'للمدير، ولمندوب العميل، ولمن سجّله، ولمن كان في عهدته.' },
  { key: 'late', title: 'شيكات تأخر إيداعها', desc: 'كل صباح لمن هي في عهدته.' },
  { key: 'review', title: 'تذكير المراجعة الأسبوعية', desc: 'مرة في اليوم حتى يكملها المندوب.' },
  { key: 'admin_daily', title: 'ملخص تنبيهات اليوم', desc: 'كل صباح للمدير.' },
];
// أيام الأسبوع بالترتيب الذي يبدأ به أسبوع المراجعة (السبت). القيمة رقم اليوم: 0 الأحد ... 6 السبت
const DAYS = [['6', 'السبت'], ['0', 'الأحد'], ['1', 'الإثنين'], ['2', 'الثلاثاء'], ['3', 'الأربعاء'], ['4', 'الخميس'], ['5', 'الجمعة']] as const;
const HOURS = Array.from({ length: 14 }, (_, i) => i + 7);
const LATE = [3, 4, 5, 6, 7, 8, 10, 12, 14, 21, 30];
const BODY_MAX = 200;

const dayCount = (n: number) => (n === 1 ? 'يوم واحد' : n === 2 ? 'يومين' : n <= 10 ? `${n} أيام` : `${n} يوماً`);
const deviceCount = (n: number) => (n === 0 ? 'لا أجهزة مفعّلة' : n === 1 ? 'جهاز واحد' : n === 2 ? 'جهازان' : `${n} ${n <= 10 ? 'أجهزة' : 'جهازاً'}`);
const devicesText = (n: number) => (n === 0 ? 'لم يصل إلى أي جهاز' : n === 1 ? 'وصل إلى جهاز واحد' : n === 2 ? 'وصل إلى جهازين' : `وصل إلى ${n} ${n <= 10 ? 'أجهزة' : 'جهازاً'}`);

function Select({ value, onChange, children, label }: { value: string; onChange: (v: string) => void; children: React.ReactNode; label: string }) {
  return (
    <span className="relative block">
      <select aria-label={label} className="block min-h-11 w-full appearance-none border border-line-strong bg-surface pe-9 ps-3 py-2 text-foreground" value={value} onChange={(e) => onChange(e.target.value)}>
        {children}
      </select>
      <ChevronDown aria-hidden className="pointer-events-none absolute end-3 top-1/2 size-4.5 -translate-y-1/2 text-muted" />
    </span>
  );
}

export function NotifyTab() {
  const [saved, setSaved] = useState<Settings | null>(null);
  const [s, setS] = useState<Settings | null>(null);
  const [people, setPeople] = useState<Person[]>([]);
  const [selfId, setSelfId] = useState(0);
  const [log, setLog] = useState<LogRow[]>([]);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const [to, setTo] = useState('all');
  const [body, setBody] = useState('');
  const [confirm, setConfirm] = useState(false);
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState('');

  const load = useCallback(async () => {
    try {
      const r = await api<{ settings: Settings; people: Person[]; log: LogRow[]; self_id: number }>('/api/admin/notify');
      setSelfId(r.self_id); setSaved(r.settings); setS((old) => old || r.settings); setPeople(r.people); setLog(r.log);
    } catch (e) { setError(errText(e)); }
  }, []);
  useEffect(() => { load(); }, [load]);

  if (error) return <p className="text-danger">{error}</p>;
  if (!s || !saved) return <p className="text-muted">جارٍ التحميل…</p>;

  const dirty = JSON.stringify(s) !== JSON.stringify(saved);
  const set = <K extends keyof Settings>(k: K, v: Settings[K]) => setS({ ...s, [k]: v });
  // «الجميع» لا يشمل المدير الذي يرسل (الخادم يستثنيه)
  const allDevices = people.filter((p) => p.id !== selfId).reduce((n, p) => n + p.devices, 0);
  const target = to === 'all' ? null : people.find((p) => String(p.id) === to);
  const toName = target ? target.display_name : 'الجميع';

  async function save() {
    if (!dirty) { toast('لا تغيير للحفظ.', 'warn'); return; }
    setSaving(true);
    try {
      const r = await api<{ settings: Settings }>('/api/admin/notify/settings', { method: 'POST', body: s });
      setSaved(r.settings); setS(r.settings);
      toast('حُفظت إعدادات الإشعارات');
    } catch (e) { toast(errText(e), 'err'); } finally { setSaving(false); }
  }

  async function send() {
    setSending(true); setSendError('');
    try {
      const r = await api<{ devices: number }>('/api/admin/notify/send', { method: 'POST', body: { to: to === 'all' ? 'all' : Number(to), body } });
      setConfirm(false); setBody('');
      toast(r.devices ? 'أُرسل الإشعار، و' + devicesText(r.devices) : 'سُجّل الإشعار، لكنه لم يصل إلى أي جهاز.', r.devices ? undefined : 'warn');
      await load();
    } catch (e) { setSendError(errText(e)); } finally { setSending(false); }
  }

  return (
    <div className="flex flex-col gap-6">
      <Block title="ما يُرسل">
        <ul className="m-0 list-none p-0">
          {TYPES.map((t) => (
            <li key={t.key} className="flex items-center justify-between gap-3 border-line py-3 [&:not(:first-child)]:border-t">
              <span className="min-w-0">
                <span className="block font-semibold">{t.title}</span>
                <span className="block text-sm text-muted">{t.desc}</span>
              </span>
              <Segmented label={t.title} className="w-[168px] flex-none" value={s[t.key] ? 'on' : 'off'} onChange={(v) => set(t.key, (v === 'on') as never)}
                options={[{ value: 'on', label: 'يعمل' }, { value: 'off', label: 'متوقف' }]} />
            </li>
          ))}
        </ul>
      </Block>

      <Block title="المواعيد والتأخر">
        <Field label="ساعة ملخص الصباح وتأخر الإيداع">
          <Select label="ساعة ملخص الصباح" value={String(s.morning_hour)} onChange={(v) => set('morning_hour', Number(v))}>
            {HOURS.map((h) => <option key={h} value={h}>{h}:00</option>)}
          </Select>
        </Field>
        <Field label="يُعدّ الشيك متأخراً بعد">
          <Select label="أيام التأخر" value={String(s.late_days)} onChange={(v) => set('late_days', Number(v))}>
            {[...new Set([...LATE, s.late_days])].sort((a, b) => a - b).map((d) => <option key={d} value={d}>{dayCount(d)} في الحوزة</option>)}
          </Select>
        </Field>
        <Field label="ساعة تذكير المراجعة">
          <Select label="ساعة تذكير المراجعة" value={String(s.review_hour)} onChange={(v) => set('review_hour', Number(v))}>
            {HOURS.map((h) => <option key={h} value={h}>{h}:00</option>)}
          </Select>
        </Field>
        <div className="mb-3">
          <span className="mb-2 block text-sm font-semibold">أيام تذكير المراجعة</span>
          <ToggleChips label="أيام تذكير المراجعة" value={s.review_days.map(String)} onChange={(v) => set('review_days', v.map(Number))}
            options={DAYS.map(([value, label]) => ({ value, label }))} />
        </div>
      </Block>
      <Note>تنطبق على كل المستخدمين، وتبدأ من الفحص التالي (كل ساعة من 7:00 إلى 20:00). أيام التأخر هنا للإشعار وحده، وشاشة التنبيهات تبقى على 7 أيام.</Note>
      <Button variant="primary" size="lg" disabled={saving} blocked={!dirty} onClick={save}>{saving ? 'جارٍ الحفظ…' : 'احفظ الإعدادات'}</Button>

      <Block title="إشعار يدوي">
        <Field label="إلى">
          <Select label="المستلم" value={to} onChange={setTo}>
            <option value="all">الجميع ({deviceCount(allDevices)})</option>
            {people.map((p) => <option key={p.id} value={p.id}>{p.display_name}{p.devices ? '' : ' — لم يفعّل الإشعارات'}</option>)}
          </Select>
        </Field>
        <Field label="النص" hint={<><Num>{body.length}</Num> من <Num>{BODY_MAX}</Num> حرفاً</>}>
          <Textarea rows={3} maxLength={BODY_MAX} placeholder="مثال: اجتماع المندوبين غداً الساعة 9:00 في المكتب." value={body} onChange={(e) => setBody(e.target.value)} />
        </Field>
        <Button className="mb-3 w-full" blocked={!body.trim()} onClick={() => { if (!body.trim()) { toast('اكتب نص الإشعار أولاً.', 'warn'); return; } setSendError(''); setConfirm(true); }}>أرسل الإشعار</Button>
      </Block>

      <Block title="آخر الإشعارات اليدوية">
        {log.length ? (
          <ul className="m-0 list-none p-0">
            {log.map((m) => (
              <li key={m.id} className="border-line py-3 [&:not(:first-child)]:border-t">
                <p className="m-0 [overflow-wrap:anywhere]">{m.body}</p>
                <p className="m-0 mt-1 text-sm text-muted">إلى {m.to_id ? m.to_name || 'مستخدم محذوف' : 'الجميع'} · <Num>{fmtDateTime(m.at)}</Num> · {devicesText(m.devices)}</p>
              </li>
            ))}
          </ul>
        ) : <p className="my-2 text-muted">لم تُرسل إشعارات يدوية بعد.</p>}
      </Block>

      <Modal open={confirm} onClose={() => setConfirm(false)} busy={sending} title="إرسال إشعار">
        <p>سيصل هذا الإشعار إلى {toName === 'الجميع' ? 'كل المستخدمين الذين فعّلوا الإشعارات' : toName}، ولا يمكن سحبه بعد الإرسال:</p>
        <Note className="[white-space:pre-wrap]">{body.trim()}</Note>
        {target && !target.devices ? <Note tone="warn" className="mt-2">{target.display_name} لم يفعّل الإشعارات، فلن يصله شيء.</Note> : null}
        <FormError>{sendError}</FormError>
        <ModalActions>
          <Button variant="primary" disabled={sending} onClick={send}>{sending ? 'جارٍ الإرسال…' : 'أرسل الآن'}</Button>
          <Button disabled={sending} onClick={() => setConfirm(false)}>إلغاء</Button>
        </ModalActions>
      </Modal>
    </div>
  );
}
