'use client';
import { useEffect, useRef, useState } from 'react';
import type { RuntimeSnapshot } from './life-runtime';

/** A saved task expires locally even when the next server response never arrives. */
export function useCurrentActivity(snapshot: RuntimeSnapshot | null | undefined) {
  const current = snapshot?.current_activity;
  const [expired, setExpired] = useState<string | null>(null);
  const deadline = useRef<{ id: string; at: number } | null>(null);
  const id = current ? `${snapshot!.space_id}:${snapshot!.companion_id}:${current.task_id}` : null;
  const remaining = current ? Math.max(0, current.expires_at - snapshot!.observed_at) * 1000 : 0;
  useEffect(() => {
    if (!id) { deadline.current = null; return; }
    const until = performance.now() + remaining;
    deadline.current = { id, at: deadline.current?.id === id ? Math.min(deadline.current.at, until) : until };
    const timer = setTimeout(() => setExpired(id), Math.max(0, deadline.current.at - performance.now()));
    return () => clearTimeout(timer);
  }, [id, remaining]);
  return current && remaining > 0 && expired !== id ? current : null;
}
