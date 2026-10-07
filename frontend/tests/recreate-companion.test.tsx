import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import RecreateCompanion from '@/components/recreate-companion';
import { api, ApiError } from '@/lib/api';
import { recreateCompanion, recreationKey, saveRecreationKey } from '@/lib/recreation';

const { push } = vi.hoisted(() => ({ push: vi.fn() }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ push }) }));
vi.mock('@/lib/recreation', async original => ({ ...await original<typeof import('@/lib/recreation')>(), recreateCompanion: vi.fn() }));
const character = { id: 9, name: '新朋友', persona: '活泼', opening_line: '你好', status: 'ready' as const, image_path: null, created_at: '' };
beforeEach(() => {
  vi.restoreAllMocks(); vi.clearAllMocks(); sessionStorage.clear();
  HTMLDialogElement.prototype.showModal = vi.fn(function (this: HTMLDialogElement) { this.setAttribute('open', ''); });
  HTMLDialogElement.prototype.close = vi.fn(function (this: HTMLDialogElement) { this.removeAttribute('open'); });
  vi.spyOn(api, 'generationCredits').mockResolvedValue({ enabled: true, available: 5 });
  vi.spyOn(api, 'recreation').mockResolvedValue({ status: 'generating', character: { ...character, status: 'generating' } });
  vi.mocked(recreateCompanion).mockResolvedValue(character);
});
it('requires an explicit credit confirmation and preserves the source route until success', async () => {
  render(<RecreateCompanion id={1} />);
  fireEvent.click(await screen.findByText('再创造一个'));
  expect(screen.getByText(/现在的伙伴及聊天/)).toBeInTheDocument();
  expect(recreateCompanion).not.toHaveBeenCalled();
  fireEvent.click(screen.getByText('确认创作 · 消耗 1 次'));
  await waitFor(() => expect(push).toHaveBeenCalledExactlyOnceWith('/companions/9'));
  expect(recreateCompanion).toHaveBeenCalledTimes(1);
  expect(recreationKey(1)).toBeNull();
});
it('does not show an unavailable entry or an invented balance', async () => {
  vi.mocked(api.generationCredits).mockResolvedValue({ enabled: false, available: null });
  const view = render(<RecreateCompanion id={1} />);
  await waitFor(() => expect(api.generationCredits).toHaveBeenCalled());
  expect(view.container).toBeEmptyDOMElement();
});
it('blocks new creation when credits are exhausted', async () => {
  vi.mocked(api.generationCredits).mockResolvedValue({ enabled: true, available: 0 });
  render(<RecreateCompanion id={1} />);
  expect(await screen.findByText('再创造一个')).toBeDisabled();
  expect(recreateCompanion).not.toHaveBeenCalled();
});
it('recovers an existing success without regenerating or navigating automatically', async () => {
  saveRecreationKey(1, '00000000-0000-4000-8000-000000000001');
  vi.mocked(api.recreation).mockResolvedValue({ status: 'ready', character });
  render(<RecreateCompanion id={1} />);
  expect(await screen.findByText('去认识新的伙伴 →')).toHaveAttribute('href', '/companions/9');
  expect(recreateCompanion).not.toHaveBeenCalled(); expect(push).not.toHaveBeenCalled();
});
it('keeps a running receipt and reuses its key only after a click', async () => {
  const key = '00000000-0000-4000-8000-000000000001';
  saveRecreationKey(1, key);
  render(<RecreateCompanion id={1} />);
  expect(await screen.findByText('继续这次创作')).toBeEnabled();
  expect(recreateCompanion).not.toHaveBeenCalled();
  fireEvent.click(screen.getByText('继续这次创作'));
  await waitFor(() => expect(recreateCompanion).toHaveBeenCalledWith(1, key, expect.any(AbortSignal), expect.any(Function)));
});
it('keeps the receipt on an uncertain network result', async () => {
  vi.mocked(recreateCompanion).mockRejectedValue(new Error('连接中断'));
  vi.mocked(api.recreation).mockRejectedValue(new Error('网络不可用'));
  render(<RecreateCompanion id={1} />);
  fireEvent.click(await screen.findByText('再创造一个'));
  fireEvent.click(screen.getByText('确认创作 · 消耗 1 次'));
  expect(await screen.findByText(/连接中断/)).toBeInTheDocument();
  expect(recreationKey(1)).not.toBeNull(); expect(push).not.toHaveBeenCalled();
});
it('clears a rejected reservation without claiming a generation happened', async () => {
  vi.mocked(recreateCompanion).mockRejectedValue(new ApiError('额度已用完', 409, 'credits_exhausted'));
  render(<RecreateCompanion id={1} />);
  fireEvent.click(await screen.findByText('再创造一个'));
  fireEvent.click(screen.getByText('确认创作 · 消耗 1 次'));
  await waitFor(() => expect(recreationKey(1)).toBeNull());
  expect(push).not.toHaveBeenCalled(); expect(api.recreation).not.toHaveBeenCalled();
});
it('recognizes refunded technical failure while preserving the old companion', async () => {
  saveRecreationKey(1, '00000000-0000-4000-8000-000000000001');
  vi.mocked(api.recreation).mockResolvedValue({ status: 'failed', character: { ...character, status: 'failed' } });
  render(<RecreateCompanion id={1} />);
  expect(await screen.findByText(/预留额度已返还/)).toBeInTheDocument();
  expect(recreationKey(1)).toBeNull(); expect(push).not.toHaveBeenCalled();
});
