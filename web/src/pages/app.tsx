import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Modal, ModalActions } from '@/components/ui/dialog';
import { ErrorBox, Footer, Main, Note, SkeletonList, TopBar, type MenuLink } from '@/components/shell';
import { api, errText, type Me } from '@/lib/api';
import { replaceHash, useHash } from '@/lib/hash';
import { load, save } from '@/lib/storage';
import { readCache, writeCache } from '@/lib/cache';
import { ChequesModule } from '@/features/cheques/ChequesModule';
import { CollModule } from '@/features/coll/CollModule';
import { AppNav } from '@/components/nav';
import { ackLeft, initAck, loadAckStatus, setAfterAck, useAckStatus } from '@/lib/ack';
import { toast } from '@/components/toast';
import { enablePasskey, passkeyOnDevice, passkeySupported } from '@/lib/passkey';
import { disablePush, enablePush, pushState, syncPush, testPush, type PushState } from '@/lib/push';

const MODULES: Record<string, React.ComponentType<{ me: Me; hash: string }>> = { cheques: ChequesModule, coll: CollModule };

// العنوان لحظة فتح التطبيق: فارغ عند الفتح من الأيقونة وبعد الدخول، وفيه الشاشة عند الفتح من إشعار أو رابط
const OPENED_AT = typeof location !== 'undefined' ? location.hash.replace(/^#/, '') : '';
// ما يبقى مفتوحاً للمندوب قبل أن ينهي إقرار الدين: شاشة الإقرار، وتسجيل الشيك (اختيار ZEKRI يوم 8/11/2026)
const ACK = '#coll/ack';
const REGISTER = '#cheques/new';
const LOCK_OPEN = [ACK, REGISTER];

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

  // إقرار الدين (8/11/2026، بطلب ZEKRI): المندوب الذي لم يُنهِ إقرار صورة الدورة لا يفتح إلا الإقرار والتسجيل.
  // المدير لا يُقفل عليه. الحالة الأخيرة محفوظة على الهاتف، فيعمل القفل فوراً، ثم تُحدَّث من الخادم.
  if (me) initAck(me.user.username);
  const ack = useAckStatus();
  const hasAck = !!me && !!me.user.rep_code && available.some((m) => m.id === 'coll');
  useAckRefresh(hasAck);
  const locked = hasAck && me!.user.role === 'rep' && ackLeft(ack) > 0;

  // شاشة البداية للمندوب (بطلب ZEKRI يوم 8/11/2026): التسجيل في كل فتح للتطبيق، أو الإقرار ما دام لم ينهه.
  // مرة واحدة عند الفتح، وقبل الرسم، فلا تظهر شاشة الإيداع لحظة. الفتح من إشعار أو رابط يبقى على شاشته.
  const landed = useRef(false);
  const autoHash = useRef('');
  useLayoutEffect(() => {
    if (!me || landed.current) return;
    landed.current = true;
    if (!OPENED_AT && me.user.role === 'rep') { autoHash.current = locked ? ACK : REGISTER; replaceHash(autoHash.current); }
  }, [me]);
  // القفل: أي شاشة أخرى تعود إلى الإقرار، وتُحفظ لتُفتح بعده. وإن وصلت الحالة بعد أن فتح التطبيق على التسجيل تلقائياً، يُنقل إلى الإقرار
  useLayoutEffect(() => {
    if (!locked) return;
    const auto = hash === REGISTER && autoHash.current === REGISTER;
    if (LOCK_OPEN.includes(hash) && !auto) return;
    if (!auto && hash && hash !== '#') {
      setAfterAck(hash);
      // بعد تسجيل شيك: رسالة النجاح نفسها تذكر أن الشيك يُفتح بعد الإقرار
      if (prevHash.current === REGISTER && hash.startsWith('#cheques/c/')) toast('تم تسجيل الشيك. أكمل إقرار الدين، ثم افتحه من آخر الشاشة.');
      else toast('أكمل إقرار الدين أولاً، ثم تُفتح لك الشاشة التي طلبتها.', 'warn');
    }
    autoHash.current = ACK;
    replaceHash(ACK);
  }, [locked, hash]);
  const prevHash = useRef(hash);
  useEffect(() => { prevHash.current = hash; }, [hash]);

  const wanted = hash.slice(1).split('/')[0];
  const mod = available.find((m) => m.id === wanted) || available[0];
  useEffect(() => { if (mod) document.title = mod.title; }, [mod?.id]);

  // روابط القائمة: الأقسام الأخرى، والإدارة للمدير، والمساعدة
  // الأقسام في شريط التنقل السفلي، فلا تُكرَّر في القائمة
  const links: MenuLink[] = [
    ...(me?.user.role === 'admin' ? [{ href: '/admin', label: 'الإدارة' }] : []),
    { href: '/?passkey=1', label: 'الدخول بالبصمة' },
    { href: '/?notify=1', label: 'إشعارات الهاتف' },
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
      {me ? <AppNav hash={hash} modules={available.map((m) => m.id)} locked={locked} left={ackLeft(ack)} /> : null}
      {/* الترحيب بعد القفل لا فوقه: ينتظر حالة الإقرار، فيراه المندوب حين يُفتح له التطبيق */}
      {me && (!hasAck || ack) && !locked && hash !== ACK ? <Welcome name={me.user.display_name} rep={me.user.role === 'rep'} /> : null}
      {me ? <PasskeyOffer /> : null}
      {me ? <NotifyOffer admin={me.user.role === 'admin'} /> : null}
    </>
  );
}

// حالة إقرار الدين لصاحب رمز المندوب: تُطلب عند الفتح، وعند العودة إلى التطبيق بعد خمس دقائق.
// شاشة الإقرار تحدّثها بعد كل جواب.
function useAckRefresh(on: boolean) {
  useEffect(() => {
    if (!on) return;
    let at = 0;
    const get = () => {
      at = Date.now();
      loadAckStatus().catch(() => { /* إن تعذّر الطلب تبقى الحالة الأخيرة */ });
    };
    get();
    const onVis = () => { if (document.visibilityState === 'visible' && Date.now() - at > 5 * 60_000) get(); };
    document.addEventListener('visibilitychange', onVis);
    return () => document.removeEventListener('visibilitychange', onVis);
  }, [on]);
}

// بطاقة ترحيب تظهر مرة واحدة على كل جهاز عند أول دخول: ثلاث خطوات، ومكان المساعدة
const WELCOME_KEY = 'shikati-welcome-seen';
function Welcome({ name, rep }: { name: string; rep: boolean }) {
  const [open, setOpen] = useState(() => load(WELCOME_KEY) !== '1');
  const close = () => { save(WELCOME_KEY, '1'); setOpen(false); };
  if (!open) return null;
  return (
    <Modal open={open} onClose={close} title={'مرحباً ' + name}>
      {rep ? (
        // المندوب (8/11/2026): التسجيل أولاً، ثم عملاؤه، ثم الإيداع، والإقرار كل أسبوعين
        <>
          <p>ميداني مكانك لعملائك وشيكاتهم. عملك فيه:</p>
          <ol className="my-1 mb-3 ps-6 [&>li]:my-2">
            <li>كل شيك تستلمه: زر «تسجيل» الأحمر في الأسفل، ثم «تصوير الشيك». أو من صفحة العميل: «سجّل شيكاً من هذا العميل».</li>
            <li>عملاؤك وديونهم وفواتيرهم في «التحصيل»، مع الاتصال وواتساب.</li>
            <li>الشيكات التي سلّمتها للبنك: في «الإيداع» المسها، ثم «أودعت المحدد».</li>
            <li>كل أسبوعين صباح السبت: أقِرّ بدين عملائك قبل أي عمل آخر.</li>
          </ol>
        </>
      ) : (
        <>
          <p>ميداني مكانك لشيكات العملاء وتحصيلهم. عمل الشيكات اليومي في ثلاث خطوات:</p>
          <ol className="my-1 mb-3 ps-6 [&>li]:my-2">
            <li>سلّم الشيكات للبنك، ثم المس في شاشة «الإيداع» كل شيك سلّمته.</li>
            <li>اضغط «أودعت المحدد» في أسفل الشاشة، ثم «تأكيد الإيداع».</li>
            <li>لتسجيل شيك استلمته: تبويب «تسجيل» في الأسفل، ثم «تصوير الشيك».</li>
          </ol>
        </>
      )}
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

// إشعارات الهاتف: تُعرض مرة واحدة بعد عرض البصمة (في فتح لاحق)، ومتى شاء الموظف من «القائمة» (العنوان ‎/?notify=1).
// البطاقة نفسها تعرض حالة الهاتف: غير مفعّلة، أو مفعّلة (مع التجربة والإيقاف)، أو ممنوعة، أو تحتاج التثبيت في آيفون.
const NOTIFY_KEY = 'shikati-notify-asked';
function NotifyOffer({ admin }: { admin: boolean }) {
  const asked = new URLSearchParams(location.search).get('notify') === '1';
  const [state, setState] = useState<PushState | null>(null);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  useEffect(() => {
    if (asked) history.replaceState(history.state, '', '/' + location.hash);
    syncPush();
    (async () => {
      const st = await pushState();
      if (asked) { setState(st); return; }
      // العرض التلقائي: مرة واحدة، بعد بطاقة الترحيب وعرض البصمة، وعلى هاتف يدعم الإشعارات
      if (st !== 'off' || load(NOTIFY_KEY) === '1' || load(WELCOME_KEY) !== '1') return;
      if (!passkeyOnDevice() && load(ASKED_KEY) !== '1' && await passkeySupported()) return;
      setState(st);
    })();
  }, []);
  const close = () => { save(NOTIFY_KEY, '1'); setState(null); setError(''); };
  async function run(what: 'enable' | 'test' | 'disable') {
    setBusy(what); setError('');
    try {
      if (what === 'enable') {
        const r = await enablePush();
        if (!r.ok) { if (r.error) setError(r.error); setState(await pushState()); return; }
        save(NOTIFY_KEY, '1'); setState(null);
        toast('فُعّلت الإشعارات على هذا الهاتف');
      } else if (what === 'test') {
        await testPush();
        setState(null);
        toast('أُرسل إشعار تجريبي. يصل خلال ثوانٍ.');
      } else {
        await disablePush();
        save(NOTIFY_KEY, '1'); setState(null);
        toast('أُوقفت الإشعارات على هذا الهاتف');
      }
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy('');
    }
  }
  if (!state) return null;
  const what = admin
    ? 'سُلّم إليك شيك، أو رُفض شيك، أو تأخر إيداع شيك في عهدتك، أو جاءت صورة دين عملائك للإقرار. وكل صباح ملخص تنبيهات اليوم.'
    : 'سُلّم إليك شيك، أو رُفض شيك لعميلك، أو تأخر إيداع شيك في عهدتك، أو جاءت صورة دين عملائك للإقرار.';
  return (
    <Modal open onClose={close} busy={!!busy} title="إشعارات الهاتف">
      {state === 'on' ? (
        <>
          <p>الإشعارات مفعّلة على هذا الهاتف. يصلك تنبيه حين {what}</p>
          <Note>إن لم يصل الإشعار التجريبي، تحقق أن إشعارات ميداني مسموحة في إعدادات الهاتف، وأن وضع «عدم الإزعاج» متوقف.</Note>
          <Button className="mt-3 w-full" disabled={!!busy} onClick={() => run('disable')}>{busy === 'disable' ? 'جارٍ الإيقاف…' : 'أوقف الإشعارات على هذا الهاتف'}</Button>
        </>
      ) : state === 'off' ? (
        <>
          <p>يصلك على هذا الهاتف تنبيه، حتى والتطبيق مغلق، حين {what}</p>
          <Note>يظهر في الإشعار اسم العميل والمبلغ. وتتوقف الإشعارات عند الخروج من التطبيق.</Note>
        </>
      ) : state === 'denied' ? (
        <p>منعت الإشعارات لميداني في هذا الهاتف. لتفعيلها: افتح إعدادات الهاتف، ثم التطبيقات، ثم ميداني (أو كروم)، ثم الإشعارات، واسمح بها. ثم عد إلى هنا.</p>
      ) : state === 'install' ? (
        <p>في آيفون تعمل الإشعارات بعد تثبيت ميداني على الشاشة الرئيسية: زر المشاركة في سفاري، ثم «إضافة إلى الشاشة الرئيسية»، ثم افتح ميداني من أيقونته وفعّل الإشعارات من «القائمة».</p>
      ) : (
        <p>متصفح هذا الهاتف لا يدعم الإشعارات. افتح ميداني من كروم، أو من أيقونته على الشاشة الرئيسية.</p>
      )}
      {error ? <p className="mt-2 text-base text-danger">{error}</p> : null}
      <ModalActions>
        {state === 'off' ? <Button variant="primary" disabled={!!busy} onClick={() => run('enable')}>{busy === 'enable' ? 'جارٍ التفعيل…' : 'فعّل الإشعارات'}</Button> : null}
        {state === 'on' ? <Button variant="primary" disabled={!!busy} onClick={() => run('test')}>{busy === 'test' ? 'جارٍ الإرسال…' : 'أرسل إشعاراً تجريبياً'}</Button> : null}
        <Button disabled={!!busy} onClick={close}>{state === 'off' ? 'ليس الآن' : 'إغلاق'}</Button>
      </ModalActions>
    </Modal>
  );
}
