import { useSyncExternalStore } from 'react';
import { api } from './api';
import { readCache, writeCache } from './cache';

// حالة إقرار الدين للمستخدم (8/11/2026، بطلب ZEKRI): كم عميلاً في صورة الدورة، وكم أقرّ أو اعترض.
// منها القفل على المندوب في هيكل التطبيق، وسطر التذكير فوق شاشة التسجيل. تُحفظ على الهاتف فيعمل القفل فوراً عند الفتح.
export type AckStatus = {
  cycle: string; next: string; state: 'ready' | 'pending' | 'error'; taken_at: string | null;
  total: number; done: number; disputes: number;
};

let user = '';
let status: AckStatus | null = null;
const subs = new Set<() => void>();
const key = () => 'ack-status:' + user;

function set(s: AckStatus | null) {
  status = s;
  if (s && user) writeCache(key(), s);
  subs.forEach((f) => f());
}

export function initAck(username: string) {
  if (user === username) return;
  user = username;
  set(readCache<AckStatus>(key())?.data || null);
}

export async function loadAckStatus(): Promise<AckStatus> {
  const s = await api<AckStatus>('/api/m/coll/status');
  set(s);
  return s;
}

// بعد كل جواب في شاشة الإقرار
export function setAckCounts(cycle: string, done: number, total: number) {
  if (status && status.cycle === cycle) set({ ...status, done, total });
}

export const useAckStatus = () => useSyncExternalStore((cb) => { subs.add(cb); return () => { subs.delete(cb); }; }, () => status);
export const ackLeft = (s: AckStatus | null) => (s && s.state === 'ready' ? Math.max(0, s.total - s.done) : 0);

// الشاشة التي طلبها المندوب والتطبيق مقفل (من إشعار أو رابط، أو الشيك الذي سجّله): تُفتح له بعد الإقرار
let after = '';
export const setAfterAck = (h: string) => { after = h; };
export const peekAfterAck = () => after;
export const takeAfterAck = () => { const h = after; after = ''; return h; };
