import { useEffect, useState } from 'react';
import { act, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import PrivateMotionPlayer from '@/components/private-motion-player';
import { clearToken, setToken } from '@/lib/auth';
import { loadPreparedActivityMotion } from '@/lib/motion-preparation';
import type { LoadedMotion } from '@/lib/private-motion';

vi.mock('@/lib/motion-preparation', () => ({ loadPreparedActivityMotion: vi.fn() }));
vi.mock('@/components/motion-player', () => ({ default: function Consumer({ loadAsset }: { loadAsset: (signal: AbortSignal) => Promise<LoadedMotion> }) {
  const [value, setValue] = useState('');
  useEffect(() => {
    const controller = new AbortController(); let dispose = () => {};
    void loadAsset(controller.signal).then(result => {
      if (controller.signal.aborted) { result.dispose(); return; }
      dispose = result.dispose; setValue(result.asset?.videoUrl ?? 'missing');
    }).catch(() => {});
    return () => { controller.abort(); dispose(); };
  }, [loadAsset]);
  return <output>{value}</output>;
} }));
const loader = vi.mocked(loadPreparedActivityMotion);
const result = (name: string): LoadedMotion => ({ asset: { videoUrl: `blob:${name}`, durationMs: 5000,
  spriteUrl: '', backgroundUrl: '', frameWidth: 640, frameHeight: 640, frameCount: 1, fps: 24 }, dispose: vi.fn() });
afterEach(() => { clearToken(); vi.resetAllMocks(); });

it('revisits a loaded action without another read and releases both actions when the preview closes', async () => {
  setToken('owner'); const rest = result('rest'), walk = result('walk');
  loader.mockResolvedValueOnce(rest).mockResolvedValueOnce(walk);
  const base = { id: 2, src: '/uploads/leaf.png', name: '叶叶', resourceKey: '0-true', reuseLoadedActions: true };
  const view = render(<PrivateMotionPlayer {...base} activity="rest" />);
  await screen.findByText('blob:rest');
  view.rerender(<PrivateMotionPlayer {...base} activity="walk" />); await screen.findByText('blob:walk');
  view.rerender(<PrivateMotionPlayer {...base} activity="rest" />); await screen.findByText('blob:rest');
  expect(loader).toHaveBeenCalledTimes(2); expect(rest.dispose).not.toHaveBeenCalled(); expect(walk.dispose).not.toHaveBeenCalled();
  view.unmount(); expect(rest.dispose).toHaveBeenCalledOnce(); expect(walk.dispose).toHaveBeenCalledOnce();
});

it('account, portrait, and explicit status revision changes require fresh reads and release old resources', async () => {
  setToken('A'); const resources = ['A', 'B', 'new-photo', 'new-revision'].map(result);
  for (const resource of resources) loader.mockResolvedValueOnce(resource);
  const base = { id: 2, src: '/uploads/leaf.png', name: '叶叶', activity: 'rest' as const, resourceKey: '0-true', reuseLoadedActions: true };
  const view = render(<PrivateMotionPlayer {...base} />); await screen.findByText('blob:A');
  act(() => setToken('B')); await screen.findByText('blob:B'); expect(resources[0].dispose).toHaveBeenCalledOnce();
  expect(loader.mock.calls[1][1]).toBe('B');
  view.rerender(<PrivateMotionPlayer {...base} src="/uploads/new.png" />); await screen.findByText('blob:new-photo');
  expect(resources[1].dispose).toHaveBeenCalledOnce();
  view.rerender(<PrivateMotionPlayer {...base} src="/uploads/new.png" resourceKey="1-true" />); await screen.findByText('blob:new-revision');
  expect(resources[2].dispose).toHaveBeenCalledOnce();
  act(() => clearToken()); await waitFor(() => expect(screen.getByText('登录后查看伙伴形象')).toBeInTheDocument());
  expect(resources[3].dispose).toHaveBeenCalledOnce(); expect(loader).toHaveBeenCalledTimes(4); view.unmount();
});
