import React from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import MotionCandidateReview from '@/components/motion-candidate-review';
import { candidateImage, readCandidates, reviewCandidate, type MotionCandidate } from '@/lib/motion-candidates';
import { setToken, clearToken } from '@/lib/auth';

vi.mock('@/lib/motion-candidates', () => ({ candidateImage: vi.fn(), readCandidates: vi.fn(), reviewCandidate: vi.fn() }));
const item: MotionCandidate = { job_id: 'a'.repeat(64), state: 'needs_review', candidate_sha256: 'b'.repeat(64), image_url: '/private/image' };
const read = vi.mocked(readCandidates), image = vi.mocked(candidateImage), review = vi.mocked(reviewCandidate);
const changed = vi.fn();
const flush = () => act(async () => { await Promise.resolve(); });
async function open() { render(<MotionCandidateReview id={18} token="test-owner" onChange={changed} />);
  fireEvent.click(screen.getByText('查看待确认动作')); await flush(); }
beforeEach(() => {
  vi.resetAllMocks(); setToken('test-owner');
  read.mockResolvedValue({ items: [item], next_cursor: null }); image.mockResolvedValue(new Blob(['png']));
  review.mockResolvedValue({ ...item, state: 'queued' });
  vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:candidate'); vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
});
afterEach(() => { cleanup(); clearToken(); vi.restoreAllMocks(); });

it('switches activity without carrying an image, confirmation or delayed response across categories', async () => {
  await open(); fireEvent.load(screen.getByRole('img')); fireEvent.click(screen.getByRole('checkbox'));
  const oldSignal = image.mock.calls[0][3];
  const rest = { ...item, activity: 'rest' as const };
  read.mockResolvedValueOnce({ items: [rest], next_cursor: null });
  fireEvent.change(screen.getByRole('combobox', { name: '候选动作分类' }), { target: { value: 'rest' } }); await flush();
  expect(oldSignal.aborted).toBe(true);
  expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:candidate');
  expect(read.mock.calls.at(-1)?.[4]).toBe('rest');
  expect(screen.getByLabelText('休息动作候选')).toBeInTheDocument();
  expect(screen.getByRole('checkbox')).not.toBeChecked();
  expect(screen.getByText('使用这个动作')).toBeDisabled();
  let resolve!: (page: { items: MotionCandidate[]; next_cursor: null }) => void;
  read.mockReturnValueOnce(new Promise(r => { resolve = r; }));
  fireEvent.change(screen.getByRole('combobox'), { target: { value: 'observe' } }); await flush();
  const pendingSignal = read.mock.calls.at(-1)![2];
  read.mockResolvedValueOnce({ items: [], next_cursor: null });
  fireEvent.change(screen.getByRole('combobox'), { target: { value: 'walk' } }); await flush();
  await act(async () => resolve({ items: [{ ...item, activity: 'observe' }], next_cursor: null }));
  expect(pendingSignal.aborted).toBe(true);
  expect(screen.queryByLabelText('观察动作候选')).not.toBeInTheDocument();
  expect(review).not.toHaveBeenCalled();
});

it('reads only on opening; requires the loaded image and explicit check before accepting', async () => {
  render(<MotionCandidateReview id={18} token="test-owner" onChange={changed} />);
  expect(read).not.toHaveBeenCalled(); fireEvent.click(screen.getByText('查看待确认动作')); await flush();
  expect(screen.getByText('使用这个动作')).toBeDisabled();
  fireEvent.load(screen.getByRole('img')); await flush(); fireEvent.click(screen.getByRole('checkbox'));
  fireEvent.click(screen.getByText('使用这个动作')); fireEvent.click(screen.getByText('正在保存…')); await flush();
  expect(review).toHaveBeenCalledTimes(1); expect(review.mock.calls[0][2]).toBe('accept');
  expect(screen.getByText('正在准备散步动作')).toBeInTheDocument(); expect(changed).toHaveBeenCalledOnce();
});
it('preserves rejection and never silently accepts', async () => {
  review.mockResolvedValue({ ...item, state: 'rejected' }); await open(); fireEvent.click(screen.getByText('暂不使用')); await flush();
  expect(review.mock.calls[0][2]).toBe('reject'); expect(screen.getByText('未采用')).toBeInTheDocument();
  expect(screen.queryByText('使用这个动作')).not.toBeInTheDocument();
});
it('unknown POST result blocks another decision until a read refresh', async () => {
  review.mockRejectedValue(new Error('network')); await open(); fireEvent.click(screen.getByText('暂不使用')); await flush();
  expect(screen.getByText('暂不使用')).toBeDisabled(); expect(review).toHaveBeenCalledTimes(1);
  read.mockResolvedValue({ items: [{ ...item, state: 'reviewed' }], next_cursor: null });
  fireEvent.click(screen.getByText('更新候选状态')); await flush();
  expect(screen.getByText('继续准备')).toBeDisabled(); expect(review).toHaveBeenCalledTimes(1);
});
it('revokes private image URLs and aborts reads when closed', async () => {
  await open(); const signal = image.mock.calls[0][3]; fireEvent.click(screen.getByText('收起待确认动作'));
  expect(signal.aborted).toBe(true); expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:candidate');
});
it('does not apply delayed images or submit after identity changes', async () => {
  let resolve!: (blob: Blob) => void; image.mockReturnValue(new Promise(r => { resolve = r; }));
  await open(); setToken('another-owner'); await act(async () => resolve(new Blob(['png'])));
  expect(URL.createObjectURL).not.toHaveBeenCalled(); fireEvent.click(screen.getByText('暂不使用'));
  expect(review).not.toHaveBeenCalled();
});
it('shows loading failure and empty state with an explicit refresh', async () => {
  read.mockRejectedValue(new Error('offline')); await open(); expect(screen.getByText(/候选暂时没能加载/)).toBeInTheDocument();
  read.mockResolvedValue({ items: [], next_cursor: null }); fireEvent.click(screen.getByText('更新候选状态')); await flush();
  expect(screen.getByText('当前没有待确认的动作素材。')).toBeInTheDocument(); expect(review).not.toHaveBeenCalled();
});
it('moves to the next page without posting a decision', async () => {
  read.mockResolvedValueOnce({ items: [item], next_cursor: item.job_id }); await open();
  fireEvent.click(screen.getByText('下一页候选')); await flush();
  expect(read.mock.calls[1][3]).toBe(item.job_id); expect(review).not.toHaveBeenCalled();
});
