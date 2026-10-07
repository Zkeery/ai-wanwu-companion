import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import LifeActivityHistory from '@/components/life-activity-history';
import { parseRuntimeHistory, readRuntimeHistory, type RuntimeHistory, type RuntimeSnapshot, type RuntimeTask } from '@/lib/life-runtime';
import { ApiError } from '@/lib/api';
import { TOKEN_KEY } from '@/lib/auth';

vi.mock('@/lib/life-runtime', async original => ({ ...await original<typeof import('@/lib/life-runtime')>(), readRuntimeHistory: vi.fn() }));
const sid = '11111111-1111-4111-8111-111111111111';
const row = (n: number): RuntimeTask => ({ id: `aaaaaaaa-aaaa-4aaa-8aaa-${String(n).padStart(12, '0')}`, created_at: n, state: 'done', activity: 'rest', target_id: null, error_code: null, retry_at: 0 });
const page: RuntimeHistory = { origin: 'offline_fixture', space_id: sid, companion_id: '1', observed_at: 100, tasks: Array.from({ length: 20 }, (_, i) => row(30 - i)), next_before: `11:${row(11).id}` };
const next: RuntimeHistory = { ...page, tasks: [row(10), row(9)], next_before: null };
const snapshot: RuntimeSnapshot = { ...page, permission: { enabled: false, activities: [], revision: 0 }, present: true, next_allowed_at: 100 };
const open = () => fireEvent.click(screen.getByRole('button', { name: '查看活动记录' }));
beforeEach(() => { vi.clearAllMocks(); vi.mocked(readRuntimeHistory).mockResolvedValue(page); });
afterEach(() => localStorage.clear());

it('loads only when opened, appends the next page once and refreshes from the beginning', async () => {
  render(<LifeActivityHistory snapshot={snapshot} available />);
  expect(readRuntimeHistory).not.toHaveBeenCalled(); open(); await screen.findByText('已加载 20 条记录');
  let resolve!: (v: RuntimeHistory) => void;
  vi.mocked(readRuntimeHistory).mockImplementationOnce(() => new Promise(r => { resolve = r; }));
  const button = screen.getByRole('button', { name: '加载更早记录' }); fireEvent.click(button); fireEvent.click(button);
  expect(readRuntimeHistory).toHaveBeenCalledTimes(2);
  expect(readRuntimeHistory).toHaveBeenLastCalledWith(sid, page.next_before, expect.any(AbortSignal));
  await act(async () => resolve(next)); expect(screen.getByText('已加载 22 条记录')).toBeInTheDocument();
  expect(screen.getByText('已经是最早的记录了。')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: '更新活动记录' })); await screen.findByText('已加载 20 条记录');
  expect(readRuntimeHistory).toHaveBeenLastCalledWith(sid, undefined, expect.any(AbortSignal));
});

it('keeps existing rows after a failed older-page read and retries the same cursor', async () => {
  render(<LifeActivityHistory snapshot={snapshot} available />); open(); await screen.findByText('已加载 20 条记录');
  vi.mocked(readRuntimeHistory).mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce(next);
  fireEvent.click(screen.getByRole('button', { name: '加载更早记录' })); await screen.findByRole('alert');
  expect(screen.getByText('已加载 20 条记录')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: '加载更早记录' })); await screen.findByText('已加载 22 条记录');
  expect(vi.mocked(readRuntimeHistory).mock.calls.slice(1).map(call => call[1])).toEqual([page.next_before, page.next_before]);
});

it('clears private rows on loss of access and rejects cross-origin results', async () => {
  render(<LifeActivityHistory snapshot={snapshot} available />); open(); await screen.findByText('已加载 20 条记录');
  vi.mocked(readRuntimeHistory).mockResolvedValueOnce({ ...next, origin: 'real_provider' });
  fireEvent.click(screen.getByRole('button', { name: '加载更早记录' })); await screen.findByRole('alert');
  expect(screen.queryByText('已加载 22 条记录')).toBeNull();
  vi.mocked(readRuntimeHistory).mockRejectedValueOnce(new ApiError('forbidden', 403, 'forbidden'));
  fireEvent.click(screen.getByRole('button', { name: '更新活动记录' })); await screen.findByText(/暂时无法访问这些活动记录/);
  expect(screen.queryAllByRole('listitem')).toHaveLength(0);
});

it('aborts on close and ignores a late response or an account switch', async () => {
  let resolve!: (v: RuntimeHistory) => void;
  vi.mocked(readRuntimeHistory).mockImplementation(() => new Promise(r => { resolve = r; }));
  render(<LifeActivityHistory snapshot={snapshot} available />); open();
  const signal = vi.mocked(readRuntimeHistory).mock.calls[0][2]!;
  fireEvent.click(screen.getByRole('button', { name: '收起活动记录' })); await act(async () => resolve(page));
  expect(signal.aborted).toBe(true); expect(screen.queryByText('已加载 20 条记录')).toBeNull();
  open(); localStorage.setItem(TOKEN_KEY, 'new-account'); await act(async () => resolve(page));
  expect(screen.queryByText('已加载 20 条记录')).toBeNull();
});

it('distinguishes a failed first read from an empty history and preserves source labels', async () => {
  vi.mocked(readRuntimeHistory).mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce({ ...page, tasks: [], next_before: null });
  render(<LifeActivityHistory snapshot={snapshot} available />); open(); await screen.findByRole('alert');
  expect(screen.queryByText('还没有活动记录。')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: '更新活动记录' })); await screen.findByText('还没有活动记录。');
  expect(screen.getByText(/离线样例/)).toBeInTheDocument();
});

it('keeps a completed task explanation visible in saved history', async () => {
  const reason = '天色晚了，先好好休息。';
  const saved = { ...page, origin: 'real_provider' as const, tasks: [{ ...row(30), reason }], next_before: null };
  vi.mocked(readRuntimeHistory).mockResolvedValue(saved);
  render(<LifeActivityHistory snapshot={{ ...snapshot, origin: 'real_provider' }} available />);
  open();
  expect(await screen.findByText(`已保存的 AI 选择理由：${reason}`)).toBeVisible();
  expect(screen.getByText('已保存的AI活动结果。')).toBeVisible();
});

it('closes reads while the main snapshot is unavailable', async () => {
  const view = render(<LifeActivityHistory snapshot={snapshot} available />); open(); await screen.findByText('已加载 20 条记录');
  view.rerender(<LifeActivityHistory snapshot={snapshot} available={false} />);
  expect(screen.queryByRole('region', { name: '活动历史记录' })).toBeNull();
  await waitFor(() => expect(vi.mocked(readRuntimeHistory).mock.calls[0][2]?.aborted).toBe(true));
});

it('validates page order, cursor identity, provenance and the requested boundary', () => {
  expect(parseRuntimeHistory(page, sid)).toEqual(page);
  expect(parseRuntimeHistory(next, sid, page.next_before!)).toEqual(next);
  for (const value of [
    { ...page, next_before: `10:${row(10).id}` }, { ...page, tasks: page.tasks.slice(1) },
    { ...page, tasks: [...page.tasks].reverse() }, { ...page, tasks: [row(30), row(30)], next_before: null },
    { ...page, origin: 'unknown' }, { ...page, next_before: undefined },
    { ...next, tasks: [{ ...row(10), state: 'failed', activity: 'rest', error_code: 'worker_error' }] },
  ]) expect(() => parseRuntimeHistory(value, sid)).toThrow();
  expect(() => parseRuntimeHistory(page, sid, page.next_before!)).toThrow();
  expect(() => parseRuntimeHistory(page, 'another')).toThrow();
});
