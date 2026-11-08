-- إقرار الدين (8/11/2026، بطلب ZEKRI): بدل المراجعة الأسبوعية.
-- كل 14 يوماً، من السبت (الدورة الأولى السبت 7/11/2026)، يأخذ التطبيق صورة لديون عملاء كل مندوب،
-- فيقرّ المندوب بدين كل عميل («الدين صحيح») أو يعترض عليه بسبب. الاعتراض وحده يُكتب تعليقاً في زوهو.
-- جدول coll_reviews يبقى للمراجعات القديمة.

-- الدورة: صورة واحدة لكل دورة. claimed_at قفل ضد أخذ الصورة مرتين في وقت واحد، وready بعد حفظها كاملة.
CREATE TABLE debt_cycles (
  cycle      TEXT PRIMARY KEY,                 -- تاريخ سبت بداية الدورة YYYY-MM-DD
  ready      INTEGER NOT NULL DEFAULT 0,
  claimed_at TEXT NOT NULL DEFAULT (datetime('now')),
  taken_at   TEXT                              -- وقت أخذ الصورة، بتوقيت غرينتش
);

-- صورة الدين: عميل لكل صف، برصيده لحظة الصورة، ثم جواب المندوب.
-- zoho_state للاعتراض فقط: skip للإقرار (لا يُكتب في زوهو)، ثم none وpending وdone وfailed وunknown
-- بالمعاني نفسها في 0009_review_zoho.sql: المنقطع (unknown) لا يُعاد أبداً حتى يتحقق المدير.
CREATE TABLE debt_snapshot (
  cycle           TEXT NOT NULL,
  customer_id     TEXT NOT NULL,
  rep             TEXT NOT NULL,     -- رمز المندوب صاحب العميل لحظة الصورة
  customer_name   TEXT NOT NULL,
  balance         REAL NOT NULL,     -- الرصيد لحظة الصورة
  late            INTEGER,           -- أيام تأخر أقدم فاتورة، وNULL للرصيد الافتتاحي وحده
  invoices        INTEGER NOT NULL DEFAULT 0,
  answer          TEXT,              -- NULL لم يُجب، ok أقرّ، dispute اعترض
  reason          TEXT,              -- سبب الاعتراض: paid أو not_mine أو amount أو other
  note            TEXT NOT NULL DEFAULT '',
  user_id         INTEGER,
  username        TEXT,
  answered_at     TEXT,
  zoho_state      TEXT NOT NULL DEFAULT 'skip',
  zoho_error      TEXT,
  zoho_comment_id TEXT,
  PRIMARY KEY (cycle, customer_id)
);
CREATE INDEX debt_snapshot_rep ON debt_snapshot(cycle, rep);
