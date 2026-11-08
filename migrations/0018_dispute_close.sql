-- إغلاق الاعتراض على صورة الدين (8/11/2026، بطلب ZEKRI): المدير يعلّمه «عولج» بعد تصحيحه في زوهو،
-- فتبقى الاعتراضات المفتوحة ظاهرة له من كل الدورات حتى يغلقها. في التطبيق وحده، لا كتابة في زوهو.
ALTER TABLE debt_snapshot ADD COLUMN resolved_at TEXT;
ALTER TABLE debt_snapshot ADD COLUMN resolved_by TEXT;
