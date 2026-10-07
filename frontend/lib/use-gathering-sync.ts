'use client';
import { useEffect, useRef, useState } from 'react';
import { ApiError } from './api';
import { getToken } from './auth';
import { gatherings, type Gathering } from './gatherings';

type Options = {
  spaceId: string | null; accountToken: string; paused: boolean;
  blocked: () => boolean; onSnapshot: (snapshot: Gathering) => void;
  onUnavailable: () => void;
};

export function useGatheringSync({ spaceId, accountToken, paused, blocked, onSnapshot, onUnavailable }: Options) {
  const [status, setStatus] = useState({ spaceId, accountToken, stale: false });
  const previous = useRef<{ id: string | null; paused: boolean }>({ id: null, paused: false });
  useEffect(() => {
    const resuming = previous.current.id === spaceId && previous.current.paused;
    previous.current = { id: spaceId, paused };
    if (!spaceId || paused) return;
    let active = true, pending = false, wakeRequested = false, failures = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let controller: AbortController | null = null;
    const visible = () => document.visibilityState !== 'hidden';
    const valid = () => active && visible() && getToken() === accountToken && !blocked();
    function schedule(delay: number) {
      clearTimeout(timer);
      if (valid()) timer = setTimeout(() => { void read(); }, delay);
    }
    async function read() {
      if (!valid() || pending) return;
      pending = true; clearTimeout(timer);
      const request = new AbortController(); controller = request;
      try {
        const signal = AbortSignal.any([request.signal, AbortSignal.timeout(3000)]);
        const snapshot = await gatherings.read(spaceId!, signal);
        if (!valid() || request.signal.aborted) return;
        if (signal.aborted) throw signal.reason;
        if (snapshot.id !== spaceId) throw new Error('共同近况来自其他空间');
        if (snapshot.closed || !snapshot.members.some(m => m.id === snapshot.me)) { active = false; onUnavailable(); return; }
        failures = 0; setStatus({ spaceId, accountToken, stale: false }); onSnapshot(snapshot);
      } catch (cause) {
        if (!valid() || request.signal.aborted) return;
        if (cause instanceof ApiError && [401, 403, 404].includes(cause.status)) { active = false; onUnavailable(); return; }
        failures++; setStatus({ spaceId, accountToken, stale: true });
      } finally {
        pending = false;
        if (valid() && (wakeRequested || !request.signal.aborted)) {
          const delay = wakeRequested ? 0 : Math.min(60000, 15000 * 2 ** Math.min(failures, 2));
          wakeRequested = false; schedule(delay);
        }
      }
    }
    function wake() {
      clearTimeout(timer);
      if (!visible()) { wakeRequested = false; controller?.abort(); return; }
      if (!valid()) return;
      if (pending) { wakeRequested = true; return; }
      void read();
    }
    window.addEventListener('focus', wake);
    document.addEventListener('visibilitychange', wake);
    schedule(resuming ? 0 : 15000);
    return () => {
      active = false; clearTimeout(timer); controller?.abort();
      window.removeEventListener('focus', wake); document.removeEventListener('visibilitychange', wake);
    };
  }, [spaceId, accountToken, paused, blocked, onSnapshot, onUnavailable]);
  return { stale: status.spaceId === spaceId && status.accountToken === accountToken && status.stale };
}
