-- التحصيل اليدوي لشيكات ELONAC المودعة في AGB، للمدير وحده (بطلب ZEKRI يوم 24/11/2026، لأن تحصيلها الآلي
-- من رسائل البنك لا يعمل حالياً). السجل هو أيضاً القفل ضد الضغط المزدوج، مثل جدول deposits:
--   pending  قيد التنفيذ الآن
--   done     صارت حالة الشيك «محصّل» في زوهو
--   failed   لم يتغيّر شيء في زوهو، أو تُرُوجع عن التحصيل، فيمكن التحصيل من جديد
--   unknown  انقطع الرد بعد طلب الكتابة (التحصيل أو التراجع عنه): يحسمه المدير بعد التحقق في زوهو
CREATE TABLE collections (
  payment_id    TEXT PRIMARY KEY,
  state         TEXT NOT NULL CHECK (state IN ('pending', 'done', 'failed', 'unknown')),
  user_id       INTEGER,
  username      TEXT,
  display_name  TEXT,
  customer      TEXT,
  cheque_number TEXT,
  amount        REAL,
  collect_date  TEXT,
  message       TEXT,
  started_at    TEXT NOT NULL DEFAULT (datetime('now')),
  finished_at   TEXT
);
CREATE INDEX collections_state ON collections(state);
