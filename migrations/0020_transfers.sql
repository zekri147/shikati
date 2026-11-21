-- التحويلات البنكية من العملاء، يسجّلها كل مندوب من شاشة التسجيل (بموافقة ZEKRI يوم 21/11/2026).
-- دفعة عميل بطريقة «تحويل بنكي» في حساب البنك مباشرة، لا في حساب الشيكات في الحوزة، فلا عهدة ولا إيداع.
-- السجل هو أيضاً القفل ضد الضغط المزدوج وضد تكرار التحويل:
--   المفتاح الأساسي معرّف الطلب الذي يولّده الهاتف، فلا يُرسل الطلب نفسه مرتين،
--   والفهرس الفريد على العميل والبنك والمرجع يمنع تسجيل التحويل نفسه مرتين ما لم يفشل أو يُحذف.
--   pending  قيد التنفيذ   done  أُنشئت الدفعة   failed  لم تُنشأ، فيمكن المحاولة
--   unknown  انقطع الرد بعد إرسال الدفعة: يجب التحقق في زوهو قبل أي محاولة جديدة
--   deleted  حُذفت الدفعة من زوهو (تراجع من التطبيق، أو حُذفت في زوهو مباشرة)
CREATE TABLE transfers (
  request_id   TEXT PRIMARY KEY,
  state        TEXT NOT NULL CHECK (state IN ('pending', 'done', 'failed', 'unknown', 'deleted')),
  user_id      INTEGER,
  username     TEXT,
  display_name TEXT,
  customer_id  TEXT NOT NULL,
  customer     TEXT,
  bank         TEXT NOT NULL,
  reference    TEXT,
  amount       REAL NOT NULL,
  date         TEXT NOT NULL,
  payment_id   TEXT,
  message      TEXT,
  started_at   TEXT NOT NULL DEFAULT (datetime('now')),
  finished_at  TEXT
);
CREATE UNIQUE INDEX transfers_reference ON transfers(customer_id, bank, reference)
  WHERE reference IS NOT NULL AND state IN ('pending', 'done', 'unknown');
CREATE INDEX transfers_started ON transfers(started_at);
CREATE INDEX transfers_payment ON transfers(payment_id);
