import * as React from 'react';
import { Menu as MenuIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Menu, MenuContent, MenuItem, MenuLabel, MenuSeparator, MenuTrigger } from '@/components/ui/dropdown';
import { toggleTheme, useTheme } from '@/lib/theme';
import { logout } from '@/lib/api';

// الشعار الأحمر في الوضع الفاتح، والأبيض في الداكن (قاعدة هوية إيلوناك: على الأسود يوضع الشعار الأبيض)
export function Logo() {
  return (
    <>
      <img className="hidden h-[18px] w-auto dark:block" src="/img/logo-white.svg" alt="إيلوناك" />
      <img className="block h-[18px] w-auto dark:hidden" src="/img/logo-red.svg" alt="إيلوناك" />
    </>
  );
}

export type MenuLink = { href: string; label: string };

// الشريط العلوي: الشعار يميناً، وزر «القائمة» يساراً. القائمة: الاسم، والروابط، والوضع، والخروج مفصولاً بخط.
export function TopBar({ name, links = [], themeOnly, showLogout = true }: {
  name?: string; links?: MenuLink[]; themeOnly?: boolean; showLogout?: boolean;
}) {
  const theme = useTheme();
  const themeLabel = theme === 'dark' ? 'الوضع الفاتح' : 'الوضع الداكن';
  return (
    <header className="sticky top-0 z-30 flex min-h-[52px] items-center justify-between gap-3 border-b border-line bg-surface pe-2 ps-4 pt-[env(safe-area-inset-top)] text-foreground">
      <Logo />
      {themeOnly ? (
        <Button variant="ghost" onClick={toggleTheme} aria-label={theme === 'dark' ? 'التبديل إلى الوضع الفاتح' : 'التبديل إلى الوضع الداكن'}>{themeLabel}</Button>
      ) : (
        <Menu dir="rtl" modal={false}>
          <MenuTrigger asChild>
            <Button variant="ghost" id="menu-btn" className="gap-2"><MenuIcon aria-hidden className="size-5.5" /><span>القائمة</span></Button>
          </MenuTrigger>
          <MenuContent>
            {name ? <MenuLabel>{name}</MenuLabel> : null}
            {links.map((l) => <MenuItem key={l.href} asChild><a href={l.href}>{l.label}</a></MenuItem>)}
            {/* تغيير الوضع يُبقي القائمة مفتوحة ليرى المستعمل النتيجة */}
            <MenuItem onSelect={(e) => { e.preventDefault(); toggleTheme(); }}>{themeLabel}</MenuItem>
            {showLogout ? (
              <>
                <MenuSeparator />
                <MenuItem danger onSelect={() => logout()}>خروج</MenuItem>
              </>
            ) : null}
          </MenuContent>
        </Menu>
      )}
    </header>
  );
}

export function Footer() {
  return (
    <footer className="mx-auto my-6 flex max-w-[760px] items-center gap-2 px-4 text-sm text-soft">
      <img src="/img/symbol-red.svg" alt="" className="h-3.5 w-auto" /> سري — للاستعمال الداخلي
    </footer>
  );
}

export function Main({ children, className }: { children: React.ReactNode; className?: string }) {
  return <main className={'mx-auto max-w-[760px] px-4 pt-4 pb-[calc(16px+var(--fixed-bottom,0px)+env(safe-area-inset-bottom))] ' + (className || '')}>{children}</main>;
}

export function ErrorBox({ children }: { children: React.ReactNode }) {
  return <div className="mt-4 border-s-4 border-s-brand bg-surface px-3.5 py-3">{children}</div>;
}

export function Empty({ children }: { children: React.ReactNode }) {
  return <div className="border border-dashed border-line-strong bg-surface px-3 py-4 text-center text-base text-muted">{children}</div>;
}

// ملاحظة: tone=warn للمتابعة، وalert للعاجل، وok للنجاح
export function Note({ tone, children, className }: { tone?: 'warn' | 'alert' | 'ok'; children: React.ReactNode; className?: string }) {
  const t = tone === 'warn' ? 'border-s-warning bg-warning-tint text-foreground'
    : tone === 'alert' ? 'border-s-brand bg-brand-tint text-foreground'
      : tone === 'ok' ? 'border-s-success bg-surface-alt text-foreground' : 'border-s-line-strong bg-surface-alt text-muted';
  return <div className={'border-s-3 px-3 py-2 text-sm ' + t + ' ' + (className || '')}>{children}</div>;
}

export function FormError({ children }: { children?: React.ReactNode }) {
  return <div role="alert" className="mt-2.5 min-h-[1.6em] text-base text-danger">{children}</div>;
}
