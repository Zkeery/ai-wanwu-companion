import React from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import MotionGenerationStatus from '@/components/motion-generation-status';
import { motionGenerationActivities, type ActivityGenerations, type GenerationState } from '@/lib/motion-generation';
import { setToken, clearToken } from '@/lib/auth';

vi.mock('@/lib/motion-generation', () => ({ motionGenerationActivities: vi.fn() }));
const call = vi.mocked(motionGenerationActivities);
const response = (state: GenerationState): ActivityGenerations => ({ character_id: 18,
  activities: (['rest', 'walk', 'observe'] as const).map((activity, index) => ({ activity, state,
    request_id: state === 'not_requested' ? null : `${index}`.repeat(36) })) });
const none = response('not_requested');
const waiting = response('waiting_authorization');
const flush = () => act(async () => { await Promise.resolve(); });
const show = () => render(<MotionGenerationStatus id={18} token="owner" />);
beforeEach(() => {
  vi.useFakeTimers(); call.mockReset(); call.mockResolvedValue(none); setToken('owner');
  Object.defineProperty(document, 'hidden', { value: false, configurable: true });
});
afterEach(() => { cleanup(); clearToken(); vi.useRealTimers(); vi.restoreAllMocks(); });

it('registers only after a click and shows the persistent waiting state', async () => {
  show(); await flush(); expect(call.mock.calls[0][3]).toBeUndefined();
  call.mockResolvedValue(waiting); fireEvent.click(screen.getByText('准备三类动作'));
  fireEvent.click(screen.getByText('正在保存准备任务…')); await flush();
  expect(call.mock.calls.filter(args => args[3])).toHaveLength(1);
  expect(screen.getAllByText(/准备任务已保存/)).toHaveLength(3);
  expect(screen.queryByText('准备三类动作')).not.toBeInTheDocument();
});
it('a failed registration requires a GET refresh before another attempt', async () => {
  show(); await flush(); call.mockRejectedValueOnce(new Error('lost response'));
  fireEvent.click(screen.getByText('准备三类动作')); await flush();
  expect(screen.getByText('准备三类动作')).toBeDisabled();
  call.mockResolvedValue(waiting); fireEvent.click(screen.getByText('更新任务状态')); await flush();
  expect(call.mock.calls.filter(args => args[3])).toHaveLength(1);
  expect(screen.getAllByText(/准备任务已保存/)).toHaveLength(3);
});
it('polls queued work at most ten times and never registers in a poll', async () => {
  call.mockResolvedValue(response('queued')); show(); await flush();
  await act(async () => { await vi.advanceTimersByTimeAsync(20_000); });
  expect(call).toHaveBeenCalledTimes(10); expect(call.mock.calls.some(args => args[3])).toBe(false);
});
it('hiding during a submission aborts the read and leaves refresh available', async () => {
  show(); await flush(); call.mockImplementationOnce((_id, _token, signal) => new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => reject(new Error('abort')));
  }));
  fireEvent.click(screen.getByText('准备三类动作'));
  Object.defineProperty(document, 'hidden', { value: true, configurable: true });
  fireEvent(document, new Event('visibilitychange')); await flush();
  expect(call.mock.calls[1][2].aborted).toBe(true);
  expect(screen.getByText('更新任务状态')).not.toBeDisabled(); expect(screen.getByText('准备三类动作')).toBeDisabled();
});
it('unmount cancels the task read and the scheduled poll', async () => {
  call.mockResolvedValue(response('running')); const view = show(); await flush();
  const signal = call.mock.calls[0][2]; view.unmount();
  await act(async () => { await vi.advanceTimersByTimeAsync(20_000); });
  expect(signal.aborted).toBe(true); expect(call).toHaveBeenCalledTimes(1);
});
it('only three ready motions hide the redundant registration area', async () => {
  call.mockResolvedValue(response('ready')); show(); await flush();
  expect(screen.queryByLabelText('三类动作准备')).not.toBeInTheDocument();
});
it('keeps unknown outcomes visible without a new generation button', async () => {
  call.mockResolvedValue(response('unknown')); show(); await flush();
  expect(screen.getAllByText(/不会自动重新生成/)).toHaveLength(3); expect(screen.queryByText('准备三类动作')).not.toBeInTheDocument();
});
it('cannot register after account changes', async () => {
  show(); await flush(); setToken('other'); fireEvent.click(screen.getByText('准备三类动作'));
  expect(call).toHaveBeenCalledTimes(1);
});

it('keeps rest and observe pending after walk is ready', async () => {
  const value = response('waiting_authorization'); value.activities[1].state = 'ready';
  call.mockResolvedValue(value); show(); await flush();
  expect(screen.getByLabelText('三类动作准备')).toBeInTheDocument();
  expect(screen.getByText(/散步：/)).toBeInTheDocument();
  expect(screen.getAllByText(/准备任务已保存/)).toHaveLength(2);
});

it('polls remaining activities even when walk is ready', async () => {
  const value = response('running'); value.activities[1].state = 'ready';
  call.mockResolvedValue(value); show(); await flush();
  await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
  expect(call).toHaveBeenCalledTimes(2);
  expect(call.mock.calls.some(args => args[3])).toBe(false);
});
