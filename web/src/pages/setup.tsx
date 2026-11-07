import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Field, Input, PasswordInput } from '@/components/ui/input';
import { FormError } from '@/components/shell';
import { api, errText } from '@/lib/api';
import { AuthCard } from './login';

export function SetupPage() {
  const [f, setF] = useState({ token: '', display_name: 'ZEKRI', username: 'zekri', password: '', password2: '' });
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement>) => setF({ ...f, [k]: e.target.value });

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    if (f.password !== f.password2) { setError('الرمزان غير متطابقين.'); return; }
    setBusy(true);
    try {
      await api('/api/setup', { method: 'POST', noRedirect: true, body: {
        token: f.token, display_name: f.display_name.trim(), username: f.username.trim(), password: f.password,
      } });
      location.href = '/login';
    } catch (ex) {
      setError(errText(ex));
      setBusy(false);
    }
  }

  return (
    <AuthCard title="الإعداد الأولي" sub="إنشاء أول حساب مدير. هذه الصفحة تعمل مرة واحدة فقط.">
      <form onSubmit={submit} noValidate>
        <Field label="رمز الإعداد"><Input type="password" autoComplete="off" dir="ltr" value={f.token} onChange={set('token')} /></Field>
        <Field label="الاسم الظاهر"><Input value={f.display_name} onChange={set('display_name')} /></Field>
        <Field label="اسم الدخول"><Input dir="ltr" autoCapitalize="none" spellCheck={false} value={f.username} onChange={set('username')} /></Field>
        <Field label="الرمز السري (10 أحرف على الأقل)"><PasswordInput autoComplete="new-password" dir="ltr" value={f.password} onChange={set('password')} /></Field>
        <Field label="أعد كتابة الرمز السري"><Input type="password" autoComplete="new-password" dir="ltr" value={f.password2} onChange={set('password2')} /></Field>
        <FormError>{error}</FormError>
        <Button type="submit" variant="primary" size="lg" disabled={busy}>{busy ? 'جارٍ الإنشاء…' : 'إنشاء حساب المدير'}</Button>
      </form>
    </AuthCard>
  );
}
