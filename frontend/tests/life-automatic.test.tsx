import React from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import LifeRuntimePanel from '@/components/life-runtime-panel';
import { parseRuntime, runtimeApi, type RuntimeSnapshot } from '@/lib/life-runtime';
import { AUTH_CHANGED, TOKEN_KEY } from '@/lib/auth';

vi.mock('@/lib/life-runtime', async original => ({ ...await original<typeof import('@/lib/life-runtime')>(), runtimeApi: { read: vi.fn(), save: vi.fn(), schedule: vi.fn(), run: vi.fn(), automatic: vi.fn() } }));
const sid = '11111111-1111-4111-8111-111111111111';
const ready: RuntimeSnapshot = { origin: 'offline_fixture', space_id: sid, companion_id: '1', permission: { enabled: true, activities: ['rest'], revision: 1 }, present: true, observed_at: 100, next_allowed_at: 100, tasks: [], automatic: { enabled: false, revision: 0, next_at: 0, today_count: 0, daily_limit: 2 } };
const enabled: RuntimeSnapshot = { ...ready, automatic: { ...ready.automatic!, enabled: true, revision: 1, next_at: 100 } };
beforeEach(() => { vi.resetAllMocks(); vi.mocked(runtimeApi.read).mockResolvedValue(ready); vi.mocked(runtimeApi.automatic).mockResolvedValue(enabled); });
afterEach(() => { vi.useRealTimers(); localStorage.clear(); });

it('requires explicit start after permission is saved, ignores double clicks and sends the saved revision', async () => {
  render(<LifeRuntimePanel spaceId={sid} />); const start = await screen.findByRole('button', { name: '开启每天自动体验' });
  expect(runtimeApi.automatic).not.toHaveBeenCalled();
  fireEvent.click(start); fireEvent.click(start);
  await screen.findByText('每天自动体验 · 已开启');
  expect(runtimeApi.automatic).toHaveBeenCalledExactlyOnceWith(sid, 0, true, expect.any(AbortSignal));
  expect(runtimeApi.schedule).not.toHaveBeenCalled(); expect(runtimeApi.run).not.toHaveBeenCalled();
});

it.each([
  { ...ready, permission: { ...ready.permission, enabled: false } }, { ...ready, present: false },
])('blocks start when permission or presence is missing', async value => {
  vi.mocked(runtimeApi.read).mockResolvedValue(value);
  render(<LifeRuntimePanel spaceId={sid} />);
  expect(await screen.findByRole('button', { name: '开启每天自动体验' })).toBeDisabled();
});

it('blocks unsaved activity changes for start but allows stopping with a dirty draft', async () => {
  render(<LifeRuntimePanel spaceId={sid} />); await screen.findByRole('button', { name: '开启每天自动体验' });
  fireEvent.click(screen.getByLabelText('散步'));
  expect(screen.getByRole('button', { name: '开启每天自动体验' })).toBeDisabled();
  vi.mocked(runtimeApi.read).mockResolvedValue(enabled); fireEvent.click(screen.getByRole('button', { name: '刷新状态' }));
  const stop = await screen.findByRole('button', { name: '停止每天自动体验' });
  expect(stop).toBeEnabled(); vi.mocked(runtimeApi.automatic).mockResolvedValue({ ...ready, automatic: { ...ready.automatic!, revision: 2 } });
  fireEvent.click(stop); await screen.findByText('每天自动体验 · 已关闭');
  expect(runtimeApi.automatic).toHaveBeenLastCalledWith(sid, 1, false, expect.any(AbortSignal));
  expect(screen.getByLabelText('散步')).toBeChecked();
});

it('polls enabled automatic work even with no tasks, and stops reading while hidden', async () => {
  vi.useFakeTimers(); vi.mocked(runtimeApi.read).mockResolvedValue(enabled);
  await act(async () => { render(<LifeRuntimePanel spaceId={sid} />); });
  await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
  expect(runtimeApi.read).toHaveBeenCalledTimes(2);
  const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
  act(() => document.dispatchEvent(new Event('visibilitychange')));
  await act(async () => { await vi.advanceTimersByTimeAsync(6000); });
  expect(runtimeApi.read).toHaveBeenCalledTimes(2); visibility.mockRestore();
});

it('reconciles an uncertain write without resubmitting and clears state after account changes', async () => {
  localStorage.setItem(TOKEN_KEY, 'first');
  render(<LifeRuntimePanel spaceId={sid} />); const start = await screen.findByRole('button', { name: '开启每天自动体验' });
  vi.mocked(runtimeApi.automatic).mockRejectedValueOnce(new Error('response lost')); vi.mocked(runtimeApi.read).mockResolvedValue(enabled);
  fireEvent.click(start); await screen.findByText('每天自动体验 · 已开启');
  expect(runtimeApi.automatic).toHaveBeenCalledTimes(1);
  act(() => { localStorage.setItem(TOKEN_KEY, 'another'); window.dispatchEvent(new Event(AUTH_CHANGED)); });
  expect(screen.queryByRole('region', { name: '每天自动体验' })).toBeNull();
});

it('explains viewing downgrade on poll failure and offers explicit opt-in again after recovery', async () => {
  vi.useFakeTimers(); vi.mocked(runtimeApi.read).mockResolvedValue(enabled);
  await act(async () => { render(<LifeRuntimePanel spaceId={sid} />); });
  vi.mocked(runtimeApi.read).mockRejectedValueOnce(new Error('offline'));
  await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
  expect(screen.getByText(/已停止本页观看状态的续报/)).toBeVisible();
  expect(screen.queryByRole('button', { name: '观看时继续自动体验' })).toBeNull();
  await act(async () => { await vi.advanceTimersByTimeAsync(4000); });
  expect(screen.getByRole('button', { name: '观看时继续自动体验' })).toBeEnabled();
});

it('accepts legacy snapshots but strictly validates automatic provenance, counts and revisions', () => {
  expect(parseRuntime(ready, sid)).toEqual(ready);
  expect(parseRuntime({ ...ready, automatic: undefined }, sid).automatic).toBeUndefined();
  for (const automatic of [
    { ...ready.automatic!, today_count: 3 }, { ...ready.automatic!, today_count: -1 },
    { ...ready.automatic!, enabled: 'true' }, { ...ready.automatic!, enabled: true },
    { ...ready.automatic!, next_at: 100 }, { ...ready.automatic!, daily_limit: 10 },
  ]) expect(() => parseRuntime({ ...ready, automatic }, sid)).toThrow();
  expect(() => parseRuntime({ ...ready, origin: 'real_provider' }, sid)).toThrow();
});

it('allows real automatic scheduling only with a checked budget and offers a separate viewing opt-in', async () => {
  const live: RuntimeSnapshot = { ...ready, origin: 'real_provider', automatic: { ...ready.automatic!, budget_available: true } };
  expect(parseRuntime(live, sid)).toEqual(live);
  vi.mocked(runtimeApi.read).mockResolvedValue(live);
  vi.mocked(runtimeApi.automatic).mockResolvedValue({ ...live, automatic: { ...live.automatic!, enabled: true, revision: 1, next_at: 100 } });
  render(<LifeRuntimePanel spaceId={sid} />);
  const start = await screen.findByRole('button', { name: '开启每天 AI 自动安排' });
  expect(screen.getByText(/每轮可能产生模型费用，只使用已授权预算/)).toBeVisible();
  expect(runtimeApi.automatic).not.toHaveBeenCalled();
  fireEvent.click(start);
  await screen.findByRole('button', { name: '停止每天 AI 自动安排' });
  expect(runtimeApi.automatic).toHaveBeenCalledExactlyOnceWith(sid, 0, true, expect.any(AbortSignal));
  expect(screen.queryByRole('button', { name: '观看时继续自动体验' })).toBeNull();
  expect(screen.getByRole('button', { name: '观看时继续 AI 安排' })).toBeEnabled();
  expect(runtimeApi.run).not.toHaveBeenCalled();
});

it.each([false, true])('blocks unfunded real opt-in but allows stopping when already enabled: %s', async enabled => {
  const live: RuntimeSnapshot = { ...ready, origin: 'real_provider', automatic: { ...ready.automatic!, enabled, revision: enabled ? 1 : 0, next_at: enabled ? 100 : 0, budget_available: false } };
  vi.mocked(runtimeApi.read).mockResolvedValue(live);
  render(<LifeRuntimePanel spaceId={sid} />);
  const button = await screen.findByRole('button', { name: enabled ? '停止每天 AI 自动安排' : '开启每天 AI 自动安排' });
  expect(screen.getByText(/已授权预算不足以执行下一轮/)).toBeVisible();
  if (enabled) {
    expect(button).toBeEnabled();
    expect(screen.getByRole('button', { name: '观看时继续 AI 安排' })).toBeDisabled();
  } else expect(button).toBeDisabled();
});

it('accepts bounded real viewing and rejects malformed expiry or wrong-origin budget flags', () => {
  for (const budget_available of [undefined, null, 'true', 1]) {
    expect(() => parseRuntime({ ...ready, origin: 'real_provider', automatic: { ...ready.automatic!, budget_available } }, sid)).toThrow();
  }
  expect(parseRuntime({ ...enabled, origin: 'real_provider', automatic: { ...enabled.automatic!, budget_available: true, viewing_until: 150 } }, sid).automatic?.viewing_until).toBe(150);
  expect(() => parseRuntime({ ...enabled, origin: 'real_provider', automatic: { ...enabled.automatic!, budget_available: true, viewing_until: 176 } }, sid)).toThrow();
  expect(() => parseRuntime({ ...ready, automatic: { ...ready.automatic!, budget_available: true } }, sid)).toThrow();
});
