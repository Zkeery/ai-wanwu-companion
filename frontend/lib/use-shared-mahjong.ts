'use client';
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { errorText } from './api';
import { getToken } from './auth';
import { sharedMahjongApi, type SharedMahjongAction, type SharedMahjongSnapshot } from './shared-mahjong';

const subscribe = (changed: () => void) => { document.addEventListener('visibilitychange', changed); window.addEventListener('focus', changed); return () => { document.removeEventListener('visibilitychange', changed); window.removeEventListener('focus', changed); }; };
const visible = () => !document.hidden;
const monotonic = () => performance.now();
type Options = { gatheringId: string; ownedCharacterIds: readonly number[]; session: string | null; enabled: boolean };
type Saved = { scope: string; snapshot: SharedMahjongSnapshot; receivedAt: number };

export function useSharedMahjong({ gatheringId, ownedCharacterIds, session, enabled }: Options) {
  const ownerKey = [...ownedCharacterIds].sort((a, b) => a - b).join(','), scope = JSON.stringify([gatheringId, ownerKey, session]);
  const shown = useSyncExternalStore(subscribe, visible, () => false);
  const [saved, setSaved] = useState<Saved | null>(null), [busy, setBusy] = useState(false), [error, setError] = useState(''), [needsRefresh, setNeedsRefresh] = useState(false);
  const active = useRef(''), latest = useRef<Saved | null>(null), lock = useRef(false), serial = useRef(0), applied = useRef(0);
  const blocked = useRef<{ game: string | null; revision: number } | null>(null), requests = useRef(new Set<AbortController>());
  const valid = useCallback(() => active.current === scope && enabled && !!session && getToken() === session && !document.hidden, [scope, enabled, session]);
  const accept = useCallback((snapshot: SharedMahjongSnapshot, sequence: number) => {
    if (!valid() || sequence < applied.current) return false;
    const old = latest.current?.scope === scope ? latest.current.snapshot : null;
    if (old?.game?.game_id === snapshot.game?.game_id && (snapshot.game?.revision ?? 0) < (old?.game?.revision ?? 0)) return false;
    applied.current = sequence;
    const next = { scope, snapshot, receivedAt: monotonic() }; latest.current = next; setSaved(next);
    if (blocked.current && (snapshot.game?.game_id !== blocked.current.game || (snapshot.game?.revision ?? 0) > blocked.current.revision)) { blocked.current = null; setNeedsRefresh(false); }
    return true;
  }, [scope, valid]);
  const read = useCallback(async (manual = false) => {
    if (!valid()) return;
    const controller = new AbortController(), sequence = ++serial.current; requests.current.add(controller);
    try {
      const snapshot = await sharedMahjongApi.read(gatheringId, ownerKey ? ownerKey.split(',').map(Number) : [], controller.signal);
      if (!valid() || controller.signal.aborted) return;
      if (!accept(snapshot, sequence)) return;
      if (manual) { blocked.current = null; setNeedsRefresh(false); }
      if (!blocked.current) setError('');
    } catch (cause) { if (valid() && !controller.signal.aborted) {
      const current = latest.current?.scope === scope ? latest.current.snapshot.game : null;
      blocked.current = { game: current?.game_id ?? null, revision: current?.revision ?? 0 }; setNeedsRefresh(true); setError(errorText(cause));
    } }
    finally { requests.current.delete(controller); }
  }, [gatheringId, ownerKey, valid, accept, scope]);
  const command = useCallback(async (action: SharedMahjongAction) => {
    const current = latest.current;
    if (!valid() || lock.current || !current || current.scope !== scope || blocked.current) return;
    const snapshot = current.snapshot, game = snapshot.game;
    if (action === 'start' ? !snapshot.can_start || game !== null : action === 'new_round' ? !snapshot.can_new_round || game?.status === 'playing' :
      !game || game.status !== 'playing' || !game.can_advance || snapshot.server_now_ms + Math.max(0, monotonic() - current.receivedAt) < game.next_due_at_ms) return;
    lock.current = true; setBusy(true); setError('');
    const controller = new AbortController(), sequence = ++serial.current; requests.current.add(controller);
    try {
      const next = await sharedMahjongApi.command(snapshot, ownerKey ? ownerKey.split(',').map(Number) : [], action, crypto.randomUUID(), controller.signal);
      if (valid() && !controller.signal.aborted) accept(next, sequence);
    } catch (cause) {
      if (active.current !== scope || getToken() !== session || controller.signal.aborted) return;
      blocked.current = { game: game?.game_id ?? null, revision: game?.revision ?? 0 }; setNeedsRefresh(true); setError(errorText(cause));
      if (valid()) await read();
    } finally { requests.current.delete(controller); lock.current = false; if (active.current === scope && getToken() === session) setBusy(false); }
  }, [scope, valid, ownerKey, accept, read, session]);
  useEffect(() => {
    active.current = scope; latest.current = null; lock.current = false; blocked.current = null; applied.current = 0;
    const pending = requests.current;
    queueMicrotask(() => { if (active.current === scope) { setBusy(false); setError(''); setNeedsRefresh(false); } });
    return () => { active.current = ''; for (const controller of pending) controller.abort(); pending.clear(); };
  }, [scope]);
  useEffect(() => { let current = true; queueMicrotask(() => { if (current && enabled && shown && session) void read(); }); return () => { current = false; }; }, [scope, enabled, shown, session, read]);
  const snapshot = saved?.scope === scope ? saved.snapshot : null;
  useEffect(() => {
    if (!enabled || !shown || !session) return;
    const timer = setInterval(() => { if (!lock.current) void read(); }, 10000);
    return () => clearInterval(timer);
  }, [enabled, shown, session, read]);
  useEffect(() => {
    if (!enabled || !shown || busy || needsRefresh || saved?.scope !== scope || !snapshot?.game || snapshot.game.status !== 'playing' || !snapshot.game.can_advance) return;
    const due = snapshot.game.next_due_at_ms - snapshot.server_now_ms - Math.max(0, monotonic() - saved.receivedAt);
    const timer = setTimeout(() => { void command('advance'); }, Math.min(2147483647, Math.max(0, due)));
    return () => clearTimeout(timer);
  }, [enabled, shown, busy, needsRefresh, saved, snapshot, scope, command]);
  return { snapshot, busy, error, needsRefresh, refresh: () => read(true), start: () => command('start'), newRound: () => command('new_round') };
}
