-- الدخول بالبصمة (مفاتيح المرور، WebAuthn)، بموافقة ZEKRI يوم 7/11/2026.
-- يُحفظ المفتاح العام لكل جهاز فقط: البصمة نفسها لا تخرج من الهاتف أبداً.
CREATE TABLE passkeys (
  id          TEXT PRIMARY KEY,               -- معرّف المفتاح (base64url) كما يعطيه الهاتف
  user_id     INTEGER NOT NULL REFERENCES users(id),
  public_key  TEXT NOT NULL,                  -- المفتاح العام بصيغة SPKI (base64)
  alg         INTEGER NOT NULL,               -- -7 لـ ES256، و-257 لـ RS256
  sign_count  INTEGER NOT NULL DEFAULT 0,     -- عدّاد التوقيع: نزوله يعني مفتاحاً منسوخاً
  label       TEXT NOT NULL,                  -- وصف الجهاز كما ظهر عند التفعيل
  created_at  INTEGER NOT NULL,
  last_used   INTEGER
);
CREATE INDEX passkeys_user ON passkeys(user_id);

-- التحدي العشوائي لكل محاولة: يُستعمل مرة واحدة، ويسقط بعد 5 دقائق
CREATE TABLE passkey_challenges (
  challenge   TEXT PRIMARY KEY,
  kind        TEXT NOT NULL,                  -- reg للتفعيل، auth للدخول
  user_id     INTEGER,
  expires_at  INTEGER NOT NULL
);
