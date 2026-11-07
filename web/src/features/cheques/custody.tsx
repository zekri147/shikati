// العهدة: من يحمل الشيك فعلياً (المرحلة الثانية من خطة التحصيل، 7/11/2026).
// في قاعدة التطبيق وحدها، فلا بطاقة تأكيد قبلها: كل خطوة تُلغى أو تُعاد من الصفحة نفسها.
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Sheet, SheetOption } from '@/components/ui/dialog';
import { Note } from '@/components/shell';
import { toast } from '@/components/toast';
import { api, errText } from '@/lib/api';
import { haptic } from '@/lib/motion';
import { Block } from './pickers';
import type { Custody } from './types';

export type CustodyDetail = Custody & { since: string | null; actions: ('take' | 'give' | 'accept' | 'refuse' | 'cancel')[] };

// نص العهدة القصير في بطاقة الشيك: «عندك» أو «عند أمين»، أو التسليم المعلّق
export function custodyShort(k?: Custody): string | null {
  if (!k) return null;
  if (k.incoming) return 'سُلّم إليك';
  if (k.to) return 'بانتظار ' + k.to;
  if (k.mine) return 'عندك';
  return k.holder ? 'عند ' + k.holder : null;
}

// تصفية شاشة الإيداع بالعهدة
export const CUSTODY_FILTERS: [string, string][] = [['', 'كل العهد'], ['mine', 'في عهدتي'], ['others', 'عند غيري'], ['none', 'غير محددة']];
export function byCustody(k: Custody | undefined, f: string): boolean {
  if (!f) return true;
  if (f === 'mine') return !!k && (k.mine || k.incoming);
  if (f === 'others') return !!k && !!k.holder && !k.mine && !k.incoming;
  return !k || (!k.holder && !k.to);
}

type Person = { id: number; display_name: string; role: string };

export function CustodyBlock({ id, k, onChanged }: { id: string; k: CustodyDetail; onChanged: () => void }) {
  const [busy, setBusy] = useState(false);
  const [people, setPeople] = useState<Person[] | null>(null);
  const [picking, setPicking] = useState(false);

  async function act(action: string, to?: number) {
    setBusy(true);
    try {
      const r = await api('/api/m/cheques/custody', { method: 'POST', body: { payment_id: id, action, to } });
      haptic('success');
      toast(r.message);
      onChanged();
    } catch (e) {
      toast(errText(e), 'err');
    } finally {
      setBusy(false);
    }
  }

  async function openPicker() {
    setPicking(true);
    if (people) return;
    try { setPeople((await api('/api/m/cheques/custody/people')).people); } catch (e) { setPicking(false); toast(errText(e), 'err'); }
  }

  const has = (a: CustodyDetail['actions'][number]) => k.actions.includes(a);
  const who = k.mine ? 'في عهدتك' : k.holder ? 'في عهدة ' + k.holder : 'العهدة غير محددة';
  return (
    <Block title="العهدة: من يحمل الشيك">
      <p className="m-0 py-1 text-base font-semibold">{who}</p>
      {!k.holder && !k.to ? <p className="m-0 text-sm text-muted">سُجّل قبل العهدة أو من خارج التطبيق. إن كان الشيك معك، اضغط «هو في عهدتي».</p> : null}
      {k.incoming ? <Note tone="warn" className="mt-1">سلّمه إليك {k.from || 'زميل'}. أكّد استلامه إن كان في يدك، أو ارفضه.</Note>
        : k.to ? <Note className="mt-1">سلّمه {k.from || '—'} إلى {k.to}، وينتظر تأكيد الاستلام.</Note> : null}
      {k.actions.length ? (
        <div className="mt-2 flex flex-wrap gap-2 pb-2 [&>button]:flex-1">
          {has('accept') ? <Button className="py-2" disabled={busy} onClick={() => act('accept')}>{busy ? 'جارٍ الحفظ…' : 'استلمت الشيك'}</Button> : null}
          {has('refuse') ? <Button className="py-2" disabled={busy} onClick={() => act('refuse')}>ليس معي</Button> : null}
          {has('give') ? <Button className="py-2" disabled={busy} onClick={openPicker}>سلّمته إلى…</Button> : null}
          {has('take') ? <Button className="py-2" disabled={busy} onClick={() => act('take')}>{busy ? 'جارٍ الحفظ…' : 'هو في عهدتي'}</Button> : null}
          {has('cancel') ? <Button className="py-2" disabled={busy} onClick={() => act('cancel')}>ألغِ التسليم</Button> : null}
        </div>
      ) : null}
      <Sheet open={picking} onClose={() => setPicking(false)} title="سلّمت الشيك إلى" action={<Button onClick={() => setPicking(false)}>إغلاق</Button>}>
        {people ? people.length ? people.map((p) => (
          <SheetOption key={p.id} selected={false} label={p.display_name} meta={p.role === 'admin' ? 'المدير' : 'مندوب'}
            onClick={() => { setPicking(false); act('give', p.id); }} />
        )) : <p className="px-4 py-2 text-sm text-muted">لا يوجد مستخدم آخر نشط.</p>
          : <p className="px-4 py-2 text-sm text-muted">جارٍ التحميل…</p>}
        <p className="m-0 px-4 py-2 text-sm text-muted">يبقى الشيك في عهدتك حتى يؤكد المستلم أنه استلمه.</p>
      </Sheet>
    </Block>
  );
}
