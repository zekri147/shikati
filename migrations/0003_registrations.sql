-- سجل تسجيل الشيكات من التطبيق، وهو أيضاً القفل ضد الضغط المزدوج وضد تكرار الشيك:
--   المفتاح الأساسي معرّف الطلب الذي يولّده الهاتف، فلا يُرسل الطلب نفسه مرتين،
--   والفهرس الفريد على العميل ورقم الشيك يمنع تسجيل الشيك نفسه مرتين ما لم يفشل التسجيل السابق.
--   pending  قيد التنفيذ الآن
--   done     أُنشئت الدفعة في زوهو
--   failed   فشل قبل إنشاء أي دفعة، فيمكن إعادة المحاولة
--   unknown  انقطع الرد بعد إرسال طلب الإنشاء: يجب التحقق في زوهو قبل أي محاولة جديدة
CREATE TABLE registrations (
  request_id    TEXT PRIMARY KEY,
  state         TEXT NOT NULL CHECK (state IN ('pending', 'done', 'failed', 'unknown')),
  user_id       INTEGER,
  username      TEXT,
  display_name  TEXT,
  customer_id   TEXT NOT NULL,
  customer      TEXT,
  cheque_number TEXT NOT NULL,
  amount        REAL NOT NULL,
  payment_id    TEXT,
  message       TEXT,
  started_at    TEXT NOT NULL DEFAULT (datetime('now')),
  finished_at   TEXT
);
CREATE UNIQUE INDEX registrations_cheque ON registrations(customer_id, cheque_number) WHERE state != 'failed';
CREATE INDEX registrations_started ON registrations(started_at);
