// بناء الواجهة: React وTailwind ومكونات Radix، كلها تُجمَّع في ملفات داخل الموقع
// فلا يُحمَّل أي ملف من خارجه (سياسة أمان المحتوى في web/public/_headers).
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { fileURLToPath } from 'node:url';

const r = (p: string) => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  root: r('./web'),
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: [
      { find: '@', replacement: r('./web/src') },
      // يمنع وسم <style> الذي تضيفه نوافذ Radix لقفل التمرير (انظر web/src/shims/remove-scroll-bar.ts)
      { find: /^react-remove-scroll-bar$/, replacement: r('./web/src/shims/remove-scroll-bar.ts') },
    ],
  },
  build: {
    outDir: r('./dist'),
    emptyOutDir: true,
    // لا ملفات صغيرة مضمّنة كنص base64 داخل الشيفرة: كل ملف من الموقع نفسه
    assetsInlineLimit: 0,
    rollupOptions: {
      input: {
        app: r('./web/app.html'),
        admin: r('./web/admin.html'),
        login: r('./web/login.html'),
        setup: r('./web/setup.html'),
        help: r('./web/help.html'),
      },
    },
  },
});
