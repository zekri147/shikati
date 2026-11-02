-- اتجاه صورة الشيك: كم درجة تُدار باتجاه عقارب الساعة ليظهر الشيك أفقياً ومعتدلاً.
-- يحدّده كلود مرة واحدة لكل صورة، ويُحفظ هنا مع معرّف المرفق، فإن تغيّرت الصورة أُعيد التحديد.
CREATE TABLE image_rotation (
  payment_id  TEXT PRIMARY KEY,
  document_id TEXT NOT NULL,
  rotation    INTEGER NOT NULL CHECK (rotation IN (0, 90, 180, 270)),
  source      TEXT NOT NULL,
  at          TEXT NOT NULL DEFAULT (datetime('now'))
);
