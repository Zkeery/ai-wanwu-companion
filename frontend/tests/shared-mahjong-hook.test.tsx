import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { useSharedMahjong } from '@/lib/use-shared-mahjong';
import { sharedMahjongApi } from '@/lib/shared-mahjong';
import { setToken } from '@/lib/auth';
import { mahjongGroupId, sharedMahjongFixture, mahjongTime } from './shared-mahjong-fixtures';
vi.mock('@/lib/shared-mahjong', async original => ({ ...await original<typeof import('@/lib/shared-mahjong')>(), sharedMahjongApi: { read: vi.fn(), command: vi.fn() } }));
const options = () => ({ gatheringId: mahjongGroupId, ownedCharacterIds: [1], session: 'unit-mahjong-session', enabled: true });
const settle = async () => { await act(async () => {}); };
beforeEach(() => { vi.resetAllMocks(); vi.useFakeTimers(); vi.setSystemTime(mahjongTime); setToken('unit-mahjong-session'); vi.mocked(sharedMahjongApi.read).mockResolvedValue(sharedMahjongFixture()); });
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });
it('does not start a first game or reopen an ended game without an explicit user action', async () => {
  vi.mocked(sharedMahjongApi.read).mockResolvedValue({ ...sharedMahjongFixture(), game: null, can_start: true });
  const first = renderHook(() => useSharedMahjong(options())); await settle(); await act(async () => vi.advanceTimersByTimeAsync(60000)); expect(sharedMahjongApi.command).not.toHaveBeenCalled(); first.unmount();
  const ended = sharedMahjongFixture(); ended.game!.status = 'ended'; ended.can_new_round = true; vi.mocked(sharedMahjongApi.read).mockResolvedValue(ended);
  renderHook(() => useSharedMahjong(options())); await settle(); await act(async () => vi.advanceTimersByTimeAsync(60000)); expect(sharedMahjongApi.command).not.toHaveBeenCalled();
});
it('advances an existing game once when the server deadline is reached', async () => {
  const next = sharedMahjongFixture(); next.game!.revision = 2; next.game!.next_due_at_ms += 10000; vi.mocked(sharedMahjongApi.command).mockResolvedValue(next);
  const { result } = renderHook(() => useSharedMahjong(options())); await settle(); await act(async () => vi.advanceTimersByTimeAsync(999)); expect(sharedMahjongApi.command).not.toHaveBeenCalled();
  await act(async () => vi.advanceTimersByTimeAsync(1)); expect(sharedMahjongApi.command).toHaveBeenCalledTimes(1); expect(vi.mocked(sharedMahjongApi.command).mock.calls[0][2]).toBe('advance'); expect(result.current.snapshot?.game?.revision).toBe(2);
});
it('stops automatic writes on an unknown failure, only reads back and waits for manual refresh', async () => {
  vi.mocked(sharedMahjongApi.command).mockRejectedValue(new Error('ack unknown'));
  const { result } = renderHook(() => useSharedMahjong(options())); await settle(); await act(async () => vi.advanceTimersByTimeAsync(1000));
  expect(result.current.needsRefresh).toBe(true); expect(sharedMahjongApi.command).toHaveBeenCalledTimes(1); expect(sharedMahjongApi.read).toHaveBeenCalledTimes(2);
  await act(async () => vi.advanceTimersByTimeAsync(60000)); expect(sharedMahjongApi.command).toHaveBeenCalledTimes(1);
  const current = sharedMahjongFixture(); current.server_now_ms = Date.now(); current.game!.observed_at_ms = Date.now(); vi.mocked(sharedMahjongApi.read).mockResolvedValue(current);
  await act(async () => result.current.refresh()); await act(async () => vi.advanceTimersByTimeAsync(1)); expect(sharedMahjongApi.command).toHaveBeenCalledTimes(2);
});
it('a competing revision is reconciled by GET without resending the old advance', async () => {
  const next = sharedMahjongFixture(); next.game!.revision = 2; next.game!.next_due_at_ms += 20000;
  vi.mocked(sharedMahjongApi.read).mockResolvedValueOnce(sharedMahjongFixture()).mockResolvedValue(next); vi.mocked(sharedMahjongApi.command).mockRejectedValue(new Error('409 conflict'));
  const { result } = renderHook(() => useSharedMahjong(options())); await settle(); await act(async () => vi.advanceTimersByTimeAsync(1000));
  expect(result.current.snapshot?.game?.revision).toBe(2); expect(result.current.needsRefresh).toBe(false); expect(sharedMahjongApi.command).toHaveBeenCalledTimes(1);
});
it('does not read or advance when capability is disabled or the account changes', async () => {
  const view = renderHook(({ enabled }) => useSharedMahjong({ ...options(), enabled }), { initialProps: { enabled: false } }); await settle(); expect(sharedMahjongApi.read).not.toHaveBeenCalled();
  view.rerender({ enabled: true }); await settle(); act(() => setToken('unit-another-session')); await act(async () => vi.advanceTimersByTimeAsync(2000)); expect(sharedMahjongApi.command).not.toHaveBeenCalled();
});
it('keeps an unknown stop across hiding and showing instead of resending on focus', async () => {
  let hidden = false; vi.spyOn(document, 'hidden', 'get').mockImplementation(() => hidden);
  vi.mocked(sharedMahjongApi.command).mockRejectedValue(new Error('unknown'));
  const { result } = renderHook(() => useSharedMahjong(options())); await settle(); await act(async () => vi.advanceTimersByTimeAsync(1000)); expect(result.current.needsRefresh).toBe(true);
  act(() => { hidden = true; document.dispatchEvent(new Event('visibilitychange')); }); await settle();
  act(() => { hidden = false; document.dispatchEvent(new Event('visibilitychange')); }); await settle();
  await act(async () => vi.advanceTimersByTimeAsync(60000)); expect(result.current.needsRefresh).toBe(true); expect(sharedMahjongApi.command).toHaveBeenCalledTimes(1);
});
it('does not let a late older GET replace a committed newer command', async () => {
  let resolve!: (value: ReturnType<typeof sharedMahjongFixture>) => void;
  vi.mocked(sharedMahjongApi.read).mockResolvedValueOnce(sharedMahjongFixture()).mockReturnValueOnce(new Promise(done => { resolve = done; }));
  const next = sharedMahjongFixture(); next.game!.revision = 2; next.game!.next_due_at_ms += 10000; vi.mocked(sharedMahjongApi.command).mockResolvedValue(next);
  const { result } = renderHook(() => useSharedMahjong(options())); await settle(); let refresh!: Promise<void>;
  act(() => { refresh = result.current.refresh(); }); await act(async () => vi.advanceTimersByTimeAsync(1000)); expect(result.current.snapshot?.game?.revision).toBe(2);
  await act(async () => { resolve(sharedMahjongFixture()); await refresh; }); expect(result.current.snapshot?.game?.revision).toBe(2); expect(sharedMahjongApi.command).toHaveBeenCalledTimes(1);
});
it('two clients converge on one server revision after an expected conflict, without retrying the old step', async () => {
  const next = sharedMahjongFixture(); next.game!.revision = 2; next.game!.next_due_at_ms += 10000;
  let reads = 0; vi.mocked(sharedMahjongApi.read).mockImplementation(async () => ++reads <= 2 ? sharedMahjongFixture() : next);
  vi.mocked(sharedMahjongApi.command).mockResolvedValueOnce(next).mockRejectedValueOnce(new Error('409'));
  const a = renderHook(() => useSharedMahjong(options())), b = renderHook(() => useSharedMahjong(options())); await settle();
  await act(async () => vi.advanceTimersByTimeAsync(1000)); expect(sharedMahjongApi.command).toHaveBeenCalledTimes(2);
  expect(a.result.current.snapshot?.game?.revision).toBe(2); expect(b.result.current.snapshot?.game?.revision).toBe(2); expect(b.result.current.needsRefresh).toBe(false);
  expect(vi.mocked(sharedMahjongApi.command).mock.calls.every(call => call[0].game?.revision === 1)).toBe(true);
});
it('does not advance from a stale snapshot after its refresh fails', async () => {
  const { result } = renderHook(() => useSharedMahjong(options())); await settle(); vi.mocked(sharedMahjongApi.read).mockRejectedValue(new Error('read unavailable'));
  await act(async () => result.current.refresh()); await act(async () => vi.advanceTimersByTimeAsync(5000));
  expect(result.current.needsRefresh).toBe(true); expect(sharedMahjongApi.command).not.toHaveBeenCalled(); expect(result.current.snapshot?.game?.revision).toBe(1);
});
