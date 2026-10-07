import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import PrivateImage from '@/components/private-image';
import { clearToken, getToken, setToken } from '@/lib/auth';
import { isPrivateImageUrl, privateImageBlob } from '@/lib/private-images';
import { assertProductionConfig } from '@/lib/production-config';

const image = () => new Response('synthetic image', { headers: { 'Content-Type': 'image/png' } });
beforeEach(() => {
  vi.restoreAllMocks(); localStorage.clear();
  URL.createObjectURL = vi.fn(() => 'blob:private-image'); URL.revokeObjectURL = vi.fn();
});

it('only requests approved local image paths', () => {
  for (const url of ['https://outside/image', '//outside/image', '/uploads/../secret', '/uploads/%2e%2e/a', '/uploads/a%5cb', '/uploads/a?token=secret', '/uploads/%', '/uploads//a']) expect(isPrivateImageUrl(url)).toBe(false);
  expect(isPrivateImageUrl('/uploads/characters/hello%20friend.png')).toBe(true);
});

it('uses auth header and blob URL, revokes on unmount', async () => {
  setToken('session-a'); const fetcher = vi.spyOn(globalThis, 'fetch').mockResolvedValue(image());
  const load = vi.fn(), view = render(<PrivateImage src="/uploads/a.png" alt="伙伴" onLoad={load} />);
  const img = await screen.findByRole('img', { name: '伙伴' });
  await waitFor(() => expect(img.tagName === 'IMG' || screen.getByRole('img', { name: '伙伴' }).tagName === 'IMG').toBe(true));
  const loaded = screen.getByRole('img', { name: '伙伴' });
  expect(loaded).toHaveAttribute('src', 'blob:private-image');
  expect(fetcher).toHaveBeenCalledWith('/uploads/a.png', expect.objectContaining({ headers: { Authorization: 'Bearer session-a' }, cache: 'no-store', redirect: 'error' }));
  fireEvent.load(loaded); expect(load).toHaveBeenCalledOnce();
  view.unmount(); expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:private-image');
});

it('does not fetch without a session', () => {
  const fetcher = vi.spyOn(globalThis, 'fetch'); render(<PrivateImage src="/uploads/a.png" alt="伙伴" />);
  expect(screen.getByText('登录后查看形象')).toBeInTheDocument(); expect(fetcher).not.toHaveBeenCalled();
});

it('keeps an in-flight image when only the parent callback changes', async () => {
  setToken('session');
  let finish!: (response: Response) => void;
  const fetcher = vi.spyOn(globalThis, 'fetch').mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  const first = vi.fn(), latest = vi.fn();
  const view = render(<PrivateImage src="/uploads/a.png" alt="伙伴" onUnavailable={first} />);
  const signal = fetcher.mock.calls[0][1]?.signal as AbortSignal;
  view.rerender(<PrivateImage src="/uploads/a.png" alt="伙伴" onUnavailable={latest} />);
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(signal.aborted).toBe(false);
  await act(async () => finish(new Response('unavailable', { status: 503 })));
  expect(first).not.toHaveBeenCalled();
  expect(latest).toHaveBeenCalledOnce();
});

it('keeps the displayed blob across parent callback changes', async () => {
  setToken('session');
  const fetcher = vi.spyOn(globalThis, 'fetch').mockResolvedValue(image());
  const view = render(<PrivateImage src="/uploads/a.png" alt="伙伴" onUnavailable={() => {}} />);
  await waitFor(() => expect(screen.getByRole('img', { name: '伙伴' })).toHaveAttribute('src', 'blob:private-image'));
  view.rerender(<PrivateImage src="/uploads/a.png" alt="伙伴" onUnavailable={() => {}} />);
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(URL.revokeObjectURL).not.toHaveBeenCalled();
  expect(screen.getByRole('img', { name: '伙伴' })).toHaveAttribute('src', 'blob:private-image');
});

it('hides old account immediately and ignores late old responses', async () => {
  let first!: (response: Response) => void;
  setToken('old'); const fetcher = vi.spyOn(globalThis, 'fetch').mockImplementationOnce(() => new Promise(resolve => { first = resolve; })).mockResolvedValue(image());
  render(<PrivateImage src="/uploads/a.png" alt="伙伴" />);
  act(() => setToken('new'));
  await waitFor(() => expect(screen.getByRole('img', { name: '伙伴' })).toHaveAttribute('src', 'blob:private-image'));
  await act(async () => first(image()));
  expect(URL.createObjectURL).toHaveBeenCalledTimes(1);
  expect(fetcher).toHaveBeenLastCalledWith('/uploads/a.png', expect.objectContaining({ headers: { Authorization: 'Bearer new' } }));
  act(() => clearToken());
  expect(screen.getByText('登录后查看形象')).toBeInTheDocument();
  expect(screen.queryByRole('img', { name: '伙伴' })).not.toHaveAttribute('src');
  expect(URL.revokeObjectURL).toHaveBeenCalled();
});

it('clears previous portrait while loading a different one', async () => {
  setToken('session'); vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(image()).mockImplementationOnce(() => new Promise(() => {}));
  const view = render(<PrivateImage src="/uploads/a.png" alt="A" />);
  await waitFor(() => expect(screen.getByRole('img', { name: 'A' })).toHaveAttribute('src'));
  view.rerender(<PrivateImage src="/uploads/b.png" alt="B" />);
  expect(screen.getByRole('img', { name: 'B' })).not.toHaveAttribute('src');
  expect(URL.revokeObjectURL).toHaveBeenCalled();
});

it('offers explicit retry after failure without regenerating a companion', async () => {
  setToken('session'); const fetcher = vi.spyOn(globalThis, 'fetch').mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce(image());
  render(<PrivateImage src="/uploads/a.png" alt="伙伴" />);
  fireEvent.click(await screen.findByRole('button', { name: '重新加载形象' }));
  await waitFor(() => expect(screen.getByRole('img', { name: '伙伴' })).toHaveAttribute('src'));
  expect(fetcher).toHaveBeenCalledTimes(2);
});

it('old unauthorized response does not revoke a new session', async () => {
  let finish!: (response: Response) => void;
  setToken('old'); vi.spyOn(globalThis, 'fetch').mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  const result = privateImageBlob('/uploads/a.png', 'old', new AbortController().signal);
  setToken('new'); finish(new Response('{}', { status: 401 }));
  await expect(result).rejects.toThrow(); expect(getToken()).toBe('new');
});

it('rejects non-image responses', async () => {
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('html', { headers: { 'Content-Type': 'text/html' } }));
  await expect(privateImageBlob('/uploads/a.png', 'session', new AbortController().signal)).rejects.toThrow('形象格式');
});

it.each(['NEXT_PUBLIC_DEV_SMS_CODE', 'NEXT_PUBLIC_OFFLINE_PREVIEW', 'NEXT_PUBLIC_LIFE_RUNTIME_PREVIEW', 'NEXT_PUBLIC_MODEL_API_KEY'])('blocks production shortcut %s without logging its value', key => {
  expect(() => assertProductionConfig({ NODE_ENV: 'production', [key]: 'private-marker' })).toThrow(/Production configuration blocked/);
  try { assertProductionConfig({ NODE_ENV: 'production', [key]: 'private-marker' }); } catch (error) { expect(String(error)).not.toContain('private-marker'); }
});

it('allows clean production and local development previews', () => {
  expect(() => assertProductionConfig({ NODE_ENV: 'production', NEXT_PUBLIC_OFFLINE_PREVIEW: 'false', NEXT_PUBLIC_LIFE_RUNTIME_PREVIEW: 'false' })).not.toThrow();
  expect(() => assertProductionConfig({ NODE_ENV: 'development', NEXT_PUBLIC_DEV_SMS_CODE: '123456' })).not.toThrow();
});

it('notifies a stable static-failure callback without looping requests', async () => {
  setToken('session-a');
  const fetcher=vi.spyOn(globalThis,'fetch').mockResolvedValue(new Response('',{status:404}));
  const unavailable=vi.fn();
  render(<PrivateImage src="/uploads/a.png" alt="伙伴" onUnavailable={unavailable} />);
  await waitFor(()=>expect(unavailable).toHaveBeenCalledOnce());
  expect(fetcher).toHaveBeenCalledOnce();
  expect(screen.getByRole('img')).toHaveTextContent('暂时看不到');
});
