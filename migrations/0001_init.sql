-- المستخدمون: الرمز السري مخزّن مشفّراً (PBKDF2-SHA256) مع ملح لكل مستخدم
CREATE TABLE users (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  username     TEXT NOT NULL UNIQUE COLLATE NOCASE,
  display_name TEXT NOT NULL,
  role         TEXT NOT NULL CHECK (role IN ('admin', 'depositor')),
  pw_hash      TEXT NOT NULL,
  pw_salt      TEXT NOT NULL,
  pw_iter      INTEGER NOT NULL,
  active       INTEGER NOT NULL DEFAULT 1,
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

-- الجلسات: نخزّن بصمة الرمز فقط، لا الرمز نفسه
CREATE TABLE sessions (
  token_hash TEXT PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX sessions_user ON sessions(user_id);
CREATE INDEX sessions_expiry ON sessions(expires_at);

-- محاولات الدخول الفاشلة لكل اسم مستخدم ولكل عنوان
CREATE TABLE login_attempts (
  key          TEXT PRIMARY KEY,
  failures     INTEGER NOT NULL,
  first_at     INTEGER NOT NULL,
  locked_until INTEGER NOT NULL DEFAULT 0
);

-- سجل العمليات: الدليل على من فعل ماذا ومتى
CREATE TABLE audit_log (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  at       TEXT NOT NULL DEFAULT (datetime('now')),
  user_id  INTEGER,
  username TEXT,
  action   TEXT NOT NULL,
  target   TEXT,
  result   TEXT NOT NULL,
  details  TEXT
);
CREATE INDEX audit_at ON audit_log(at);

-- تخزين مؤقت قصير: رمز وصول زوهو وقائمة الشيكات
CREATE TABLE cache (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);
