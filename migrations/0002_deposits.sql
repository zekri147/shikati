-- سجل الإيداعات، وهو أيضاً القفل ضد الضغط المزدوج:
-- المفتاح الأساسي هو معرّف الدفعة، فلا يمكن أن يبدأ إيداعان لنفس الشيك معاً.
--   pending  قيد التنفيذ الآن
--   done     تم وربط بالدفعة
--   failed   فشل قبل إنشاء أي إيداع في زوهو، أو أُلغي الإيداع، فيمكن إعادة المحاولة
--   unknown  انقطع الرد بعد محاولة الإيداع: يجب التحقق في زوهو قبل أي محاولة جديدة
CREATE TABLE deposits (
  payment_id    TEXT PRIMARY KEY,
  state         TEXT NOT NULL CHECK (state IN ('pending', 'done', 'failed', 'unknown')),
  user_id       INTEGER,
  username      TEXT,
  display_name  TEXT,
  customer      TEXT,
  cheque_number TEXT,
  amount        REAL,
  bank_txn_id   TEXT,
  message       TEXT,
  started_at    TEXT NOT NULL DEFAULT (datetime('now')),
  finished_at   TEXT
);
CREATE INDEX deposits_state ON deposits(state);
CREATE INDEX deposits_started ON deposits(started_at);
