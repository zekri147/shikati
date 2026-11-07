import { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Footer, TopBar, type MenuLink } from '@/components/shell';
import { api, type Me } from '@/lib/api';
import { mountPage } from '@/lib/page';

// صفحة المساعدة: النص ثابت في الصفحة، والشريط العلوي نفسه. تُفتح قبل الدخول أيضاً،
// فيختفي الاسم والخروج إن لم يكن هناك دخول.
function HelpBar() {
  const [me, setMe] = useState<Me | null>(null);
  const [anon, setAnon] = useState(false);
  useEffect(() => { api<Me>('/api/me', { noRedirect: true }).then(setMe).catch(() => setAnon(true)); }, []);
  const links: MenuLink[] = anon ? [{ href: '/login', label: 'الدخول' }] : [
    { href: '/', label: 'التطبيق' },
    ...(me?.user.role === 'admin' ? [{ href: '/admin', label: 'الإدارة' }] : []),
  ];
  return <TopBar name={me?.user.display_name} links={links} showLogout={!anon} />;
}

mountPage(<HelpBar />);
createRoot(document.getElementById('foot')!).render(<Footer />);
