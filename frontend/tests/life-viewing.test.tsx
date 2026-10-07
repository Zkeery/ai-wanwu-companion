import React from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import LifeViewingControl from '@/components/life-viewing-control';
import { runtimeApi, parseRuntime, type RuntimeSnapshot } from '@/lib/life-runtime';
import { AUTH_CHANGED, TOKEN_KEY } from '@/lib/auth';

vi.mock('@/lib/life-runtime', async original => ({ ...await original<typeof import('@/lib/life-runtime')>(), runtimeApi: { viewing: vi.fn() } }));
const sid = '11111111-1111-4111-8111-111111111111';
const button = () => screen.getByRole('button', { name: '观看时继续自动体验' });
beforeEach(() => { vi.useFakeTimers(); vi.resetAllMocks(); vi.mocked(runtimeApi.viewing).mockResolvedValue({ lease_id: sid, expires_at: 175 }); });
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); localStorage.clear(); });

it('starts only on explicit opt-in and renews the same lease every 30 seconds', async () => {
  const { rerender, unmount } = render(<LifeViewingControl spaceId={sid} revision={1} disabled={false} />);
  expect(runtimeApi.viewing).not.toHaveBeenCalled();
  await act(async () => fireEvent.click(button()));
  expect(screen.getByText('观看时自动体验已开启。')).toBeVisible();
  const lease = vi.mocked(runtimeApi.viewing).mock.calls[0][1];
  expect(runtimeApi.viewing).toHaveBeenCalledExactlyOnceWith(sid, lease, 1, true, expect.any(AbortSignal));
  rerender(<LifeViewingControl spaceId={sid} revision={1} disabled={false} />);
  await act(async () => { await vi.advanceTimersByTimeAsync(30000); });
  expect(runtimeApi.viewing).toHaveBeenCalledTimes(2);
  expect(vi.mocked(runtimeApi.viewing).mock.calls[1][1]).toBe(lease);
  unmount(); expect(runtimeApi.viewing).toHaveBeenLastCalledWith(sid, lease, 1, false);
});

it('closes hidden-page lease, resumes a different lease and does not renew hidden pages', async () => {
  const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
  render(<LifeViewingControl spaceId={sid} revision={1} disabled={false} />);
  await act(async () => fireEvent.click(button()));
  const old = vi.mocked(runtimeApi.viewing).mock.calls[0][1];
  visibility.mockReturnValue('hidden');
  act(() => document.dispatchEvent(new Event('visibilitychange')));
  expect(runtimeApi.viewing).toHaveBeenLastCalledWith(sid, old, 1, false);
  await act(async () => { await vi.advanceTimersByTimeAsync(90000); });
  expect(runtimeApi.viewing).toHaveBeenCalledTimes(2);
  visibility.mockReturnValue('visible');
  await act(async () => document.dispatchEvent(new Event('visibilitychange')));
  expect(vi.mocked(runtimeApi.viewing).mock.calls[2][1]).not.toBe(old);
});

it('stops after failed renewal without retrying and permits explicit restart', async () => {
  render(<LifeViewingControl spaceId={sid} revision={1} disabled={false} />);
  await act(async () => fireEvent.click(button()));
  vi.mocked(runtimeApi.viewing).mockRejectedValueOnce(new Error('timeout'));
  await act(async () => { await vi.advanceTimersByTimeAsync(30000); });
  expect(screen.getByText(/观看状态未能确认/)).toBeVisible();
  const count = vi.mocked(runtimeApi.viewing).mock.calls.length;
  await act(async () => { await vi.advanceTimersByTimeAsync(90000); });
  expect(runtimeApi.viewing).toHaveBeenCalledTimes(count);
  await act(async () => fireEvent.click(button()));
  expect(screen.getByText('观看时自动体验已开启。')).toBeVisible();
});

it('ignores late opening response after stop and never renews it', async () => {
  let resolve!: (value: { lease_id: string; expires_at: number }) => void;
  vi.mocked(runtimeApi.viewing).mockImplementationOnce(() => new Promise(r => { resolve = r; }));
  render(<LifeViewingControl spaceId={sid} revision={1} disabled={false} />);
  fireEvent.click(button());
  fireEvent.click(screen.getByRole('button', { name: '停止本页观看体验' }));
  await act(async () => { resolve({ lease_id: sid, expires_at: 175 }); await vi.advanceTimersByTimeAsync(90000); });
  expect(runtimeApi.viewing).toHaveBeenCalledTimes(2);
  expect(screen.queryByText('观看时自动体验已开启。')).toBeNull();
});

it('does not use another account token to release or renew an old lease', async () => {
  localStorage.setItem(TOKEN_KEY, 'first');
  render(<LifeViewingControl spaceId={sid} revision={1} disabled={false} />);
  await act(async () => fireEvent.click(button()));
  act(() => { localStorage.setItem(TOKEN_KEY, 'second'); window.dispatchEvent(new Event(AUTH_CHANGED)); });
  await act(async () => { await vi.advanceTimersByTimeAsync(90000); });
  expect(runtimeApi.viewing).toHaveBeenCalledTimes(1);
  expect(screen.getByText(/登录状态已变化/)).toBeVisible();
});

it('blocks starting with a dirty draft but always permits stop', async () => {
  const { rerender } = render(<LifeViewingControl spaceId={sid} revision={1} disabled />);
  expect(button()).toBeDisabled();
  rerender(<LifeViewingControl spaceId={sid} revision={1} disabled={false} />);
  await act(async () => fireEvent.click(button()));
  rerender(<LifeViewingControl spaceId={sid} revision={1} disabled />);
  expect(screen.getByRole('button', { name: '停止本页观看体验' })).toBeEnabled();
});

it('accepts legacy status and rejects invalid or unbounded viewing expiry', () => {
  const value: RuntimeSnapshot = { origin: 'offline_fixture', space_id: sid, companion_id: '1', permission: { enabled: true, activities: ['rest'], revision: 1 }, present: true, observed_at: 100, next_allowed_at: 100, tasks: [], automatic: { enabled: true, revision: 1, next_at: 100, today_count: 0, daily_limit: 2 } };
  expect(parseRuntime(value, sid)).toEqual(value);
  for (const until of [-1, 100, 176, '175']) expect(() => parseRuntime({ ...value, automatic: { ...value.automatic, viewing_until: until } }, sid)).toThrow();
  for (const until of [0, 175]) expect(parseRuntime({ ...value, automatic: { ...value.automatic, viewing_until: until } }, sid).automatic?.viewing_until).toBe(until);
});

it('releases on pagehide without visibilitychange and requires opt-in after pageshow', async () => {
  render(<LifeViewingControl spaceId={sid} revision={1} disabled={false} />);
  await act(async () => fireEvent.click(button()));
  const lease = vi.mocked(runtimeApi.viewing).mock.calls[0][1];
  act(() => window.dispatchEvent(new Event('pagehide')));
  expect(runtimeApi.viewing).toHaveBeenLastCalledWith(sid, lease, 1, false);
  act(() => window.dispatchEvent(new Event('pageshow')));
  await act(async () => { await vi.advanceTimersByTimeAsync(90000); });
  expect(runtimeApi.viewing).toHaveBeenCalledTimes(2);
  expect(button()).toBeEnabled();
  await act(async () => fireEvent.click(button()));
  expect(vi.mocked(runtimeApi.viewing).mock.calls[2][1]).not.toBe(lease);
});

it('cannot revive viewing from a late opening response after pagehide', async () => {
  let finish!: (value: { lease_id: string; expires_at: number }) => void;
  vi.mocked(runtimeApi.viewing).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  render(<LifeViewingControl spaceId={sid} revision={1} disabled={false} />);
  fireEvent.click(button());
  act(() => window.dispatchEvent(new Event('pagehide')));
  await act(async () => { finish({ lease_id: sid, expires_at: 175 }); await vi.advanceTimersByTimeAsync(90000); });
  expect(runtimeApi.viewing).toHaveBeenCalledTimes(2);
  expect(screen.queryByText('观看时自动体验已开启。')).toBeNull();
  expect(button()).toBeEnabled();
});

it('requires separate real-mode opt-in after explaining fees and releases on hide', async () => {
  const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
  render(<LifeViewingControl spaceId={sid} revision={1} disabled={false} live />);
  expect(screen.getByText(/观看时可能增加模型调用和费用，仍受已授权预算限制/)).toBeVisible();
  expect(runtimeApi.viewing).not.toHaveBeenCalled();
  await act(async () => fireEvent.click(screen.getByRole('button', { name: '观看时继续 AI 安排' })));
  expect(screen.getByText('观看时 AI 自动安排已开启。')).toBeVisible();
  const lease = vi.mocked(runtimeApi.viewing).mock.calls[0][1];
  visibility.mockReturnValue('hidden');
  act(() => document.dispatchEvent(new Event('visibilitychange')));
  expect(runtimeApi.viewing).toHaveBeenLastCalledWith(sid, lease, 1, false);
  await act(async () => { await vi.advanceTimersByTimeAsync(90000); });
  expect(runtimeApi.viewing).toHaveBeenCalledTimes(2);
});

it('stops real viewing renewal on budget rejection and blocks reopening without budget', async () => {
  const { rerender } = render(<LifeViewingControl spaceId={sid} revision={1} disabled={false} live />);
  await act(async () => fireEvent.click(screen.getByRole('button', { name: '观看时继续 AI 安排' })));
  rerender(<LifeViewingControl spaceId={sid} revision={1} disabled live />);
  expect(screen.getByRole('button', { name: '停止本页 AI 观看模式' })).toBeEnabled();
  vi.mocked(runtimeApi.viewing).mockRejectedValueOnce(new Error('budget exhausted'));
  await act(async () => { await vi.advanceTimersByTimeAsync(30000); });
  expect(screen.getByRole('button', { name: '观看时继续 AI 安排' })).toBeDisabled();
  const count = vi.mocked(runtimeApi.viewing).mock.calls.length;
  await act(async () => { await vi.advanceTimersByTimeAsync(90000); });
  expect(runtimeApi.viewing).toHaveBeenCalledTimes(count);
});
