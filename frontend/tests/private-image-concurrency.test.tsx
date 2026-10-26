import React from 'react';
import { act, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import PrivateImage from '@/components/private-image';
import { clearToken, setToken } from '@/lib/auth';
import { privateImageBlob } from '@/lib/private-images';

const image = () => new Response('synthetic', { headers: { 'Content-Type': 'image/png' } });
const controller = () => new AbortController();
function deferred() {
  let resolve!: (response: Response) => void, reject!: (error: Error) => void;
  const promise = new Promise<Response>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}
beforeEach(() => { vi.restoreAllMocks(); clearToken(); localStorage.clear(); });

it('four concurrent portraits share one authenticated no-store download', async () => {
  const request = deferred(), fetcher = vi.spyOn(globalThis, 'fetch').mockReturnValue(request.promise);
  const results = Array.from({ length: 4 }, () => privateImageBlob('/uploads/shared.png', 'owner', controller().signal));
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(fetcher).toHaveBeenCalledWith('/uploads/shared.png?preview=true', expect.objectContaining({ headers: { Authorization: 'Bearer owner' }, cache: 'no-store', redirect: 'error' }));
  request.resolve(image());
  const blobs = await Promise.all(results);
  expect(blobs.every(blob => blob === blobs[0])).toBe(true);
});

it('keeps account and URL boundaries even while downloads overlap', async () => {
  const request = deferred(), fetcher = vi.spyOn(globalThis, 'fetch').mockImplementation(() => request.promise.then(() => image()));
  const results = [privateImageBlob('/uploads/a.png', 'A', controller().signal), privateImageBlob('/uploads/a.png', 'B', controller().signal), privateImageBlob('/uploads/b.png', 'A', controller().signal)];
  expect(fetcher).toHaveBeenCalledTimes(3);
  request.resolve(image()); await Promise.all(results);
});

it('cancelling one image leaves another subscriber downloading', async () => {
  const request = deferred(), a = controller(), b = controller();
  const fetcher = vi.spyOn(globalThis, 'fetch').mockReturnValue(request.promise);
  const first = privateImageBlob('/uploads/cancel.png', 'owner', a.signal);
  const firstOutcome = first.catch(error => error);
  const second = privateImageBlob('/uploads/cancel.png', 'owner', b.signal);
  a.abort();
  expect((fetcher.mock.calls[0][1]?.signal as AbortSignal).aborted).toBe(false);
  expect((await firstOutcome).name).toBe('AbortError');
  request.resolve(image()); await expect(second).resolves.toMatchObject({ type: 'image/png' });
});

it('last cancellation aborts the request and late cleanup cannot remove a fresh download', async () => {
  const old = deferred(), fresh = deferred(), a = controller();
  const fetcher = vi.spyOn(globalThis, 'fetch').mockReturnValueOnce(old.promise).mockReturnValueOnce(fresh.promise);
  const first = privateImageBlob('/uploads/rejoin.png', 'owner', a.signal).catch(error => error);
  const oldSignal = fetcher.mock.calls[0][1]?.signal as AbortSignal;
  a.abort(); expect(oldSignal.aborted).toBe(true); await first;
  const second = privateImageBlob('/uploads/rejoin.png', 'owner', controller().signal);
  // A server or mock can finish after cancellation. It must not evict the new request.
  old.resolve(image()); await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
  const third = privateImageBlob('/uploads/rejoin.png', 'owner', controller().signal);
  expect(fetcher).toHaveBeenCalledTimes(2);
  fresh.resolve(image()); const [b, c] = await Promise.all([second, third]); expect(b).toBe(c);
});

it('does not retain off-session blobs or retry failed requests automatically', async () => {
  const fetcher = vi.spyOn(globalThis, 'fetch').mockRejectedValueOnce(new Error('offline')).mockImplementation(async () => image());
  await expect(privateImageBlob('/uploads/uncached.png', 'owner', controller().signal)).rejects.toThrow('offline');
  expect(fetcher).toHaveBeenCalledTimes(1);
  await privateImageBlob('/uploads/uncached.png', 'owner', controller().signal);
  await privateImageBlob('/uploads/uncached.png', 'owner', controller().signal);
  expect(fetcher).toHaveBeenCalledTimes(3);
});

it('late subscribers receive progress and cancelled or broken callbacks cannot affect others', async () => {
  const request = deferred(), a = controller(), stages: string[] = [], late: string[] = [];
  vi.spyOn(globalThis, 'fetch').mockReturnValue(request.promise);
  const first = privateImageBlob('/uploads/stages.png', 'owner', a.signal, s => stages.push(s)).catch(error => error);
  expect(stages).toEqual(['image_request_started']);
  const second = privateImageBlob('/uploads/stages.png', 'owner', controller().signal, s => late.push(s));
  const broken = privateImageBlob('/uploads/stages.png', 'owner', controller().signal, () => { throw Error('diagnostic'); });
  a.abort(); request.resolve(image()); await Promise.all([first, second, broken]);
  expect(stages).toEqual(['image_request_started']);
  expect(late).toEqual(['image_request_started', 'image_response_headers', 'image_bytes_ready']);
});

it('rejects an already cancelled consumer before starting a download', async () => {
  const a = controller(); a.abort(); const fetcher = vi.spyOn(globalThis, 'fetch');
  await expect(privateImageBlob('/uploads/aborted.png', 'owner', a.signal)).rejects.toMatchObject({ name: 'AbortError' });
  expect(fetcher).not.toHaveBeenCalled();
});

it('one mounted portrait can unmount while its sibling finishes and owns its blob URL', async () => {
  setToken('owner'); const request = deferred(), fetcher = vi.spyOn(globalThis, 'fetch').mockReturnValue(request.promise);
  URL.createObjectURL = vi.fn(() => 'blob:sibling'); URL.revokeObjectURL = vi.fn();
  const view = render(<><PrivateImage key="a" src="/uploads/siblings.png" alt="A" /><PrivateImage key="b" src="/uploads/siblings.png" alt="B" /></>);
  expect(fetcher).toHaveBeenCalledTimes(1);
  view.rerender(<><PrivateImage key="b" src="/uploads/siblings.png" alt="B" /></>);
  expect((fetcher.mock.calls[0][1]?.signal as AbortSignal).aborted).toBe(false);
  await act(async () => request.resolve(image()));
  await waitFor(() => expect(screen.getByAltText('B')).toHaveAttribute('src', 'blob:sibling'));
  expect(URL.createObjectURL).toHaveBeenCalledTimes(1);
  view.unmount(); expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:sibling');
});
