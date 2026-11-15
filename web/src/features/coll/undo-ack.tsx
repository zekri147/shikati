// تراجع المدير عن إقرار مندوب (15/11/2026، بطلب ZEKRI): زر وبطاقة تأكيد، في صفحة العميل وتقرير الإقرار.
// الدورة الحالية وحدها، والإقرار وحده. يعود العميل «لم يُجب» ويعود القفل على المندوب. لا شيء في زوهو.
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { CLOSE_MS, Modal, ModalActions } from '@/components/ui/dialog';
import { FormError } from '@/components/shell';
import { Ltr } from '@/components/ltr';
import { toast } from '@/components/toast';
import { api, errText } from '@/lib/api';

export function AdminUndoAck({ cycle, id, name, rep, onDone, className, small }: {
  cycle: string; id: string; name: string; rep: string; onDone: () => void; className?: string; small?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function run() {
    setBusy(true); setError('');
    try {
      await api('/api/m/coll/ack/undo', { method: 'POST', body: { cycle, customer_id: id } });
      setBusy(false); setOpen(false);
      toast('تراجعت عن إقرار دين ' + name);
      setTimeout(onDone, CLOSE_MS);
    } catch (e) {
      setBusy(false); setError(errText(e));
    }
  }
  return (
    <>
      {small
        ? <Button variant="ghost" className={'ack-admin-undo -me-2 flex-none px-2 font-semibold underline underline-offset-4 ' + (className || '')} onClick={() => { setError(''); setOpen(true); }}>تراجع</Button>
        : <Button className={'ack-admin-undo w-full ' + (className || '')} onClick={() => { setError(''); setOpen(true); }}>تراجع عن إقرار المندوب</Button>}
      <Modal open={open} onClose={() => setOpen(false)} busy={busy} title="تراجع عن الإقرار">
        <p className="mt-0">يعود دين <Ltr className="font-semibold">{name}</Ltr> «لم يُجب» في هذه الدورة، فيُقفل التطبيق على <Ltr>{rep}</Ltr> حتى يقرّ به أو يعترض عليه من جديد.</p>
        <p className="text-sm text-muted">في التطبيق وحده، لا يُكتب شيء في زوهو.</p>
        {error ? <FormError>{error}</FormError> : null}
        <ModalActions>
          <Button variant="primary" disabled={busy} onClick={run}>{busy ? 'جارٍ التراجع…' : 'تراجع عن الإقرار'}</Button>
          <Button disabled={busy} onClick={() => setOpen(false)}>إلغاء</Button>
        </ModalActions>
      </Modal>
    </>
  );
}
