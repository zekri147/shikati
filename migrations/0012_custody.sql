-- العهدة (7/11/2026، بطلب ZEKRI): من يحمل الشيك فعلياً، في قاعدة التطبيق وحدها، دون أي كتابة في زوهو.
-- holder_id: من الشيك في عهدته الآن (فارغ: غير محددة، كالشيكات المسجّلة قبل العهدة).
-- to_id: تسليم ينتظر تأكيد المستلم. by_id: من سلّمه، وsince: متى.
CREATE TABLE custody (
  payment_id TEXT PRIMARY KEY,
  holder_id  INTEGER REFERENCES users(id),
  to_id      INTEGER REFERENCES users(id),
  by_id      INTEGER REFERENCES users(id),
  since      TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX custody_holder ON custody (holder_id);
CREATE INDEX custody_to ON custody (to_id);

-- كل انتقال للعهدة: register (سجّله)، take (أخذه)، give (سلّمه وينتظر)، accept (استلمه)، refuse (رفضه)، cancel (ألغى التسليم)
CREATE TABLE custody_log (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  payment_id TEXT NOT NULL,
  action     TEXT NOT NULL,
  user_id    INTEGER,
  from_id    INTEGER,
  to_id      INTEGER,
  at         TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX custody_log_payment ON custody_log (payment_id);
