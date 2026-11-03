// تأكيد البنك للتحصيل: دالة رسائل AGB في زوهو (encaisser_cheque_sms_agb) تكتب في سجل الدفعة (cf_fffaad)
// سطراً بالصيغة «YYYY-MM-DD — تحصيل آلي عبر رسالة AGB». هذا السطر يبقى في السجل حتى لو تغيّرت
// الحالة بعده، فهو الدليل على أن البنك أكّد تحصيل الشيك. نقرؤه من الدفعة نفسها، فلا نحتاج
// صلاحية لقراءة وحدة الرسائل.

const LINE_RE = /^(\d{4}-\d{2}-\d{2})\s*—\s*تحصيل آلي عبر رسالة AGB\s*$/gm;

// تاريخ آخر تأكيد للتحصيل من البنك، أو نص فارغ إن لم يوجد
export function bankCollectedDate(log: unknown): string {
  let last = '';
  for (const m of String(log ?? '').matchAll(LINE_RE)) if (m[1] > last) last = m[1];
  return last;
}

export const showDate = (iso: string) => iso.split('-').reverse().join('/');
