-- المراجعة الأسبوعية في قسم التحصيل (7/11/2026، بطلب ZEKRI).
-- كل أسبوع (من السبت إلى الخميس) يراجع المندوب كل عميل له دين متأخر أكثر من 90 يوماً أو رصيد افتتاحي،
-- ويكتب ملاحظة إن أراد. الأجل الخميس الساعة 12:00 بتوقيت الجزائر.
-- مراجعة واحدة لكل عميل في كل أسبوع. الإلغاء يحذف الصف.
-- zoho_comment_id فارغ الآن: للمرحلة الثالثة (نقل الملاحظة تعليقاً على العميل في زوهو، بموافقة ZEKRI).
CREATE TABLE coll_reviews (
  week            TEXT NOT NULL,     -- تاريخ سبت الأسبوع YYYY-MM-DD
  customer_id     TEXT NOT NULL,
  rep             TEXT NOT NULL,     -- رمز المندوب صاحب العميل وقت المراجعة
  customer_name   TEXT NOT NULL,
  balance         REAL NOT NULL,     -- رصيد العميل وقت المراجعة
  note            TEXT NOT NULL DEFAULT '',
  user_id         INTEGER NOT NULL,
  username        TEXT NOT NULL,
  reviewed_at     TEXT NOT NULL DEFAULT (datetime('now')),
  late            INTEGER NOT NULL DEFAULT 0,  -- 1 إن كانت بعد الأجل
  zoho_comment_id TEXT,
  PRIMARY KEY (week, customer_id)
);
CREATE INDEX coll_reviews_rep ON coll_reviews(week, rep);
