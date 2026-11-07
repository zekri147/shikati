import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Modal, ModalActions } from '@/components/ui/dialog';
import { ErrorBox, Footer, Main, Note, SkeletonList, TopBar, type MenuLink } from '@/components/shell';
import { api, errText, type Me } from '@/lib/api';
import { useHash } from '@/lib/hash';
import { load, save } from '@/lib/storage';
import { readCache, writeCache } from '@/lib/cache';
import { ChequesModule } from '@/features/cheques/ChequesModule';
import { CollModule } from '@/features/coll/CollModule';
import { AppNav } from '@/components/nav';
import { toast } from '@/components/toast';
import { enablePasskey, passkeyOnDevice, passkeySupported } from '@/lib/passkey';

const MODULES: Record<string, React.ComponentType<{ me: Me; hash: string }>> = { cheques: ChequesModule, coll: CollModule };

// الهيكل العام: يقرأ المستخدم والأقسام المتاحة له، ويعرض القسم المطلوب بحسب العنوان بعد #
export function AppPage() {
  const hash = useHash();
  // المستخدم من آخر فتح: تظهر الشاشة فوراً، ويُتحقق من الجلسة في الخلفية (الجلسة المنتهية تعيد إلى الدخول)
  const [me, setMe] = useState<Me | null>(() => readCache<Me>('me')?.data || null);
  const [error, setError] = useState('');
  useEffect(() => {
    api<Me>('/api/me').then((m) => { setMe(m); writeCache('me', m); }).catch((e) => setMe((old) => { if (!old) setError(errText(e)); return old; }));
  }, []);

  const available = me ? me.modules.filter((m) => MODULES[m.id]) : [];
  const wanted = hash.slice(1).split('/')[0];
  const mod = available.find((m) => m.id === wanted) || available[0];
  useEffect(() => { if (mod) document.title = mod.title; }, [mod?.id]);

  // روابط القائمة: الأقسام الأخرى، والإدارة للمدير، والمساعدة
  // الأقسام في شريط التنقل السفلي، فلا تُكرَّر في القائمة
  const links: MenuLink[] = [
    ...(me?.user.role === 'admin' ? [{ href: '/admin', label: 'الإدارة' }] : []),
    { href: '/?passkey=1', label: 'الدخول بالبصمة' },
    { href: '/help', label: 'المساعدة وطريقة الاستعمال' },
  ];
  const Mod = mod ? MODULES[mod.id] : null;

  return (
    <>
      <TopBar name={me?.user.display_name} links={links} />
      <Main>
        {error ? <ErrorBox>{error}</ErrorBox>
          : !me ? <SkeletonList className="mt-0" />
            : !Mod ? <p className="text-muted">لا توجد أقسام متاحة لحسابك.</p>
              : <Mod key={mod!.id} me={me} hash={hash} />}
      </Main>
      <Footer />
      {me ? <AppNav hash={hash} modules={available.map((m) => m.id)} /> : null}
      {me && mod?.id === 'cheques' ? <Welcome name={me.user.display_name} /> : null}
      {me ? <PasskeyOffer /> : null}
    </>
  );
}

// بطاقة ترحيب تظهر مرة واحدة على كل جهاز عند أول دخول: ثلاث خطوات، ومكان المساعدة
const WELCOME_KEY = 'shikati-welcome-seen';
function Welcome({ name }: { name: string }) {
  const [open, setOpen] = useState(() => load(WELCOME_KEY) !== '1');
  const close = () => { save(WELCOME_KEY, '1'); setOpen(false); };
  if (!open) return null;
  return (
    <Modal open={open} onClose={close} title={'مرحباً ' + name}>
      <p>شيكاتي مكانك الوحيد لشيكات العملاء. عملك اليومي في ثلاث خطوات:</p>
      <ol className="my-1 mb-3 ps-6 [&>li]:my-2">
        <li>سلّم الشيكات للبنك، ثم المس في شاشة «الإيداع» كل شيك سلّمته.</li>
        <li>اضغط «أودعت المحدد» في أسفل الشاشة، ثم «تأكيد الإيداع».</li>
        <li>لتسجيل شيك استلمته: تبويب «تسجيل» في الأسفل، ثم «تصوير الشيك».</li>
      </ol>
      <Note>المساعدة في زر «القائمة» أعلى الشاشة، متى احتجتها.</Note>
      <ModalActions>
        <Button variant="primary" onClick={close} autoFocus>فهمت، ابدأ</Button>
        <Button asChild><a href="/help" onClick={() => save(WELCOME_KEY, '1')}>اقرأ المساعدة</a></Button>
      </ModalActions>
    </Modal>
  );
}

// عرض الدخول بالبصمة: مرة واحدة بعد الدخول على هاتف يدعمها ولم تُفعَّل عليه (بعد بطاقة الترحيب)،
// ومتى شاء الموظف من «القائمة» (العنوان ‎/?passkey=1). البصمة لا تخرج من الهاتف.
const ASKED_KEY = 'shikati-passkey-asked';
function PasskeyOffer() {
  const asked = new URLSearchParams(location.search).get('passkey') === '1';
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    if (asked) history.replaceState(history.state, '', '/' + location.hash);
    if (!asked && (passkeyOnDevice() || load(ASKED_KEY) === '1' || load(WELCOME_KEY) !== '1')) return;
    passkeySupported().then((ok) => {
      if (ok) setOpen(true);
      else if (asked) toast('هذا الهاتف لا يدعم الدخول بالبصمة من المتصفح، أو لا قفل بالبصمة فيه.', 'warn');
    });
  }, []);
  const close = () => { save(ASKED_KEY, '1'); setOpen(false); };
  async function run() {
    setBusy(true); setError('');
    const r = await enablePasskey();
    setBusy(false);
    if (r.ok) { save(ASKED_KEY, '1'); setOpen(false); toast('فُعّل الدخول بالبصمة على هذا الهاتف'); return; }
    if (r.error) setError(r.error);
  }
  if (!open) return null;
  return (
    <Modal open={open} onClose={close} busy={busy} title="الدخول بالبصمة">
      <p>{passkeyOnDevice() ? 'البصمة مفعّلة على هذا الهاتف. يمكنك تفعيلها من جديد إن حُذفت.' : 'ادخل في المرة القادمة ببصمتك أو بوجهك بدل الاسم والرمز السري.'}</p>
      <Note>البصمة لا تخرج من هاتفك ولا تُرسل إلى التطبيق. والرمز السري يبقى صالحاً. إن ضاع الهاتف، يحذف المدير بصمته من صفحة الإدارة.</Note>
      {error ? <p className="mt-2 text-base text-danger">{error}</p> : null}
      <ModalActions>
        <Button variant="primary" disabled={busy} onClick={run}>{busy ? 'جارٍ التفعيل…' : 'فعّل البصمة'}</Button>
        <Button disabled={busy} onClick={close}>ليس الآن</Button>
      </ModalActions>
    </Modal>
  );
}
