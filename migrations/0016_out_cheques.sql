-- شيكات الشركة الصادرة لموردين، يسجّلها المدير من شاشة التسجيل (بطلب ZEKRI يوم 8/11/2026).
-- السجل هو أيضاً القفل ضد الضغط المزدوج وضد تكرار الشيك:
--   المفتاح الأساسي معرّف الطلب الذي يولّده الهاتف، فلا يُرسل الطلب نفسه مرتين،
--   والفهرس الفريد على البنك ورقم الشيك يمنع تسجيل شيك الدفتر نفسه مرتين ما لم يفشل التسجيل السابق.
--   pending  قيد التنفيذ   done  أُنشئت دفعة المورد   failed  لم تُنشأ، فيمكن المحاولة
--   unknown  انقطع الرد بعد إرسال دفعة المورد: يجب التحقق في زوهو قبل أي محاولة جديدة
CREATE TABLE out_cheques (
  request_id        TEXT PRIMARY KEY,
  state             TEXT NOT NULL CHECK (state IN ('pending', 'done', 'failed', 'unknown')),
  user_id           INTEGER,
  username          TEXT,
  display_name      TEXT,
  vendor_id         TEXT NOT NULL,
  vendor            TEXT,
  bank              TEXT NOT NULL,
  cheque_number     TEXT NOT NULL,
  amount            REAL NOT NULL,
  vendor_payment_id TEXT,
  message           TEXT,
  started_at        TEXT NOT NULL DEFAULT (datetime('now')),
  finished_at       TEXT
);
CREATE UNIQUE INDEX out_cheques_number ON out_cheques(bank, cheque_number) WHERE state != 'failed';
CREATE INDEX out_cheques_started ON out_cheques(started_at);
