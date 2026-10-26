import type { LoadedMotion } from './private-motion';
import type { Activity } from './life-simulation';

type Choice = Activity | 'default';

// Owned by one open preview, never shared between accounts or persisted.
export function createMotionPreviewCache(scope = '') {
  const loaded = new Map<string, LoadedMotion>();
  const pending = new Set<AbortController>();
  let generation = 0;
  return {
    async load(choice: Choice, signal: AbortSignal, read: (signal: AbortSignal) => Promise<LoadedMotion>): Promise<LoadedMotion> {
      signal.throwIfAborted();
      const key = JSON.stringify([scope, choice]);
      const cached = loaded.get(key);
      if (cached) return { asset: cached.asset, dispose: () => {} };
      const controller = new AbortController(), started = generation;
      pending.add(controller);
      const abort = () => controller.abort(signal.reason);
      signal.addEventListener('abort', abort, { once: true });
      try {
        const result = await read(controller.signal);
        if (signal.aborted || controller.signal.aborted || started !== generation) {
          result.dispose();
          throw signal.reason ?? controller.signal.reason ?? new DOMException('Aborted', 'AbortError');
        }
        if (!result.asset) return result;
        const existing = loaded.get(key);
        if (existing) result.dispose();
        else loaded.set(key, result);
        return { asset: (existing ?? result).asset, dispose: () => {} };
      } finally {
        signal.removeEventListener('abort', abort);
        pending.delete(controller);
      }
    },
    clear() {
      generation++;
      for (const controller of pending) controller.abort();
      pending.clear();
      for (const result of loaded.values()) result.dispose();
      loaded.clear();
    },
  };
}
