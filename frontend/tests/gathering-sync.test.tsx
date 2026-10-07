import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ApiError } from '@/lib/api';
import { TOKEN_KEY } from '@/lib/auth';
import { gatherings, type Gathering } from '@/lib/gatherings';
import { useGatheringSync } from '@/lib/use-gathering-sync';

vi.mock('@/lib/gatherings', () => ({ gatherings: { read: vi.fn() } }));
const snapshot = { id: 'one', me: 'owner', closed: false, members: [{ id: 'owner' }] } as Gathering;
let visibility = 'visible';
beforeEach(() => {
  vi.useFakeTimers(); vi.clearAllMocks(); localStorage.setItem(TOKEN_KEY, 'session');
  visibility = 'visible';
  vi.spyOn(document, 'visibilityState', 'get').mockImplementation(() => visibility as DocumentVisibilityState);
  vi.mocked(gatherings.read).mockResolvedValue(snapshot);
});
afterEach(() => { vi.useRealTimers(); localStorage.clear(); });
function setup(initial = { spaceId: 'one' as string | null, accountToken: 'session', paused: false }) {
  const onSnapshot = vi.fn(), onUnavailable = vi.fn(), blocked = vi.fn(() => false);
  const hook = renderHook(props => useGatheringSync({ ...props, onSnapshot, onUnavailable, blocked }), { initialProps: initial });
  return { ...hook, onSnapshot, onUnavailable, blocked };
}
const tick = (ms: number) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });
const wake = () => act(async () => { window.dispatchEvent(new Event('focus')); });
async function hide(value: string) { await act(async () => { visibility = value; document.dispatchEvent(new Event('visibilitychange')); }); }

it('reads only the selected space every 15 seconds and passes an abort signal', async () => {
  const h = setup(); await tick(14999); expect(gatherings.read).not.toHaveBeenCalled();
  await tick(1); expect(gatherings.read).toHaveBeenCalledWith('one', expect.any(AbortSignal));
  expect(h.onSnapshot).toHaveBeenCalledWith(snapshot);
  await tick(15000); expect(gatherings.read).toHaveBeenCalledTimes(2);
  h.unmount(); await tick(60000); expect(gatherings.read).toHaveBeenCalledTimes(2);
});
it('does not poll a list with no selected space', async () => {
  setup({ spaceId: null, accountToken: 'session', paused: false }); await tick(60000); await wake();
  expect(gatherings.read).not.toHaveBeenCalled();
});
it('stops while hidden and reads immediately when visible or focused', async () => {
  const h = setup(); await hide('hidden'); await tick(60000); expect(gatherings.read).not.toHaveBeenCalled();
  await hide('visible'); expect(h.onSnapshot).toHaveBeenCalledOnce();
  await wake(); expect(h.onSnapshot).toHaveBeenCalledTimes(2);
});
it('pauses editing and submitting, aborts an old read, and reads on resume', async () => {
  let resolve!: (g: Gathering) => void; let signal!: AbortSignal;
  vi.mocked(gatherings.read).mockImplementationOnce((_id, s) => { signal = s!; return new Promise(r => { resolve = r; }); });
  const h = setup(); await tick(15000);
  h.rerender({ spaceId: 'one', accountToken: 'session', paused: true }); expect(signal.aborted).toBe(true);
  await act(async () => resolve(snapshot)); expect(h.onSnapshot).not.toHaveBeenCalled();
  await tick(60000); expect(gatherings.read).toHaveBeenCalledOnce();
  h.rerender({ spaceId: 'one', accountToken: 'session', paused: false }); await tick(0);
  expect(h.onSnapshot).toHaveBeenCalledOnce();
});
it('never runs concurrent reads when focus arrives during a request', async () => {
  let resolve!: (g: Gathering) => void;
  vi.mocked(gatherings.read).mockImplementationOnce(() => new Promise(r => { resolve = r; }));
  setup(); await tick(15000); await wake(); await wake(); expect(gatherings.read).toHaveBeenCalledOnce();
  await act(async () => resolve(snapshot)); await tick(0); expect(gatherings.read).toHaveBeenCalledTimes(2);
});
it('ignores a response after leaving a space', async () => {
  let resolve!: (g: Gathering) => void;
  vi.mocked(gatherings.read).mockImplementationOnce(() => new Promise(r => { resolve = r; }));
  const h = setup(); await tick(15000); h.rerender({ spaceId: null, accountToken: 'session', paused: false });
  await act(async () => resolve(snapshot)); expect(h.onSnapshot).not.toHaveBeenCalled();
});
it('ignores a previous account response and stops after a token change', async () => {
  let resolve!: (g: Gathering) => void;
  vi.mocked(gatherings.read).mockImplementationOnce(() => new Promise(r => { resolve = r; }));
  const h = setup(); await tick(15000); localStorage.setItem(TOKEN_KEY, 'other');
  await act(async () => resolve(snapshot)); await tick(60000); await wake();
  expect(h.onSnapshot).not.toHaveBeenCalled(); expect(gatherings.read).toHaveBeenCalledOnce();
});
it('ignores a request if a submission lock is already active before rerender', async () => {
  const h = setup(); h.blocked.mockReturnValue(true); await tick(15000); await wake();
  expect(gatherings.read).not.toHaveBeenCalled();
});
it('keeps the last snapshot, backs off 30/60 seconds and recovers to 15 seconds', async () => {
  vi.mocked(gatherings.read).mockRejectedValueOnce(new Error('offline')).mockRejectedValueOnce(new Error('offline')).mockResolvedValue(snapshot);
  const h = setup(); await tick(15000); expect(h.result.current.stale).toBe(true); expect(h.onSnapshot).not.toHaveBeenCalled();
  await tick(29999); expect(gatherings.read).toHaveBeenCalledOnce(); await tick(1); expect(gatherings.read).toHaveBeenCalledTimes(2);
  await tick(59999); expect(gatherings.read).toHaveBeenCalledTimes(2); await tick(1);
  expect(h.result.current.stale).toBe(false); expect(h.onSnapshot).toHaveBeenCalledOnce();
  await tick(15000); expect(gatherings.read).toHaveBeenCalledTimes(4);
});
it.each([401, 403, 404])('clears inaccessible data and stops reads for HTTP %s', async status => {
  vi.mocked(gatherings.read).mockRejectedValue(new ApiError('unavailable', status, 'test'));
  const h = setup(); await tick(15000); expect(h.onUnavailable).toHaveBeenCalledOnce(); await tick(60000); await wake();
  expect(gatherings.read).toHaveBeenCalledOnce();
});
it.each([{ ...snapshot, closed: true }, { ...snapshot, members: [] }])('clears a closed space or a space without the current member', async g => {
  vi.mocked(gatherings.read).mockResolvedValue(g); const h = setup(); await tick(15000);
  expect(h.onUnavailable).toHaveBeenCalledOnce(); expect(h.onSnapshot).not.toHaveBeenCalled();
});
it('rejects a response for another space and resets stale presentation when switching spaces', async () => {
  vi.mocked(gatherings.read).mockResolvedValue({ ...snapshot, id: 'wrong' });
  const h = setup(); await tick(15000); expect(h.result.current.stale).toBe(true); expect(h.onSnapshot).not.toHaveBeenCalled();
  h.rerender({ spaceId: 'two', accountToken: 'session', paused: false }); expect(h.result.current.stale).toBe(false);
});
it('aborts a pending read when hidden and ignores its late result', async () => {
  let resolve!: (g: Gathering) => void; let signal!: AbortSignal;
  vi.mocked(gatherings.read).mockImplementationOnce((_id, s) => { signal = s!; return new Promise(r => { resolve = r; }); });
  const h = setup(); await tick(15000); await hide('hidden'); expect(signal.aborted).toBe(true);
  await act(async () => resolve(snapshot)); expect(h.onSnapshot).not.toHaveBeenCalled();
  await hide('visible'); expect(h.onSnapshot).toHaveBeenCalledOnce();
});
it('times out a stalled read after 3 seconds and schedules a bounded retry', async () => {
  vi.spyOn(AbortSignal, 'timeout').mockImplementation(ms => {
    const controller = new AbortController(); setTimeout(() => controller.abort(new DOMException('timeout', 'TimeoutError')), ms); return controller.signal;
  });
  vi.mocked(gatherings.read).mockImplementationOnce((_id, signal) => new Promise((_r, reject) => signal!.addEventListener('abort', () => reject(signal!.reason))));
  const h = setup(); await tick(15000); await tick(2999); expect(h.result.current.stale).toBe(false);
  await tick(1); expect(h.result.current.stale).toBe(true); await tick(30000); expect(h.onSnapshot).toHaveBeenCalledOnce();
});
