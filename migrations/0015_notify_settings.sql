-- إعدادات الإشعارات للمدير (8/11/2026، بطلب ZEKRI): تنطبق على كل المستخدمين معاً.
-- سطر واحد بصيغة JSON (id = 1)، والقيم الناقصة تأخذ القيم الافتراضية في src/notifysettings.ts.
CREATE TABLE notify_settings (
  id         INTEGER PRIMARY KEY CHECK (id = 1),
  value      TEXT NOT NULL,
  updated_by INTEGER,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- الإشعارات اليدوية التي يكتبها المدير: لمن أُرسلت، ونصها، وكم جهازاً وصلها.
CREATE TABLE notify_manual (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  at        TEXT NOT NULL DEFAULT (datetime('now')),
  by_id     INTEGER,
  to_id     INTEGER,            -- فارغ: للجميع
  body      TEXT NOT NULL,
  devices   INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX notify_manual_at ON notify_manual (at);
