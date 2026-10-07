import React from 'react';
import { act, fireEvent, render, screen, cleanup } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import CompanionMotionPreview from '@/components/companion-motion-preview';
import { readMotionPreparation, type PreparationSummary } from '@/lib/motion-preparation';
import { setToken, clearToken } from '@/lib/auth';

vi.mock('@/lib/motion-preparation', () => ({ readMotionPreparation: vi.fn() }));
const { playerOpened } = vi.hoisted(() => ({ playerOpened: vi.fn() }));
vi.mock('@/components/private-motion-player', () => ({ default: function Player({ id, activity }: { id: number; activity?: string }) {
  React.useEffect(() => { playerOpened(id, activity); }, [id, activity]);
  return <p>播放器 {id} · {activity ?? 'default'}</p>;
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

it('shows distinct preparation states and previews a selected activity without changing identity', async () => {
  render(<CompanionMotionPreview {...props} />); await flush();
  expect(screen.getByText('等待动作素材')).toBeInTheDocument();
  expect(screen.getByText('已就绪')).toBeInTheDocument();
  expect(screen.getByText('准备未完成')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: '散步' }));
  expect(screen.getByText('播放器 18 · walk')).toBeInTheDocument();
  await act(() => vi.advanceTimersByTimeAsync(30_000));
  expect(read).toHaveBeenCalledTimes(1);
});

it('opens the ready walk without requiring the user to guess a category', async () => {
  render(<CompanionMotionPreview {...props} />); await flush();
  expect(screen.getByRole('button', { name: '散步' })).toHaveAttribute('aria-pressed', 'true');
  const player = screen.getByText('播放器 18 · walk');
  const status = screen.getByRole('status', { name: '动作准备状态' });
  expect(player.compareDocumentPosition(status) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
});

it('keeps the current activity even when only another activity has an asset', async () => {
  const view = render(<CompanionMotionPreview {...props} activity="rest" />); await flush();
  expect(screen.getByText('播放器 18 · rest')).toBeInTheDocument();
  view.rerender(<CompanionMotionPreview {...props} activity="observe" />);
  expect(screen.getByText('播放器 18 · observe')).toBeInTheDocument();
});

it('preserves a manual default choice when a late ready response arrives', async () => {
  let resolve!: (value: PreparationSummary) => void;
  read.mockImplementationOnce(() => new Promise(done => { resolve = done; }));
  render(<CompanionMotionPreview {...props} activity="rest" />); await flush();
  fireEvent.click(screen.getByRole('button', { name: '默认动作' }));
  await act(async () => resolve(summary));
  expect(screen.getByText('播放器 18 · default')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: '更新动作状态' })); await flush();
  expect(screen.getByText('播放器 18 · default')).toBeInTheDocument();
});

it('polls only queued work then stops when ready and refreshes without losing selection', async () => {
  read.mockResolvedValueOnce({ ...summary, walk: 'queued' });
  render(<CompanionMotionPreview {...props} activity="walk" />); await flush();
  expect(screen.getByText('正在准备')).toBeInTheDocument();
  expect(playerOpened).toHaveBeenCalledTimes(1);
  await act(() => vi.advanceTimersByTimeAsync(1000));
  expect(screen.getByText('已就绪')).toBeInTheDocument();
  expect(playerOpened).toHaveBeenCalledTimes(2);
  expect(playerOpened).toHaveBeenLastCalledWith(18, 'walk');
  await act(() => vi.advanceTimersByTimeAsync(20_000));
  expect(read).toHaveBeenCalledTimes(2);
  fireEvent.click(screen.getByRole('button', { name: '更新动作状态' })); await flush();
  expect(read).toHaveBeenCalledTimes(3);
  expect(screen.getByText('播放器 18 · walk')).toBeInTheDocument();
});

it('bounds a persistent queue to ten reads and retains a manual refresh', async () => {
  read.mockResolvedValue({ ...summary, walk: 'queued' });
  render(<CompanionMotionPreview {...props} />); await flush();
  await act(() => vi.advanceTimersByTimeAsync(30_000));
  expect(read).toHaveBeenCalledTimes(10);
  expect(screen.getByText('仍在后台准备，稍后可更新动作状态。')).toBeInTheDocument();
});

it('aborts a hanging request at ten seconds and ignores its late result', async () => {
  let resolve!: (value: PreparationSummary) => void;
  read.mockImplementation(() => new Promise(done => { resolve = done; }));
  render(<CompanionMotionPreview {...props} />); await flush();
  const signal = read.mock.calls[0][2];
  await act(() => vi.advanceTimersByTimeAsync(10_000));
  expect(signal.aborted).toBe(true);
  await act(async () => resolve(summary));
  expect(screen.queryByText('已就绪')).not.toBeInTheDocument();
  expect(screen.getByText('稍后可更新动作状态，伙伴图片仍可使用。')).toBeInTheDocument();
});

it('cancels when hidden and does not start requests on a hidden page', async () => {
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

it.each(['account', 'character'] as const)('isolates late responses after %s changes', async change => {
  let resolve!: (value: PreparationSummary) => void;
  read.mockImplementationOnce(() => new Promise(done => { resolve = done; }));
  read.mockResolvedValue({ rest: 'not_requested', walk: 'not_requested', observe: 'not_requested' });
  const view = render(<CompanionMotionPreview {...props} />); await flush();
  fireEvent.click(screen.getByRole('button', { name: '散步' }));
  const signal = read.mock.calls[0][2];
  if (change === 'account') act(() => setToken('new-owner-test'));
  else view.rerender(<CompanionMotionPreview {...props} id={19} />);
  await flush(); await act(async () => resolve(summary));
  expect(signal.aborted).toBe(true);
  expect(screen.queryByText('已就绪')).not.toBeInTheDocument();
  expect(screen.getByText(`播放器 ${change === 'account' ? 18 : 19} · default`)).toBeInTheDocument();
});

it('keeps preview available on missing endpoint or malformed state, without exposing raw errors', async () => {
  read.mockResolvedValueOnce(null);
  render(<CompanionMotionPreview {...props} />); await flush();
  expect(screen.getByText('暂时无法核对准备状态，仍可检查已有动作。')).toBeInTheDocument();
  read.mockRejectedValueOnce(new Error('private-provider-message'));
  fireEvent.click(screen.getByRole('button', { name: '更新动作状态' })); await flush();
  expect(screen.getByText('动作状态暂时没能加载，请更新后再看。')).toBeInTheDocument();
  expect(screen.queryByText(/private-provider/)).not.toBeInTheDocument();
});
