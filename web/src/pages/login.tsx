import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Field, Input, PasswordInput } from '@/components/ui/input';
import { Footer, FormError, TopBar } from '@/components/shell';
import { api, errText } from '@/lib/api';
import { clearCaches } from '@/lib/cache';

export function AuthCard({ title, sub, children }: { title: string; sub: string; children: React.ReactNode }) {
  return (
    <div className="flex min-h-screen flex-col">
      <TopBar bare />
      {/* اللوح الأحمر الملاصق للشريط العلوي باسم التطبيق، ثم النموذج مباشرة على الصفحة دون صندوق */}
      <div className="cut-br bg-brand px-4 pb-8 pt-4 text-white">
        <div className="mx-auto max-w-[400px]">
          <h1 className="m-0 text-2xl font-bold">{title}</h1>
          <p className="mb-0 mt-1 text-base">{sub}</p>
        </div>
      </div>
      <main className="mx-auto w-[calc(100%-32px)] max-w-[400px] flex-1 pt-4">
        {children}
      </main>
      <Footer />
    </div>
  );
}

export function LoginPage() {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    if (!username.trim() || !password) { setError('أدخل اسم المستخدم والرمز السري.'); return; }
    setBusy(true);
    try {
      await api('/api/login', { method: 'POST', body: { username: username.trim(), password }, noRedirect: true });
      // بيانات مستخدم سابق على هذا الجهاز لا تبقى
      clearCaches();
      location.href = '/';
    } catch (ex) {
      setError(errText(ex));
      setPassword('');
      setBusy(false);
    }
  }

  return (
    <AuthCard title="شيكاتي" sub="متابعة شيكات العملاء وإيداعها في البنك.">
      <form onSubmit={submit} noValidate>
        <Field label="اسم المستخدم">
          <Input id="username" name="username" enterKeyHint="next" autoComplete="username" autoCapitalize="none" spellCheck={false} dir="ltr" value={username} onChange={(e) => setUsername(e.target.value)} />
        </Field>
        <Field label="الرمز السري">
          <PasswordInput id="password" name="password" autoComplete="current-password" dir="ltr" enterKeyHint="go" value={password} onChange={(e) => setPassword(e.target.value)} />
        </Field>
        <FormError>{error}</FormError>
        <Button id="login-btn" type="submit" variant="primary" size="lg" disabled={busy}>{busy ? "جارٍ الدخول…" : "دخول"}</Button>
      </form>
      <a className="mt-4 block text-center text-base text-muted underline" href="/help">طريقة التثبيت على الهاتف والاستعمال</a>
    </AuthCard>
  );
}
