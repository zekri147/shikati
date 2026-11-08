import { useEffect, useSyncExternalStore } from 'react';
import { Bell, ChevronLeft, HandCoins, Landmark, List, Plus } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useFixedBottom } from '@/lib/layout';
import { customersWord } from '@/lib/format';

// عدد التنبيهات في شريط التنقل: يكتبه قسم الشيكات، ويبقى ظاهراً من أي شاشة
let alerts = 0;
const subs = new Set<() => void>();
export function setAlertCount(n: number) { if (n !== alerts) { alerts = n; subs.forEach((s) => s()); } }
const useAlertCount = () => useSyncExternalStore((cb) => { subs.add(cb); return () => { subs.delete(cb); }; }, () => alerts);

const NAV_H = 60;
const STRIP_H = 44;

type Tab = { id: string; label: string; href: string; Icon: React.ComponentType<{ className?: string }>; center?: boolean };

// شريط التنقل الموحّد أسفل الشاشة لكل الأقسام (الدفعة «ج»، بموافقة ZEKRI يوم 7/11/2026):
// الإيداع، والشيكات، وزر التسجيل الأحمر في الوسط، والتنبيهات، والتحصيل لمن له. يختفي في صفحات التفاصيل
// ولمن له قسم واحد (المندوب).
// المندوب الذي لم يُنهِ إقرار الدين (locked): لا تبويبات، بل سطر واحد فوق شاشة التسجيل يعيده إلى الإقرار
// (8/11/2026، بطلب ZEKRI، بدل سطر تذكير المراجعة الأسبوعية).
export function AppNav({ hash, modules, locked, left }: { hash: string; modules: string[]; locked: boolean; left: number }) {
  const count = useAlertCount();
  const tabs: Tab[] = [];
  if (modules.includes('cheques')) {
    tabs.push(
      { id: 'deposit', label: 'الإيداع', href: '#cheques', Icon: Landmark },
      { id: 'all', label: 'الشيكات', href: '#cheques/all', Icon: List },
      { id: 'new', label: 'تسجيل', href: '#cheques/new', Icon: Plus, center: true },
      { id: 'alerts', label: 'التنبيهات', href: '#cheques/alerts', Icon: Bell },
    );
  }
  if (modules.includes('coll')) tabs.push({ id: 'coll', label: 'التحصيل', href: '#coll', Icon: HandCoins });
  const h = hash.replace(/^#/, '');
  // صفحات التفاصيل وشاشة الإقرار لها شريطها الثابت، فيختفي التنقل
  const detail = /\/c\//.test(h) || h.startsWith('coll/ack');
  const strip = locked && !detail;
  const shown = (tabs.length > 1 || strip) && !detail;
  const first = modules[0] === 'coll' ? 'coll' : 'deposit';
  const current = h.startsWith('coll') ? 'coll' : h === 'cheques/all' ? 'all' : h === 'cheques/alerts' ? 'alerts' : h === 'cheques/new' ? 'new' : h.startsWith('cheques') ? 'deposit' : first;
  const height = strip ? STRIP_H : NAV_H;
  useFixedBottom(height, shown);
  // الأشرطة الثابتة فوق التنقل (الإيداع والتسجيل) تقرأ ارتفاعه من --nav-h
  useEffect(() => {
    document.documentElement.style.setProperty('--nav-h', `${shown ? height : 0}px`);
  }, [shown, height]);
  if (!shown) return null;

  return (
    <nav aria-label="التنقل بين الشاشات" style={{ viewTransitionName: 'bottomnav' } as React.CSSProperties}
      className="bottomnav fixed inset-x-0 bottom-0 z-20 border-t border-line-strong bg-surface pb-[env(safe-area-inset-bottom)]">
      {strip ? (
        // سطر القفل: بقية التطبيق تنتظر إقرار الدين، والتسجيل وحده مفتوح
        <a href="#coll/ack" className="ack-strip flex min-h-11 items-center gap-2 border-s-3 border-s-brand bg-brand-tint px-4 text-sm font-semibold text-foreground no-underline active:bg-surface-alt">
          <span className="min-w-0 flex-1">إقرار الدين: بقي {customersWord(left)}. أكمله لتفتح باقي التطبيق.</span>
          <ChevronLeft aria-hidden className="size-4.5 flex-none text-soft" />
        </a>
      ) : null}
      {strip ? null : (
      <div className="flex">
      {tabs.map(({ id, label, href, Icon, center }) => {
        const on = id === current;
        return (
          <a key={id} href={href} data-view={id} aria-current={on ? 'page' : undefined}
            className={cn('tab relative flex min-h-[60px] flex-1 flex-col items-center justify-center gap-1 text-sm font-semibold text-muted no-underline active:bg-surface-alt',
              on && 'text-foreground')}>
            {/* علامة حمراء مائلة فوق التبويب الحالي، تنتقل بين التبويبات */}
            {on && !center ? <span aria-hidden style={{ viewTransitionName: 'tabmark' } as React.CSSProperties} className="cut-xs absolute -top-px h-1 w-10 bg-brand" /> : null}
            {center ? (
              // زر التسجيل: العمل الأكثر تكراراً، أحمر في الوسط قريباً من الإبهام
              <span className={cn('cut-sm flex size-9 items-center justify-center bg-brand text-white', on && 'ring-2 ring-foreground ring-offset-2 ring-offset-surface')}>
                <Icon aria-hidden className="size-6" />
              </span>
            ) : (
              <span className="relative inline-flex">
                <Icon aria-hidden className="size-5.5" />
                {id === 'alerts' && count ? <span className="num absolute -end-4 -top-1.5 min-w-5 bg-brand px-2 py-1 text-center text-sm leading-none text-white">{count}</span> : null}
              </span>
            )}
            <span className={cn(center && 'text-foreground')}>{label}</span>
          </a>
        );
      })}
      </div>
      )}
    </nav>
  );
}
