-- المراجعة الأسبوعية لكل العملاء المدينين (7/11/2026، بطلب ZEKRI).
-- عدد عملاء كل مندوب الذين يحتاجون مراجعة في كل أسبوع، يُحدَّث مع كل تحديث لأرصدة التحصيل
-- خلال الأسبوع، ويبقى آخر رقم بعده. منه سجل الالتزام للمدير (راجع كذا من كذا في كل أسبوع).
CREATE TABLE coll_week_need (
  week       TEXT NOT NULL,     -- تاريخ سبت الأسبوع YYYY-MM-DD
  rep        TEXT NOT NULL,     -- رمز المندوب
  need       INTEGER NOT NULL,  -- عدد عملائه المدينين
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (week, rep)
);
