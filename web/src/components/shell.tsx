import * as React from 'react';
import { Menu as MenuIcon, RefreshCw } from 'lucide-react';
import { relTime } from '@/lib/format';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Menu, MenuContent, MenuItem, MenuLabel, MenuSeparator, MenuTrigger } from '@/components/ui/dropdown';
import { toggleTheme, useTheme } from '@/lib/theme';
import { logout } from '@/lib/api';

// الشعار الأبيض على الشريط الأحمر (قاعدة هوية إيلوناك: على الأحمر يوضع الشعار الأبيض)
export function Logo() {
  return <img className="block h-[18px] w-auto" src="/img/logo-white.svg" alt="إيلوناك" />;
}

export type MenuLink = { href: string; label: string };

// الشريط العلوي: الشعار يميناً، وزر «القائمة» يساراً. القائمة: الاسم، والروابط، والوضع، والخروج مفصولاً بخط.
// bare: الشعار وحده، لصفحتي الدخول والإعداد
export function TopBar({ name, links = [], themeOnly, bare, showLogout = true }: {
  name?: string; links?: MenuLink[]; themeOnly?: boolean; bare?: boolean; showLogout?: boolean;
}) {
  const theme = useTheme();
  const themeLabel = theme === 'dark' ? 'الوضع الفاتح' : 'الوضع الداكن';
  return (
    <header className="sticky top-0 z-30 flex min-h-[52px] items-center justify-between gap-3 bg-brand pe-2 ps-4 pt-[env(safe-area-inset-top)] text-white [&_:focus-visible]:outline-white">
      <Logo />
      {bare ? null : themeOnly ? (
        <Button variant="ghost" className="text-white hover:bg-press-on-brand active:bg-press-on-brand" onClick={toggleTheme} aria-label={theme === 'dark' ? 'التبديل إلى الوضع الفاتح' : 'التبديل إلى الوضع الداكن'}>{themeLabel}</Button>
      ) : (
        <Menu dir="rtl" modal={false}>
          <MenuTrigger asChild>
            <Button variant="ghost" id="menu-btn" className="gap-2 text-white hover:bg-press-on-brand active:bg-press-on-brand"><MenuIcon aria-hidden className="size-5.5" /><span>القائمة</span></Button>
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

// هياكل رمادية مكان القائمة أثناء أول تحميل: يرى الموظف شكل الشاشة فوراً بدل نص الانتظار
export function SkeletonList({ rows = 6, className }: { rows?: number; className?: string }) {
  return (
    <div role="status" aria-busy="true" className={cn('mt-4 border border-line bg-surface motion-safe:animate-pulse', className)}>
      <span className="sr-only">جارٍ التحميل…</span>
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} aria-hidden className="flex min-h-[60px] flex-col justify-center gap-2 border-line px-3 py-3 [&:not(:first-child)]:border-t">
          <div className="flex justify-between gap-6"><span className="h-3.5 bg-surface-alt" style={{ width: `${44 + ((i * 17) % 28)}%` }} /><span className="h-3.5 w-[24%] bg-surface-alt" /></div>
          <span className="h-3 bg-surface-alt" style={{ width: `${36 + ((i * 11) % 20)}%` }} />
        </div>
      ))}
    </div>
  );
}

export function ErrorBox({ children }: { children: React.ReactNode }) {
  return <div className="mt-4 border-s-4 border-s-brand bg-surface px-3 py-3">{children}</div>;
}

export function Empty({ children }: { children: React.ReactNode }) {
  return <div className="border border-dashed border-line-strong bg-surface px-3 py-4 text-center text-base text-muted">{children}</div>;
}

// ملاحظة: tone=warn للمتابعة، وalert للعاجل، وok للنجاح
// compact: داخل البطاقة، بحشوة أصغر (سبب التنبيه، ملاحظة المراجعة)
// plain: سطر نصي بعلامة صغيرة ملوّنة دون خلفية، لأسباب التنبيه تحت بطاقة الشيك (لا صناديق ملوّنة في القائمة)
export function Note({ tone, children, className, compact, plain }: { tone?: 'warn' | 'alert' | 'ok'; children: React.ReactNode; className?: string; compact?: boolean; plain?: boolean }) {
  if (plain) {
    return (
      <div className={cn('flex items-start gap-2 text-sm [overflow-wrap:anywhere]', tone ? 'text-foreground' : 'text-muted', className)}>
        <span aria-hidden className={cn('mt-2 size-1.5 flex-none', tone === 'alert' ? 'bg-brand' : tone === 'warn' ? 'bg-warning' : tone === 'ok' ? 'bg-success' : 'bg-line-strong')} />
        <span className="min-w-0">{children}</span>
      </div>
    );
  }
  const t = tone === 'warn' ? 'border-s-warning bg-warning-tint text-foreground'
    : tone === 'alert' ? 'border-s-brand bg-brand-tint text-foreground'
      : tone === 'ok' ? 'border-s-success bg-surface-alt text-foreground' : 'border-s-line-strong bg-surface-alt text-muted';
  return <div className={cn('border-s-3 text-sm [overflow-wrap:anywhere]', compact ? 'px-2 py-1' : 'px-3 py-2', t, className)}>{children}</div>;
}

export function FormError({ children }: { children?: React.ReactNode }) {
  return <div role="alert" className="mt-2 min-h-[1.6em] text-base text-danger">{children}</div>;
}

// اللوح الأحمر الملاصق للشريط العلوي: ملخص الصفحة أو رأس صفحة التفاصيل.
// بعرض الشاشة كاملاً، وتُقطع زاويته السفلية اليمنى وحدها (هوية إيلوناك). يوضع أول عنصر داخل Main.
export function Slab({ children, className }: { children: React.ReactNode; className?: string }) {
  return <div className={'slab cut-br -mx-4 -mt-4 bg-brand px-4 pb-6 pt-1 text-white [&_:focus-visible]:outline-white ' + (className || '')}>{children}</div>;
}

// صف أعلى اللوح في صفحات التفاصيل: الرجوع يميناً، ومعلومة قصيرة اختيارية يساراً
export function SlabTop({ onBack, extra }: { onBack: () => void; extra?: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <SlabBack onClick={onBack} />
      {extra ? <span className="text-sm">{extra}</span> : null}
    </div>
  );
}

// زر التحديث بوقت آخر تحديث: على اللوح الأحمر (onRed) أو في سطر الحالة. مساحة لمسه 44 بكسل
export function RefreshButton({ busy, loadedAt, onClick, onRed }: { busy: boolean; loadedAt: number; onClick: () => void; onRed?: boolean }) {
  return (
    <Button variant="ghost" disabled={busy} onClick={onClick}
      className={cn('flex-none gap-2 px-2 text-sm font-normal', onRed ? '-me-2 text-white hover:bg-press-on-brand active:bg-press-on-brand disabled:opacity-80' : 'text-muted')}
      aria-label={busy ? 'جارٍ التحديث…' : 'تحديث. آخر تحديث ' + (loadedAt ? relTime(loadedAt) : '')}>
      <RefreshCw aria-hidden className={cn('size-4.5', onRed ? 'text-white' : 'text-foreground', busy && 'animate-spin')} />
      <span className="whitespace-nowrap">{busy ? 'جارٍ التحديث…' : loadedAt ? relTime(loadedAt) : 'تحديث'}</span>
    </Button>
  );
}

// زر الرجوع على اللوح الأحمر
export function SlabBack({ onClick }: { onClick: () => void }) {
  return (
    <Button variant="ghost" onClick={onClick} className="-ms-2 gap-1 px-2 text-white hover:bg-press-on-brand active:bg-press-on-brand">
      <svg aria-hidden="true" viewBox="0 0 24 24" className="size-5" fill="none" stroke="currentColor" strokeWidth="2"><path d="m9 6 6 6-6 6" /></svg>
      <span>رجوع</span>
    </Button>
  );
}
