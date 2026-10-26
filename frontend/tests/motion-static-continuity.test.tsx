import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import CompanionMotionPreview from '@/components/companion-motion-preview';
import { setToken, clearToken } from '@/lib/auth';
import { privateImageBlob } from '@/lib/private-images';
import { loadPrivateMotion, type LoadedMotion } from '@/lib/private-motion';
import { loadPreparedActivityMotion, readMotionPreparation } from '@/lib/motion-preparation';

vi.mock('@/lib/private-images', () => ({ privateImageBlob: vi.fn() }));
vi.mock('@/lib/private-motion', () => ({ loadPrivateMotion: vi.fn() }));
vi.mock('@/lib/motion-preparation', () => ({
  readMotionPreparation: vi.fn(), loadPreparedActivityMotion: vi.fn(),
}));
vi.mock('@/components/motion-candidate-review', () => ({ default: () => null }));
vi.mock('@/components/motion-generation-status', () => ({ default: () => null }));
const props = { id: 7, src: '/uploads/own.png', name: '本人伙伴' };
const empty = { rest: 'waiting_source', walk: 'waiting_source', observe: 'waiting_source' } as const;
const allReady = { rest: 'ready', walk: 'ready', observe: 'ready' } as const;
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal('fetch', vi.fn(() => { throw new Error('Network disabled in continuity regression'); }));
  vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() }));
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => setTimeout(() => callback(performance.now()), 0));
  vi.stubGlobal('cancelAnimationFrame', clearTimeout);
  vi.stubGlobal('URL', Object.assign(URL, { createObjectURL: vi.fn(() => 'blob:private-portrait'), revokeObjectURL: vi.fn() }));
  Object.defineProperty(document, 'hidden', { value: false, configurable: true });
  vi.mocked(privateImageBlob).mockResolvedValue(new Blob(['synthetic'], { type: 'image/png' }));
  vi.mocked(loadPrivateMotion).mockResolvedValue({ asset: null, dispose: vi.fn() });
  vi.mocked(loadPreparedActivityMotion).mockResolvedValue({ asset: null, dispose: vi.fn() });
  vi.mocked(readMotionPreparation).mockResolvedValue(empty);
  setToken('account-a');
});
afterEach(() => { clearToken(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });
async function portrait() {
  const image = await waitFor(() => {
    const current = screen.getByRole('img', { name: props.name });
    expect(current).toHaveAttribute('src', 'blob:private-portrait');
    return current;
  });
  fireEvent.load(image);
  return image;
}
it('keeps the decoded portrait through all activity changes without requesting the image again', async () => {
  vi.mocked(readMotionPreparation).mockResolvedValue(allReady);
  render(<CompanionMotionPreview {...props} activity="walk" />);
  const image = await portrait();
  await waitFor(() => expect(loadPreparedActivityMotion).toHaveBeenCalledTimes(1));
  for (const label of ['散步', '休息', '观察', '默认动作']) {
    fireEvent.click(screen.getByRole('button', { name: label }));
    expect(screen.getByRole('img', { name: props.name })).toBe(image);
    expect(privateImageBlob).toHaveBeenCalledTimes(1);
  }
  await waitFor(() => expect(loadPrivateMotion).toHaveBeenCalledTimes(1));
  expect(screen.getByRole('img', { name: props.name })).toBe(image);
});
it('observes queued readiness without removing or fetching the visible portrait', async () => {
  vi.mocked(readMotionPreparation).mockResolvedValueOnce({ ...empty, walk: 'queued' }).mockResolvedValue({ ...empty, walk: 'ready' });
  render(<CompanionMotionPreview {...props} activity="walk" />);
  const image = await portrait();
  await waitFor(() => expect(loadPreparedActivityMotion).toHaveBeenCalledTimes(1));
  await screen.findByRole('button', { name: '散步' }, { timeout: 2000 });
  expect(screen.getByRole('img', { name: props.name })).toBe(image);
  expect(privateImageBlob).toHaveBeenCalledTimes(1);
  await waitFor(() => expect(vi.mocked(loadPreparedActivityMotion).mock.calls.length).toBeGreaterThan(1));
});
it('aborts a slow old action and disposes its late result while keeping the portrait visible', async () => {
  let finish!: (result: LoadedMotion) => void;
  const dispose = vi.fn();
  vi.mocked(loadPrivateMotion).mockImplementationOnce(() => new Promise(done => { finish = done; }));
  let ready!: (value: typeof allReady) => void;
  vi.mocked(readMotionPreparation).mockImplementationOnce(() => new Promise(resolve => { ready = resolve; }));
  render(<CompanionMotionPreview {...props} />);
  const image = await portrait();
  await waitFor(() => expect(loadPrivateMotion).toHaveBeenCalledTimes(1));
  const signal = vi.mocked(loadPrivateMotion).mock.calls[0][2];
  await act(async () => ready(allReady));
  fireEvent.click(screen.getByRole('button', { name: '观察' }));
  expect(signal.aborted).toBe(true);
  expect(screen.getByRole('img', { name: props.name })).toBe(image);
  await act(async () => finish({ asset: null, dispose }));
  expect(dispose).toHaveBeenCalledTimes(1);
  expect(screen.queryByText('这类动作还没准备好，先看看静态形象')).not.toBeInTheDocument();
  expect(screen.queryByText('正在跳舞')).not.toBeInTheDocument();
  expect(privateImageBlob).toHaveBeenCalledTimes(1);
});

it('starts a chosen video when ready and can play it again without refetching the portrait or action', async () => {
  const decoders: HTMLVideoElement[] = [];
  vi.spyOn(HTMLMediaElement.prototype, 'load').mockImplementation(function(this: HTMLVideoElement) {
    if (this.src) decoders.push(this);
  });
  const play = vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue();
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {});
  vi.mocked(loadPreparedActivityMotion).mockResolvedValue({ asset: {
    videoUrl: 'blob:walk', spriteUrl: '', backgroundUrl: '', frameWidth: 480, frameHeight: 480,
    frameCount: 1, fps: 24, durationMs: 4000, activity: 'walk',
  }, dispose: vi.fn() });
  vi.mocked(readMotionPreparation).mockResolvedValue({ ...empty, walk: 'ready' });
  render(<CompanionMotionPreview {...props} />);
  const image = await portrait();
  fireEvent.click(await screen.findByRole('button', { name: '散步' }));
  await waitFor(() => expect(decoders).toHaveLength(1));
  const decoder = decoders[0];
  Object.defineProperties(decoder, { videoWidth: { value: 480 }, videoHeight: { value: 480 }, duration: { value: 4 } });
  act(() => decoder.dispatchEvent(new Event('loadeddata')));
  await waitFor(() => expect(play).toHaveBeenCalledTimes(1));
  expect(image.parentElement?.className).not.toContain('playingPortrait');
  fireEvent.playing(document.querySelector('video')!);
  expect(image.parentElement?.className).toContain('playingPortrait');
  fireEvent.mouseLeave(image.parentElement!);
  expect(screen.getByRole('button', { name: '看看散步动作' })).toHaveAttribute('aria-pressed', 'false');
  fireEvent.click(screen.getByRole('button', { name: '散步' }));
  await waitFor(() => expect(play).toHaveBeenCalledTimes(2));
  expect(privateImageBlob).toHaveBeenCalledTimes(1);
  expect(loadPreparedActivityMotion).toHaveBeenCalledTimes(1);
  expect(screen.getByRole('img', { name: props.name })).toBe(image);
});
