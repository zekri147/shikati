-- إشعارات الهاتف (Web Push):
-- اشتراك كل جهاز فعّل الإشعارات. المفتاح هو عنوان الجهاز عند خدمة الإشعارات.
CREATE TABLE push_subscriptions (
  endpoint   TEXT PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  p256dh     TEXT NOT NULL,
  auth       TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_ok    TEXT
);
CREATE INDEX push_subscriptions_user ON push_subscriptions(user_id);

-- الشيكات التي أُرسل عنها إشعار التحصيل، حتى لا يتكرر الإشعار.
-- الإدخال ذري: من يُدخل السطر أولاً هو الذي يرسل.
CREATE TABLE collect_notices (
  payment_id TEXT PRIMARY KEY,
  sent       INTEGER NOT NULL,
  at         TEXT NOT NULL DEFAULT (datetime('now'))
);

-- قيم صغيرة للمهام الدورية
CREATE TABLE app_meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
