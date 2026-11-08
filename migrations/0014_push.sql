-- إشعارات الهاتف (8/11/2026، بطلب ZEKRI): الإشعارات الفورية للويب (Web Push). قراءة فقط من زوهو.

-- اشتراك كل هاتف: عنوان خدمة الإشعارات في نظامه ومفتاحا التشفير العامان (ليست أسراراً للخادم).
-- الهاتف لمستخدم واحد: من دخل أخيراً وفعّل الإشعارات.
CREATE TABLE push_subs (
  endpoint   TEXT PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  p256dh     TEXT NOT NULL,
  auth       TEXT NOT NULL,
  label      TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_ok_at TEXT,
  fails      INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX push_subs_user ON push_subs (user_id);

-- ما أُرسل من إشعارات المهمة المجدولة، حتى لا يتكرر: مفتاح لكل حدث، مثل rejected:<الدفعة>
-- أو late:<اليوم>:<المستخدم>. الإدخال الذري (INSERT OR IGNORE) يمنع الإرسال مرتين.
CREATE TABLE notify_sent (
  key TEXT PRIMARY KEY,
  at  TEXT NOT NULL DEFAULT (datetime('now'))
);

-- مفاتيح يولّدها التطبيق لنفسه: مفتاح توقيع الإشعارات (vapid). لا يتصل بزوهو.
CREATE TABLE app_keys (
  name       TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
