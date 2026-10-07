/* eslint-disable @next/next/no-img-element -- Synthetic static-image boundary for ownership regression. */
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import PrivateMotionPlayer from '@/components/private-motion-player';
import { clearToken, setToken } from '@/lib/auth';
import { loadPrivateMotion, type LoadedMotion } from '@/lib/private-motion';

vi.mock('@/lib/private-motion', () => ({ loadPrivateMotion: vi.fn() }));
vi.mock('@/components/private-image', () => ({
  default: ({ src, alt, onLoad }: {src: string; alt: string; onLoad: () => void}) => <img src={src} alt={alt} onLoad={onLoad} />,
}));
afterEach(() => { clearToken(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

it('removes the old account player immediately and disposes its late result', async () => {
  vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() }));
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => setTimeout(() => callback(performance.now()), 0));
  vi.stubGlobal('cancelAnimationFrame', clearTimeout);
  let finish!: (result: LoadedMotion) => void;
  const dispose = vi.fn();
  vi.mocked(loadPrivateMotion).mockImplementationOnce(() => new Promise(done => { finish = done; }));
  setToken('account-a');
  render(<PrivateMotionPlayer id={7} src="/uploads/own.png" name="本人伙伴" />);
  fireEvent.load(screen.getByRole('img'));
  await waitFor(() => expect(loadPrivateMotion).toHaveBeenCalledTimes(1));
  const oldSignal = vi.mocked(loadPrivateMotion).mock.calls[0][2];
  act(() => setToken('account-b'));
  expect(oldSignal.aborted).toBe(true);
  await act(async () => finish({ asset: null, dispose }));
  expect(dispose).toHaveBeenCalled();
  expect(screen.getByRole('status')).toHaveTextContent('正在准备');
  act(() => clearToken());
  expect(screen.queryByRole('img')).not.toBeInTheDocument();
  expect(screen.getByText('登录后查看伙伴形象')).toBeInTheDocument();
});
