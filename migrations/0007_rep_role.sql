-- قسم التحصيل (7/11/2026): دور جديد «مندوب»، ورمز المندوب لكل مستخدم.
-- رمز المندوب يطابق قيمة الحقل المخصص «Owner» (cf_owner) على العميل في زوهو، مثل AMINE أو ZAKARIA.
-- أي مستخدم له رمز يرى تحصيل عملائه، ولو كان مودِعاً.
-- SQLite لا يغيّر شرط CHECK في جدول قائم، فنعيد بناء جدول المستخدمين بالمعرّفات نفسها.
-- حذف الجدول القديم يحذف الجلسات المرتبطة به، فنحفظها قبله ونعيدها بعده، حتى لا يخرج أحد.

PRAGMA defer_foreign_keys = true;

CREATE TABLE users_new (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  username     TEXT NOT NULL UNIQUE COLLATE NOCASE,
  display_name TEXT NOT NULL,
  role         TEXT NOT NULL CHECK (role IN ('admin', 'depositor', 'rep')),
  pw_hash      TEXT NOT NULL,
  pw_salt      TEXT NOT NULL,
  pw_iter      INTEGER NOT NULL,
  active       INTEGER NOT NULL DEFAULT 1,
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  rep_code     TEXT
);

INSERT INTO users_new (id, username, display_name, role, pw_hash, pw_salt, pw_iter, active, created_at)
  SELECT id, username, display_name, role, pw_hash, pw_salt, pw_iter, active, created_at FROM users;

CREATE TABLE sessions_keep AS SELECT * FROM sessions;

DROP TABLE users;
ALTER TABLE users_new RENAME TO users;

INSERT INTO sessions (token_hash, user_id, created_at, expires_at)
  SELECT token_hash, user_id, created_at, expires_at FROM sessions_keep;
DROP TABLE sessions_keep;

PRAGMA defer_foreign_keys = false;
