import type { Env, Role, User } from '../env';

// كل قسم في التطبيق وحدة مستقلة. لإضافة قسم جديد لاحقاً (قائمة الاتصال، المنتجات)
// يكفي إنشاء ملف وحدة وإضافته إلى القائمة في modules/index.ts.
export interface AppModule {
  id: string;
  title: string;
  roles: Role[];
  // شرط إضافي اختياري: القسم يظهر لمن تحقق فيه، مثل وجود رمز المندوب
  allow?(user: User): boolean;
  // subpath هو ما بعد /api/m/<id>
  handle(req: Request, env: Env, user: User, subpath: string): Promise<Response>;
}
