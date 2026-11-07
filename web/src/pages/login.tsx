import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Field, Input } from '@/components/ui/input';
import { Footer, FormError, TopBar } from '@/components/shell';
import { api, errText } from '@/lib/api';

export function AuthCard({ title, sub, children }: { title: string; sub: string; children: React.ReactNode }) {
  return (
    <div className="flex min-h-screen flex-col">
      <TopBar themeOnly />
      <main className="mx-auto my-10 w-[calc(100%-32px)] max-w-[400px] border-t-4 border-t-brand bg-surface px-5 py-6">
        <h1 className="m-0 mb-1 text-2xl font-bold">{title}</h1>
        <p className="mt-0 text-muted">{sub}</p>
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
          <Input id="username" name="username" autoComplete="username" autoCapitalize="none" spellCheck={false} dir="ltr" value={username} onChange={(e) => setUsername(e.target.value)} />
        </Field>
        <Field label="الرمز السري">
          <Input id="password" name="password" type="password" autoComplete="current-password" dir="ltr" value={password} onChange={(e) => setPassword(e.target.value)} />
        </Field>
        <FormError>{error}</FormError>
        <Button type="submit" variant="primary" size="lg" disabled={busy}>{busy ? 'جارٍ الدخول…' : 'دخول'}</Button>
      </form>
      <a className="mt-4.5 block text-center text-base text-muted underline" href="/help">طريقة التثبيت على الهاتف والاستعمال</a>
    </AuthCard>
  );
}
