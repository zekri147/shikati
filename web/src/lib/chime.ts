// رنّة إشعار التسليم داخل التطبيق (24/11/2026، بطلب ZEKRI): نغمتان قصيرتان تُولَّدان بالصوت الرقمي (Web Audio)،
// دون ملف صوت. المتصفح لا يسمح بالصوت قبل أول لمسة في الصفحة، فيُجهَّز الصوت مع أول لمسة.
// إن لم يُسمح بالصوت ترد playChime بـ false، فيرن الهاتف بإشعاره العادي بدلها (web/public/sw.js).

type Ctx = AudioContext;
let ctx: Ctx | null = null;

function audio(): Ctx | null {
  if (ctx) return ctx;
  const C = window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!C) return null;
  try { ctx = new C(); } catch { return null; }
  return ctx;
}

// أول لمسة في الصفحة تفتح الصوت، فتعمل الرنّة بعدها دون لمس
export function unlockChimeOnFirstTouch() {
  const unlock = () => {
    const c = audio();
    if (c && c.state !== 'running') c.resume().catch(() => { /* يُحاول عند الرنّة */ });
    if (c?.state === 'running') {
      window.removeEventListener('pointerdown', unlock, true);
      window.removeEventListener('keydown', unlock, true);
    }
  };
  window.addEventListener('pointerdown', unlock, true);
  window.addEventListener('keydown', unlock, true);
}

function tone(c: Ctx, freq: number, start: number, len: number) {
  const osc = c.createOscillator();
  const gain = c.createGain();
  osc.type = 'sine';
  osc.frequency.value = freq;
  gain.gain.setValueAtTime(0.0001, start);
  gain.gain.exponentialRampToValueAtTime(0.35, start + 0.02);
  gain.gain.exponentialRampToValueAtTime(0.0001, start + len);
  osc.connect(gain).connect(c.destination);
  osc.start(start);
  osc.stop(start + len + 0.02);
}

// true إن رنّت فعلاً
export async function playChime(): Promise<boolean> {
  const c = audio();
  if (!c) return false;
  if (c.state !== 'running') {
    try { await Promise.race([c.resume(), new Promise((r) => setTimeout(r, 400))]); } catch { /* نكمل للفحص */ }
  }
  if (c.state !== 'running') return false;
  const t = c.currentTime + 0.02;
  tone(c, 880, t, 0.18);
  tone(c, 1318.5, t + 0.2, 0.32);
  try { navigator.vibrate?.([180, 90, 180]); } catch { /* غير مدعوم */ }
  return true;
}
