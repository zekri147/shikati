-- سجل التظهير لمورد من التطبيق، وهو أيضاً القفل: لكل دفعة عميل تظهير واحد فقط ما لم يفشل.
--   pending  قيد التنفيذ   done  أُنشئت دفعة المورد   failed  لم تُنشأ، فيمكن المحاولة
--   unknown  انقطع الرد بعد إرسال دفعة المورد: يجب التحقق في زوهو قبل أي محاولة جديدة
CREATE TABLE endorsements (
  payment_id        TEXT PRIMARY KEY,
  state             TEXT NOT NULL CHECK (state IN ('pending', 'done', 'failed', 'unknown')),
  user_id           INTEGER,
  username          TEXT,
  display_name      TEXT,
  vendor_id         TEXT NOT NULL,
  vendor            TEXT,
  cheque_number     TEXT,
  amount            REAL,
  vendor_payment_id TEXT,
  message           TEXT,
  started_at        TEXT NOT NULL DEFAULT (datetime('now')),
  finished_at       TEXT
);
CREATE INDEX endorsements_started ON endorsements(started_at);
