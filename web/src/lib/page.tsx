import * as React from 'react';
import { createRoot } from 'react-dom/client';
import { DirectionProvider } from '@radix-ui/react-direction';
import { Toaster } from '@/components/toast';
import { applyTheme, storedTheme } from './theme';
import '@/index.css';

// تشغيل صفحة: الوضع المحفوظ قبل الرسم، واتجاه من اليمين لليسار لكل مكونات Radix، والرسائل القصيرة
export function mountPage(node: React.ReactNode) {
  applyTheme(storedTheme());
  const el = document.getElementById('root')!;
  createRoot(el).render(
    <>
      <DirectionProvider dir="rtl">
        {node}
        <Toaster />
      </DirectionProvider>
    </>,
  );
  // عامل الخدمة لتثبيت التطبيق على الهاتف
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => { navigator.serviceWorker.register('/sw.js').catch(() => { /* يعمل بدونه */ }); });
    // لمس إشعار والتطبيق مفتوح: عامل الخدمة يطلب فتح الشيك أو الشاشة المقصودة
    navigator.serviceWorker.addEventListener('message', (e) => {
      if (e.data?.type === 'open' && typeof e.data.hash === 'string') location.hash = e.data.hash;
    });
  }
}
