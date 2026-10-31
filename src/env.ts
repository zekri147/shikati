export interface Env {
  DB: D1Database;
  ASSETS: Fetcher;
  ZOHO_ORG_ID: string;
  ZOHO_API_BASE: string;
  ZOHO_ACCOUNTS_URL: string;
  SESSION_HOURS: string;
  // أسرار تُضاف بـ wrangler secret put، لا تُكتب في الشيفرة
  ZOHO_CLIENT_ID?: string;
  ZOHO_CLIENT_SECRET?: string;
  ZOHO_REFRESH_TOKEN?: string;
  // بديل: وسيط تجديد الرمز في غوغل (relay/zoho-token-relay.gs)
  ZOHO_RELAY_URL?: string;
  ZOHO_RELAY_KEY?: string;
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
