export interface Env {
  DB: D1Database;
  ASSETS: Fetcher;
  ZOHO_ORG_ID: string;
  ZOHO_API_BASE: string;
  ZOHO_ACCOUNTS_URL: string;
  SESSION_HOURS: string;
  // الأدوار المسموح لها بتسجيل الإيداع، مفصولة بفاصلة: admin أو admin,depositor
  DEPOSIT_ROLES?: string;
  // الأدوار المسموح لها بتسجيل شيك جديد، بنفس الصيغة. الافتراضي: admin,depositor
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
  // إشعارات الهاتف: عنوان المرسل في توقيع VAPID. المفاتيح نفسها في قاعدة D1 (src/push.ts)
  VAPID_SUBJECT?: string;
  // اختياري: لإنشاء أول حساب مدير من صفحة /setup، ويُحذف بعد الاستعمال
  SETUP_TOKEN?: string;
}

export type Role = 'admin' | 'depositor';

export interface User {
  id: number;
  username: string;
  display_name: string;
  role: Role;
}
