// أشكال بيانات الخادم (src/modules/cheques.ts وdetail.ts) كما تصل إلى الواجهة
export type Cheque = {
  id: string; number: string; customer: string; amount: number; cheque_number: string; date: string; days: number;
  location: string; status: string; destination: string; account: string; invoices: string;
  has_image?: boolean; lock?: string; deposit_date?: string; deposit_days?: number; v?: string;
};
export type Section = { items: Cheque[]; count: number; total: number };
export type AlertKind = 'rejected' | 'late' | 'collect_late' | 'endorse_incomplete' | 'wrong_account' | 'unknown_lock' | 'box' | 'fiscal';
export type ChequesData = {
  generated_at: string; today: string; can_deposit: boolean;
  rejected: Section; agb_in_hand: Section; rostomia_in_hand: Section; no_destination: Section;
  agb_pending_collection: Section; agb_recent: Section; all: Cheque[];
  alerts: { kind: AlertKind; id: string; text?: string }[];
};
export type Line = { number: string; date: string; balance: number; applied: number };
