export interface Env {
  DB: D1Database;
  ASSETS: Fetcher;
  ZOHO_ORG_ID: string;
  ZOHO_API_BASE: string;
  ZOHO_ACCOUNTS_URL: string;
  SESSION_HOURS: string;
  // الأدوار المسموح لها بتسجيل الإيداع، مفصولة بفاصلة: admin أو admin,rep
  DEPOSIT_ROLES?: string;
  // الأدوار المسموح لها بتسجيل شيك جديد، بنفس الصيغة. الافتراضي: admin,rep
  REGISTER_ROLES?: string;
  // أسرار تُضاف بـ wrangler secret put، لا تُكتب في الشيفرة
  ZOHO_CLIENT_ID?: string;
  ZOHO_CLIENT_SECRET?: string;
  ZOHO_REFRESH_TOKEN?: string;
  // بديل: وسيط تجديد الرمز في غوغل (relay/zoho-token-relay.gs)
  ZOHO_RELAY_URL?: string;
  ZOHO_RELAY_KEY?: string;
  // مفتاح واجهة كلود لقراءة صورة الشيك. سر يُضاف بـ wrangler secret put
  ANTHROPIC_API_KEY?: string;
  // للتجربة المحلية فقط: عنوان خادم كلود الوهمي
  ANTHROPIC_BASE_URL?: string;
  // اختياري: لإنشاء أول حساب مدير من صفحة /setup، ويُحذف بعد الاستعمال
  SETUP_TOKEN?: string;
  // للتجربة المحلية فقط: "1" يقبل خدمة إشعارات وهمية على 127.0.0.1
  PUSH_ALLOW_LOCAL?: string;
}

// دوران فقط منذ 7/11/2026 (بطلب ZEKRI): كل مستخدم غير المدير مندوب (rep). يرى كل الشيكات ويسجّل ويودع،
// ويرى في التحصيل عملاءه فقط. الدور القديم «مودِع» (depositor) صار مندوباً (migrations/0011).
export type Role = 'admin' | 'rep';

export interface User {
  id: number;
  username: string;
  display_name: string;
  role: Role;
  // رمز المندوب كما في الحقل «Owner» (cf_owner) على العميل في زوهو. فارغ لمن ليس مندوباً.
  rep_code?: string | null;
}
