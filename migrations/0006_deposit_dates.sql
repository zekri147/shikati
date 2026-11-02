-- تاريخ إيداع الشيكات المودعة قبل حقل «تاريخ الإيداع» في زوهو (cf_46404d):
-- يُقرأ مرة واحدة من المعاملة البنكية ويُحفظ هنا، فلا يُكتب شيء في زوهو.
CREATE TABLE deposit_dates (
  payment_id   TEXT PRIMARY KEY,
  deposit_date TEXT NOT NULL,
  source       TEXT NOT NULL,
  at           TEXT NOT NULL DEFAULT (datetime('now'))
);
