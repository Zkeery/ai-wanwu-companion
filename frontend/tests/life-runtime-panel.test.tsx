import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import LifeRuntimePanel from '@/components/life-runtime-panel';
import { runtimeApi, parseRuntime, type RuntimeSnapshot, type RuntimeTask } from '@/lib/life-runtime';
import { TOKEN_KEY } from '@/lib/auth';

vi.mock('@/lib/life-runtime', async original => ({ ...await original<typeof import('@/lib/life-runtime')>(), runtimeApi: { read: vi.fn(), save: vi.fn(), schedule: vi.fn(), run: vi.fn() } }));
const sid = '11111111-1111-4111-8111-111111111111', other = '22222222-2222-4222-8222-222222222222';
const tid = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const empty: RuntimeSnapshot = { origin: 'offline_fixture', space_id: sid, companion_id: '1', permission: { enabled: false, activities: [], revision: 0 }, present: true, observed_at: 100, next_allowed_at: 100, tasks: [] };
const enabled: RuntimeSnapshot = { ...empty, permission: { enabled: true, activities: ['rest'], revision: 1 } };
const task: RuntimeTask = { id: tid, state: 'queued', created_at: 100, retry_at: 0, activity: null, target_id: null, error_code: null };
const queued: RuntimeSnapshot = { ...enabled, next_allowed_at: 700, tasks: [task] };
const done: RuntimeSnapshot = { ...queued, tasks: [{ ...task, state: 'done', activity: 'rest' }] };

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(runtimeApi.read).mockResolvedValue(empty);
  vi.mocked(runtimeApi.save).mockResolvedValue(enabled);
  vi.mocked(runtimeApi.schedule).mockResolvedValue(queued);
  vi.mocked(runtimeApi.run).mockResolvedValue(done);
});
afterEach(() => { vi.useRealTimers(); localStorage.clear(); });

it('loads before showing empty state, starts without permission and never writes on mount', async () => {
  let resolve!: (value: RuntimeSnapshot) => void;
  vi.mocked(runtimeApi.read).mockImplementation(() => new Promise(r => { resolve = r; }));
  render(<LifeRuntimePanel spaceId={sid} />);
  expect(screen.getByText('正在读取…')).toBeInTheDocument();
  expect(screen.queryByText(/还没有体验任务/)).not.toBeInTheDocument();
  await act(async () => resolve(empty));
  expect(screen.getByText('体验已暂停')).toBeInTheDocument();
  screen.getAllByRole('checkbox').forEach(box => expect(box).not.toBeChecked());
  expect(screen.getByRole('button', { name: '保存并开启体验' })).toBeDisabled();
  expect(runtimeApi.save).not.toHaveBeenCalled(); expect(runtimeApi.schedule).not.toHaveBeenCalled(); expect(runtimeApi.run).not.toHaveBeenCalled();
});

it('saves scope, queues, restores queued state, executes and pauses with stored results', async () => {
  render(<LifeRuntimePanel spaceId={sid} />); await screen.findByText('体验已暂停');
  fireEvent.click(screen.getByLabelText('休息')); fireEvent.click(screen.getByRole('button', { name: '保存并开启体验' }));
  await screen.findByText('体验已开启');
  expect(runtimeApi.save).toHaveBeenCalledWith(sid, 0, true, ['rest'], expect.any(AbortSignal));
  fireEvent.click(screen.getByRole('button', { name: '安排一轮' })); await screen.findByText('待执行');
  vi.mocked(runtimeApi.read).mockResolvedValue(queued);
  fireEvent.click(screen.getByRole('button', { name: '刷新状态' })); await screen.findByText('状态已核对。');
  expect(runtimeApi.run).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: '执行这轮体验' })); await screen.findByText('已完成体验 · 休息');
  expect(runtimeApi.run).toHaveBeenCalledWith(sid, tid, expect.any(AbortSignal));
  vi.mocked(runtimeApi.save).mockResolvedValue({ ...done, permission: { enabled: false, activities: ['rest'], revision: 2 } });
  fireEvent.click(screen.getByRole('button', { name: '暂停体验' })); await screen.findByText('体验已暂停');
  expect(screen.getByText('已完成体验 · 休息')).toBeInTheDocument();
});

it('pause uses saved scope and clears unsaved checkbox changes', async () => {
  vi.mocked(runtimeApi.read).mockResolvedValue(queued);
  vi.mocked(runtimeApi.save).mockResolvedValue({ ...queued, permission: { ...queued.permission, enabled: false, revision: 2 }, tasks: [{ ...task, state: 'cancelled', error_code: 'conflict' }] });
  render(<LifeRuntimePanel spaceId={sid} />); await screen.findByText('待执行');
  fireEvent.click(screen.getByLabelText('散步'));
  expect(screen.getByRole('button', { name: '执行这轮体验' })).toBeDisabled();
  fireEvent.click(screen.getByRole('button', { name: '暂停体验' })); await screen.findByText('已取消');
  expect(runtimeApi.save).toHaveBeenCalledWith(sid, 1, false, ['rest'], expect.any(AbortSignal));
  expect(screen.getByLabelText('散步')).not.toBeChecked();
  expect(screen.queryByRole('button', { name: '执行这轮体验' })).not.toBeInTheDocument();
});

it('explicit refresh and focus preserve unsaved selections without writing', async () => {
  vi.mocked(runtimeApi.read).mockResolvedValue(enabled);
  render(<LifeRuntimePanel spaceId={sid} />); await screen.findByText('体验已开启');
  fireEvent.click(screen.getByLabelText('散步'));
  fireEvent.click(screen.getByRole('button', { name: '刷新状态' })); await screen.findByText('状态已核对。');
  expect(screen.getByLabelText('散步')).toBeChecked();
  fireEvent.focus(window); await waitFor(() => expect(runtimeApi.read).toHaveBeenCalledTimes(3));
  expect(screen.getByLabelText('散步')).toBeChecked(); expect(runtimeApi.save).not.toHaveBeenCalled();
});

it('reconciles uncertain writes once and never automatically resubmits', async () => {
  vi.mocked(runtimeApi.read).mockResolvedValueOnce(enabled).mockResolvedValue(queued);
  vi.mocked(runtimeApi.schedule).mockRejectedValue(new Error('connection lost'));
  render(<LifeRuntimePanel spaceId={sid} />); await screen.findByText('体验已开启');
  fireEvent.click(screen.getByRole('button', { name: '安排一轮' })); await screen.findByText('待执行');
  expect(runtimeApi.schedule).toHaveBeenCalledTimes(1); expect(runtimeApi.read).toHaveBeenCalledTimes(2);
  expect(screen.getByRole('alert')).toHaveTextContent('已核对服务器状态');
});

it('blocks writes while state is unknown and retains draft until read recovers', async () => {
  vi.mocked(runtimeApi.read).mockResolvedValueOnce(enabled).mockRejectedValueOnce(new Error('offline')).mockResolvedValue(enabled);
  vi.mocked(runtimeApi.save).mockRejectedValue(new Error('offline'));
  render(<LifeRuntimePanel spaceId={sid} />); await screen.findByText('体验已开启');
  fireEvent.click(screen.getByLabelText('散步')); fireEvent.click(screen.getByRole('button', { name: '保存活动范围' }));
  await waitFor(() => expect(screen.getByRole('button', { name: '刷新状态' })).toBeEnabled());
  expect(screen.getByRole('button', { name: '保存活动范围' })).toBeDisabled(); expect(screen.getByLabelText('散步')).toBeChecked();
  fireEvent.click(screen.getByRole('button', { name: '刷新状态' })); await screen.findByText('状态已核对。');
  expect(screen.getByRole('button', { name: '保存活动范围' })).toBeEnabled(); expect(runtimeApi.save).toHaveBeenCalledTimes(1);
});

it('prevents double execution and aborts waiting on unmount', async () => {
  vi.mocked(runtimeApi.read).mockResolvedValue(queued);
  vi.mocked(runtimeApi.run).mockImplementation(() => new Promise(() => {}));
  const view = render(<LifeRuntimePanel spaceId={sid} />); await screen.findByText('待执行');
  const button = screen.getByRole('button', { name: '执行这轮体验' }); fireEvent.click(button); fireEvent.click(button);
  expect(runtimeApi.run).toHaveBeenCalledTimes(1);
  const signal = vi.mocked(runtimeApi.run).mock.calls[0][2]!; view.unmount(); expect(signal.aborted).toBe(true);
});

it('space switch clears old state and ignores a late old response', async () => {
  let resolve!: (value: RuntimeSnapshot) => void;
  vi.mocked(runtimeApi.read).mockImplementationOnce(() => new Promise(r => { resolve = r; })).mockResolvedValue({ ...empty, space_id: other });
  const view = render(<LifeRuntimePanel spaceId={sid} />);
  const signal = vi.mocked(runtimeApi.read).mock.calls[0][1]!;
  view.rerender(<LifeRuntimePanel spaceId={other} />); await screen.findByText('体验已暂停');
  await act(async () => resolve(done));
  expect(signal.aborted).toBe(true); expect(screen.queryByText('已完成体验 · 休息')).not.toBeInTheDocument();
});

it('running tasks cannot be resumed until refreshed server time permits it', async () => {
  const running: RuntimeSnapshot = { ...queued, tasks: [{ ...task, state: 'running', retry_at: 160 }] };
  vi.mocked(runtimeApi.read).mockResolvedValueOnce(running).mockResolvedValue({ ...running, observed_at: 160 });
  render(<LifeRuntimePanel spaceId={sid} />); await screen.findByText('正在处理');
  expect(screen.getByRole('button', { name: '继续这轮体验' })).toBeDisabled();
  fireEvent.click(screen.getByRole('button', { name: '刷新状态' })); await screen.findByText('状态已核对。');
  expect(screen.getByRole('button', { name: '继续这轮体验' })).toBeEnabled(); expect(runtimeApi.run).not.toHaveBeenCalled();
});

it('failed reads show an error instead of a fabricated empty list', async () => {
  vi.mocked(runtimeApi.read).mockRejectedValue(new Error('failed'));
  render(<LifeRuntimePanel spaceId={sid} />); await screen.findByRole('alert');
  expect(screen.queryByText(/还没有体验任务/)).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: '安排一轮' })).toBeDisabled();
});

it.each([
  { ...empty, origin: 'real_ai' }, { ...empty, space_id: other },
  { ...empty, permission: { enabled: true, activities: [], revision: 1 } },
  { ...empty, permission: { enabled: true, activities: ['delete'], revision: 1 } },
  { ...empty, tasks: [task, task] },
  { ...queued, tasks: [{ ...task, state: 'done' }] },
  { ...done, tasks: [{ ...done.tasks[0], activity: 'observe' }] },
  { ...queued, tasks: [{ ...task, state: 'failed', error_code: null }] },
  { ...queued, tasks: [{ ...task, state: 'running', retry_at: 0 }] },
  { ...empty, observed_at: 101, next_allowed_at: 100 },
  { ...queued, tasks: [{ ...task, created_at: 101 }] },
  { ...queued, tasks: [{ ...task, state: 'unknown' }] },
])('rejects a contradictory or unlabelled snapshot %#', value => {
  expect(() => parseRuntime(value, sid)).toThrow();
});

it('accepts a valid labelled snapshot without treating pending as completed', () => {
  expect(parseRuntime(queued, sid)).toEqual(queued); expect(parseRuntime(done, sid)).toEqual(done);
});

it('accepts a saved one-line reason only on a completed task and keeps old tasks readable', () => {
  const reason = '天色晚了，先好好休息。';
  expect(parseRuntime({ ...done, tasks: [{ ...done.tasks[0], reason }] }, sid).tasks[0].reason).toBe(reason);
  expect(parseRuntime(done, sid).tasks[0].reason).toBeUndefined();
  for (const invalidReason of ['', 'x'.repeat(121), '第一行\n第二行', 12]) {
    expect(() => parseRuntime({ ...done, tasks: [{ ...done.tasks[0], reason: invalidReason }] }, sid)).toThrow();
  }
  expect(() => parseRuntime({ ...queued, tasks: [{ ...task, reason }] }, sid)).toThrow();
});

it('labels real planning as a limited AI trial and explains prepared activity playback', async () => {
  vi.mocked(runtimeApi.read).mockResolvedValue({ ...queued, origin: 'real_provider' });
  render(<LifeRuntimePanel spaceId={sid} />);
  expect(await screen.findByRole('heading', { name: '自主生活 · AI 活动试用' })).toBeInTheDocument();
  expect(screen.getByRole('button', { name: '请求 AI 安排这轮' })).toBeEnabled();
  expect(screen.getByText(/结果保存后，场景会展示有效活动及已准备好的对应动作/)).toBeInTheDocument();
  expect(parseRuntime({ ...done, origin: 'real_provider' }, sid).origin).toBe('real_provider');
});

it('explains a zero-budget refusal without blaming scene permissions', async () => {
  vi.mocked(runtimeApi.read).mockResolvedValue({ ...queued, origin: 'real_provider',
    tasks: [{ ...task, state: 'failed', error_code: 'budget_exhausted' }] });
  render(<LifeRuntimePanel spaceId={sid} />);
  expect(await screen.findByText('尚未开放付费试跑，本轮没有调用 AI。')).toBeInTheDocument();
});

const accepted: RuntimeSnapshot = { ...queued, tasks: [{ ...task, dispatch_requested: true }] };
const completed: RuntimeSnapshot = { ...done, tasks: [{ ...done.tasks[0], dispatch_requested: true }] };
const advance = (ms: number) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });
async function renderPolling(value = accepted) {
  vi.useFakeTimers(); vi.mocked(runtimeApi.read).mockResolvedValueOnce(value);
  await act(async () => { render(<LifeRuntimePanel spaceId={sid} />); });
}

it.each(['offline_fixture', 'real_provider'] as const)('automatically reads %s results after one durable submission without replaying it', async origin => {
  const initial = { ...queued, origin };
  vi.mocked(runtimeApi.run).mockResolvedValue({ ...accepted, origin });
  await renderPolling(initial);
  vi.mocked(runtimeApi.read).mockResolvedValue({ ...completed, origin });
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: origin === 'real_provider' ? '请求 AI 安排这轮' : '执行这轮体验' })); });
  expect(screen.getByText('等待后台处理')).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: /执行这轮体验|请求 AI 安排这轮/ })).toBeNull();
  await advance(2000); expect(screen.getByText('已完成体验 · 休息')).toBeInTheDocument();
  await advance(20000); expect(runtimeApi.read).toHaveBeenCalledTimes(2); expect(runtimeApi.run).toHaveBeenCalledOnce();
});
it('keeps activity drafts and allows pause to cancel an in-flight automatic read', async () => {
  await renderPolling();
  let resolve!: (v: RuntimeSnapshot) => void;
  vi.mocked(runtimeApi.read).mockImplementationOnce(() => new Promise(r => { resolve = r; }));
  fireEvent.click(screen.getByLabelText('散步')); await advance(2000);
  const signal = vi.mocked(runtimeApi.read).mock.calls[1][1]!;
  expect(screen.getByRole('button', { name: '暂停体验' })).toBeEnabled();
  vi.mocked(runtimeApi.save).mockResolvedValue({ ...accepted, permission: { ...accepted.permission, enabled: false, revision: 2 }, tasks: [{ ...accepted.tasks[0], state: 'cancelled', error_code: 'conflict' }] });
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: '暂停体验' })); });
  expect(signal.aborted).toBe(true);
  await act(async () => resolve(completed));
  expect(screen.getByText('已取消')).toBeInTheDocument(); expect(screen.queryByText('已完成体验 · 休息')).toBeNull();
});
it('preserves unsaved activities when automatic results arrive', async () => {
  await renderPolling(); fireEvent.click(screen.getByLabelText('散步'));
  vi.mocked(runtimeApi.read).mockResolvedValue(completed); await advance(2000);
  expect(screen.getByLabelText('散步')).toBeChecked(); expect(runtimeApi.save).not.toHaveBeenCalled();
});
it('stops hidden-page reads and checks immediately when visible again', async () => {
  let visibility: DocumentVisibilityState = 'visible';
  vi.spyOn(document, 'visibilityState', 'get').mockImplementation(() => visibility);
  await renderPolling();
  await act(async () => { visibility = 'hidden'; document.dispatchEvent(new Event('visibilitychange')); });
  await advance(10000); expect(runtimeApi.read).toHaveBeenCalledOnce();
  vi.mocked(runtimeApi.read).mockResolvedValue(completed);
  await act(async () => { visibility = 'visible'; document.dispatchEvent(new Event('visibilitychange')); });
  expect(screen.getByText('已完成体验 · 休息')).toBeInTheDocument();
});
it('backs off failed automatic reads and never repeats a submission', async () => {
  await renderPolling(); vi.mocked(runtimeApi.read).mockRejectedValue(new Error('offline'));
  await advance(2000); expect(screen.getByText(/暂时连不上，保留上次的任务状态/)).toBeInTheDocument();
  await advance(3999); expect(runtimeApi.read).toHaveBeenCalledTimes(2); await advance(1);
  await advance(7999); expect(runtimeApi.read).toHaveBeenCalledTimes(3); await advance(1);
  await advance(9999); expect(runtimeApi.read).toHaveBeenCalledTimes(4);
  vi.mocked(runtimeApi.read).mockResolvedValue(completed); await advance(1);
  expect(screen.getByText('已完成体验 · 休息')).toBeInTheDocument(); expect(runtimeApi.run).not.toHaveBeenCalled();
});
it('recovers an uncertain dispatch by reading its existing task, not resubmitting', async () => {
  await renderPolling(queued);
  vi.mocked(runtimeApi.run).mockRejectedValue(new Error('connection lost'));
  vi.mocked(runtimeApi.read).mockResolvedValueOnce(accepted).mockResolvedValue(completed);
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: '执行这轮体验' })); });
  expect(screen.getByText('等待后台处理')).toBeInTheDocument();
  await advance(2000); expect(screen.getByText('已完成体验 · 休息')).toBeInTheDocument();
  expect(runtimeApi.run).toHaveBeenCalledOnce();
});
it('ignores an automatic result after the account changes', async () => {
  localStorage.setItem(TOKEN_KEY, 'one'); await renderPolling();
  let resolve!: (v: RuntimeSnapshot) => void;
  vi.mocked(runtimeApi.read).mockImplementationOnce(() => new Promise(r => { resolve = r; }));
  await advance(2000); localStorage.setItem(TOKEN_KEY, 'two');
  await act(async () => resolve(completed)); await advance(10000);
  expect(screen.queryByText('已完成体验 · 休息')).toBeNull(); expect(runtimeApi.read).toHaveBeenCalledTimes(2);
});
it('rejects a non-boolean dispatch marker instead of trusting a malformed queue response', () => {
  expect(() => parseRuntime({ ...accepted, tasks: [{ ...accepted.tasks[0], dispatch_requested: 'true' }] }, sid)).toThrow();
  expect(parseRuntime(accepted, sid).tasks[0].dispatch_requested).toBe(true);
});
