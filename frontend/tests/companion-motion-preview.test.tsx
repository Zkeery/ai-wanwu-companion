import React from 'react';
import { act, fireEvent, render, screen, cleanup } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import CompanionMotionPreview from '@/components/companion-motion-preview';
import { readMotionPreparation, type PreparationSummary } from '@/lib/motion-preparation';
import { setToken, clearToken } from '@/lib/auth';

vi.mock('@/lib/motion-preparation', () => ({ readMotionPreparation: vi.fn() }));
const { playerOpened } = vi.hoisted(() => ({ playerOpened: vi.fn() }));
vi.mock('@/components/private-motion-player', () => ({ default: function Player({ id, activity, resourceKey, quietWhenUnavailable }: { id: number; activity?: string; resourceKey?: string; quietWhenUnavailable?: boolean }) {
  React.useEffect(() => { playerOpened(id, activity); }, [id, activity, resourceKey]);
  return <p>播放器 {id} · {activity ?? 'default'} · {String(quietWhenUnavailable)}</p>;
} }));
const read = vi.mocked(readMotionPreparation);
const summary: PreparationSummary = { rest: 'waiting_source', walk: 'ready', observe: 'failed' };
const props = { id: 18, src: '/uploads/apple.jpg', name: '苹果' };
const flush = () => act(async () => { await Promise.resolve(); });
beforeEach(() => {
  vi.useFakeTimers(); read.mockReset(); playerOpened.mockClear(); read.mockResolvedValue(summary); setToken('owner-test');
  Object.defineProperty(document, 'hidden', { value: false, configurable: true });
});
afterEach(() => { cleanup(); vi.useRealTimers(); clearToken(); vi.restoreAllMocks(); });

it('shows only ready actions without internal generation or preparation panels', async () => {
  render(<CompanionMotionPreview {...props} />); await flush();
  expect(screen.getByRole('button', { name: '散步' })).toHaveAttribute('aria-pressed', 'true');
  expect(screen.queryByRole('button', { name: '休息' })).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: '观察' })).not.toBeInTheDocument();
  expect(screen.queryByText(/等待动作素材|准备未完成|更新动作状态|更新任务状态|生成尚未开放/)).not.toBeInTheDocument();
  expect(screen.getByText('播放器 18 · walk · true')).toBeInTheDocument();
});
it('keeps a new partner static without waiting controls or extra task reads', async () => {
  read.mockResolvedValue({ rest: 'waiting_source', walk: 'waiting_source', observe: 'waiting_source' });
  render(<CompanionMotionPreview {...props} />); await flush();
  expect(screen.queryByRole('group', { name: '预览哪种动作' })).not.toBeInTheDocument();
  expect(screen.queryByRole('button')).not.toBeInTheDocument();
  expect(screen.getByText('播放器 18 · default · true')).toBeInTheDocument();
  await act(() => vi.advanceTimersByTimeAsync(30_000));
  expect(read).toHaveBeenCalledTimes(1);
});
it('retains all ready actions and a deliberate default choice', async () => {
  read.mockResolvedValue({ rest: 'ready', walk: 'ready', observe: 'ready' });
  render(<CompanionMotionPreview {...props} />); await flush();
  fireEvent.click(screen.getByRole('button', { name: '散步' }));
  expect(screen.getByText('播放器 18 · walk · true')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: '默认动作' }));
  expect(screen.getByText('播放器 18 · default · true')).toBeInTheDocument();
});
it('keeps the requested activity while ready data arrives', async () => {
  const view = render(<CompanionMotionPreview {...props} activity="rest" />); await flush();
  expect(screen.getByText('播放器 18 · rest · true')).toBeInTheDocument();
  view.rerender(<CompanionMotionPreview {...props} activity="observe" />);
  expect(screen.getByText('播放器 18 · observe · true')).toBeInTheDocument();
});
it('quietly observes real queued work then exposes only its ready action', async () => {
  read.mockResolvedValueOnce({ ...summary, walk: 'queued' });
  render(<CompanionMotionPreview {...props} activity="walk" />); await flush();
  expect(screen.queryByText(/正在准备|等待动作素材/)).not.toBeInTheDocument();
  await act(() => vi.advanceTimersByTimeAsync(1000));
  expect(screen.getByRole('button', { name: '散步' })).toBeInTheDocument();
  await act(() => vi.advanceTimersByTimeAsync(20_000));
  expect(read).toHaveBeenCalledTimes(2);
});
it('bounds a persistent queue to ten reads without showing task controls', async () => {
  read.mockResolvedValue({ ...summary, walk: 'queued' });
  render(<CompanionMotionPreview {...props} />); await flush();
  await act(() => vi.advanceTimersByTimeAsync(30_000));
  expect(read).toHaveBeenCalledTimes(10);
  expect(screen.queryByRole('button')).not.toBeInTheDocument();
});
it('aborts a hanging request and ignores its late ready result', async () => {
  let resolve!: (value: PreparationSummary) => void;
  read.mockImplementation(() => new Promise(done => { resolve = done; }));
  render(<CompanionMotionPreview {...props} />); await flush();
  const signal = read.mock.calls[0][2];
  await act(() => vi.advanceTimersByTimeAsync(10_000));
  expect(signal.aborted).toBe(true);
  await act(async () => resolve(summary));
  expect(screen.queryByRole('button')).not.toBeInTheDocument();
});
it('cancels observation when hidden and makes no hidden-page request', async () => {
  read.mockResolvedValue({ ...summary, walk: 'queued' });
  const view = render(<CompanionMotionPreview {...props} />); await flush();
  const signal = read.mock.calls[0][2];
  Object.defineProperty(document, 'hidden', { value: true, configurable: true });
  act(() => document.dispatchEvent(new Event('visibilitychange')));
  await act(() => vi.advanceTimersByTimeAsync(20_000));
  expect(signal.aborted).toBe(true); expect(read).toHaveBeenCalledTimes(1);
  view.unmount(); render(<CompanionMotionPreview {...props} />); await flush();
  expect(read).toHaveBeenCalledTimes(1);
});
it.each(['account', 'character'] as const)('isolates late ready data after %s changes', async change => {
  let resolve!: (value: PreparationSummary) => void;
  read.mockImplementationOnce(() => new Promise(done => { resolve = done; }));
  read.mockResolvedValue({ rest: 'not_requested', walk: 'not_requested', observe: 'not_requested' });
  const view = render(<CompanionMotionPreview {...props} />); await flush();
  const signal = read.mock.calls[0][2];
  if (change === 'account') act(() => setToken('new-owner-test'));
  else view.rerender(<CompanionMotionPreview {...props} id={19} />);
  await flush(); await act(async () => resolve(summary));
  expect(signal.aborted).toBe(true);
  expect(screen.queryByRole('button')).not.toBeInTheDocument();
});
it('keeps the static portrait when the preparation endpoint is unavailable', async () => {
  read.mockRejectedValueOnce(new Error('private-provider-message'));
  render(<CompanionMotionPreview {...props} />); await flush();
  expect(screen.getByText('播放器 18 · default · true')).toBeInTheDocument();
  expect(screen.queryByText(/private-provider/)).not.toBeInTheDocument();
});
