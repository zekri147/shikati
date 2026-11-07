import { useEffect, useRef, useState } from 'react';
import * as D from '@radix-ui/react-dialog';
import { Button } from '@/components/ui/button';
import { useBackClose } from '@/lib/back';
import { cn } from '@/lib/utils';

const MAX_SIDE = 1600;

// تدوير صورة باتجاه عقارب الساعة على لوح رسم، فيظهر الشيك أفقياً ومعتدلاً
export function rotateImage(img: HTMLImageElement, deg: number, type = 'image/jpeg') {
  const turn = deg === 90 || deg === 270;
  const canvas = document.createElement('canvas');
  canvas.width = turn ? img.naturalHeight : img.naturalWidth;
  canvas.height = turn ? img.naturalWidth : img.naturalHeight;
  const ctx = canvas.getContext('2d')!;
  ctx.translate(canvas.width / 2, canvas.height / 2);
  ctx.rotate((deg * Math.PI) / 180);
  ctx.drawImage(img, -img.naturalWidth / 2, -img.naturalHeight / 2);
  return canvas.toDataURL(type, 0.88);
}

export function rotateDataUrl(src: string, deg: number): Promise<string> {
  if (!deg) return Promise.resolve(src);
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(rotateImage(img, deg));
    img.onerror = () => reject(new Error('تعذّر تدوير الصورة.'));
    img.src = src;
  });
}

// تصغير الصورة في الهاتف قبل إرسالها، فتصل أسرع وتبقى مقروءة
export function shrink(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('تعذّرت قراءة الصورة من الهاتف.'));
    reader.onload = () => {
      const img = new Image();
      img.onerror = () => reject(new Error('صيغة الصورة غير مدعومة. صوّر الشيك من جديد.'));
      img.onload = () => {
        const scale = Math.min(1, MAX_SIDE / Math.max(img.width, img.height));
        const canvas = document.createElement('canvas');
        canvas.width = Math.round(img.width * scale);
        canvas.height = Math.round(img.height * scale);
        canvas.getContext('2d')!.drawImage(img, 0, 0, canvas.width, canvas.height);
        resolve(canvas.toDataURL('image/jpeg', 0.85));
      };
      img.src = String(reader.result);
    };
    reader.readAsDataURL(file);
  });
}

// عارض الصورة بملء الشاشة: «إغلاق» وزر الرجوع في الهاتف يعيدانك، واللمس يكبّر الصورة أو يعيدها
export function Viewer({ src, onClose }: { src: string | null; onClose: () => void }) {
  const [zoom, setZoom] = useState(false);
  const open = !!src;
  useBackClose(open, onClose);
  useEffect(() => { if (!open) setZoom(false); }, [open]);
  return (
    <D.Root open={open} onOpenChange={(v) => { if (!v) onClose(); }}>
      <D.Portal>
        <D.Content aria-describedby={undefined} className="fixed inset-0 z-[55] flex h-dvh w-screen flex-col bg-bar text-white focus:outline-none">
          <D.Title className="sr-only">صورة الشيك</D.Title>
          <div className="flex flex-none gap-2 px-3 pb-2 pt-[max(10px,env(safe-area-inset-top))]">
            <Button variant="primary" className="flex-1 py-3 text-lg" onClick={onClose}>إغلاق</Button>
            <Button variant="plain" className="flex-1 border-line-on-dark bg-transparent py-3 text-lg text-white" onClick={() => setZoom(!zoom)}>{zoom ? 'تصغير' : 'تكبير'}</Button>
          </div>
          <div className={cn('flex flex-1 touch-pan-x touch-pan-y touch-pinch-zoom items-center justify-center overflow-auto', zoom && 'block')}>
            {src ? <img src={src} alt="صورة الشيك" onClick={() => setZoom(!zoom)}
              className={cn('cursor-zoom-in object-contain', zoom ? 'w-[220%] max-w-none cursor-zoom-out' : 'max-h-full max-w-full')} /> : null}
          </div>
        </D.Content>
      </D.Portal>
    </D.Root>
  );
}

// الصورة المرفقة بالدفعة، معتدلة دائماً: الخادم يعرف اتجاهها (يحدّده كلود مرة واحدة)
export function ChequeImage({ id, hasImage, v, size }: { id: string; hasImage: boolean; v?: string; size: 'thumb' | 'mid' | 'big' }) {
  const base = `/api/m/cheques/image/${encodeURIComponent(id)}`;
  const src0 = base + (v ? `?v=${encodeURIComponent(v)}` : '');
  const [src, setSrc] = useState(src0);
  const [failed, setFailed] = useState(false);
  const [view, setView] = useState<string | null>(null);
  const rotation = useRef<Promise<number> | null>(null);
  const done = useRef(false);

  useEffect(() => {
    setSrc(src0); setFailed(false); done.current = false;
    if (!hasImage) return;
    rotation.current = fetch(base + '/rotation', { credentials: 'same-origin' })
      .then((r) => (r.ok ? r.json() : { rotation: 0 })).then((j) => Number(j.rotation) || 0).catch(() => 0);
  }, [src0, hasImage]);

  const box = size === 'thumb' ? 'h-14' : size === 'mid' ? 'h-[72px]' : 'max-h-[280px]';
  if (!hasImage) return <div className={cn('flex items-center justify-center bg-surface-alt p-2 text-center text-sm text-soft', size === 'big' ? 'p-4' : size === 'mid' ? 'h-[72px]' : 'h-14')}>لا صورة</div>;
  if (failed) return <div className={cn('flex items-center justify-center bg-warning-tint p-2 text-center text-sm text-foreground', size === 'big' ? 'p-4' : size === 'mid' ? 'h-[72px]' : 'h-14')}>تعذّر تحميل الصورة</div>;
  return (
    <>
      <a href={src} title="تكبير الصورة" className="block" onClick={(e) => { e.preventDefault(); e.stopPropagation(); setView(src); }}>
        <img src={src} alt="صورة الشيك" decoding="async"
          className={cn('block w-full border border-line bg-surface-alt object-contain', box)}
          onError={() => setFailed(true)}
          onLoad={async (e) => {
            if (done.current || !rotation.current) return;
            done.current = true;
            const img = e.currentTarget;
            const deg = await rotation.current;
            if (!deg || !img.isConnected) return;
            try { setSrc(rotateImage(img, deg)); } catch { /* تبقى كما هي */ }
          }} />
      </a>
      <Viewer src={view} onClose={() => setView(null)} />
    </>
  );
}
