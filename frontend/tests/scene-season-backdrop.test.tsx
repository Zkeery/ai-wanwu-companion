import { beforeEach, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import LivingScene from '@/components/living-scene';
import SceneSeasonBackdrop, { type SeasonalScene } from '@/components/scene-season-backdrop';
import { seasonApi, type Season, type SeasonSnapshot } from '@/lib/seasons';
import { api } from '@/lib/api';
import type { LivingSpace } from '@/lib/contracts';
vi.mock('@/components/space-decorations', () => ({ default: () => null }));
vi.mock('@/components/life-journal', () => ({ default: () => null }));
vi.mock('@/lib/seasons', async original => ({ ...await original<typeof import('@/lib/seasons')>(), seasonApi: { read: vi.fn(), preview: vi.fn(), save: vi.fn() } }));
vi.mock('@/lib/api', async original => ({ ...await original<typeof import('@/lib/api')>(), api: { living: { action: vi.fn(), space: vi.fn() } } }));
const empty: SeasonSnapshot = { settings: null, current_season: null, started_at: null, next_change_at: null, revision: 0, observed_at: 100, timezone: 'Asia/Shanghai' };
const autumn: SeasonSnapshot = { ...empty, settings: { mode: 'virtual', weeks: 2, start_season: 'autumn' }, current_season: 'autumn', started_at: 100, next_change_at: 1209700 };
const space = (scene: SeasonalScene): LivingSpace => ({ id: scene, scene_type: scene, mode: 'private', companion_id: '6', revision: 3, observed_at: 100, can_undo: true, items: [{ id: 'tree', kind: 'tree', x: .3, y: .4, stored: false, growth_seconds: 40, stage: 'growing', care_remaining_seconds: 100, growth_status: 'growing' }] });
beforeEach(() => { vi.clearAllMocks(); vi.mocked(seasonApi.read).mockResolvedValue(empty); vi.mocked(seasonApi.preview).mockResolvedValue(autumn); vi.mocked(seasonApi.save).mockResolvedValue({ ...autumn, revision: 1 }); });
async function preview() {
  await waitFor(() => expect(screen.getByRole('button', { name: '设置四季' })).toBeEnabled());
  fireEvent.click(screen.getByRole('button', { name: '设置四季' })); fireEvent.click(screen.getByLabelText('虚拟四季'));
  fireEvent.change(screen.getByLabelText('每季多久'), { target: { value: '2' } }); fireEvent.change(screen.getByLabelText('从哪个季节开始'), { target: { value: 'autumn' } });
  fireEvent.click(screen.getByRole('button', { name: '预览效果' })); await screen.findByRole('button', { name: '确认设置' });
}
it.each(['home', 'forest'] as SeasonalScene[])('previews %s without changing the saved scene, then cancels without writes', async scene => {
  render(<LivingScene space={space(scene)} onChange={vi.fn()} />); await preview();
  const board = screen.getByRole('group', { name: '场景' }); expect(board).toHaveAttribute('data-season', 'base'); expect(board.querySelector('img')).toBeNull();
  expect(document.querySelector('figure img')).toHaveAttribute('src', new URL(`/seasons/${scene}-four-seasons-v1.png`, window.location.href).href);
  fireEvent.click(screen.getByRole('button', { name: '稍后选择' })); expect(document.querySelector('figure')).toBeNull();
  expect(seasonApi.save).not.toHaveBeenCalled(); expect(api.living.action).not.toHaveBeenCalled();
});
it.each(['home', 'forest'] as SeasonalScene[])('applies a confirmed %s background without moving or growing objects', async scene => {
  const change = vi.fn(); render(<LivingScene space={space(scene)} onChange={change} />); const item = screen.getByRole('button', { name: /小树·成长中/ }), before = item.getAttribute('style');
  await preview(); fireEvent.click(screen.getByRole('button', { name: '确认设置' })); await screen.findByText('四季已保存，场景现在生效。');
  const board = screen.getByRole('group', { name: '场景' }); expect(board).toHaveAttribute('data-season', 'autumn'); expect(board.querySelector('img')).toHaveStyle({ left: '0%', top: '-100%' });
  expect(item.getAttribute('style')).toBe(before); expect(change).not.toHaveBeenCalled(); expect(api.living.action).not.toHaveBeenCalled();
  expect(seasonApi.save).toHaveBeenCalledExactlyOnceWith(scene, autumn.settings, 0, expect.any(String), expect.any(AbortSignal));
});
it.each((['home', 'forest'] as SeasonalScene[]).flatMap(scene => (['spring', 'summer', 'autumn', 'winter'] as Season[]).map(season => [scene, season] as const)))('restores %s %s from server state without saving', async (scene, season) => {
  vi.mocked(seasonApi.read).mockResolvedValue({ ...autumn, current_season: season }); render(<LivingScene space={space(scene)} onChange={vi.fn()} readOnly />);
  const board = screen.getByRole('group', { name: '场景' }); await waitFor(() => expect(board).toHaveAttribute('data-season', season));
  expect(board.querySelector('img')).toHaveAttribute('src', new URL(`/seasons/${scene}-four-seasons-v1.png`, window.location.href).href);
  expect(seasonApi.save).not.toHaveBeenCalled(); expect(screen.queryByRole('button', { name: '调整四季' })).toBeNull();
});
it('falls back, retries without a canvas click, and clears errors when switching scenes', () => {
  const clicked = vi.fn(); const view = render(<div onClick={clicked}><SceneSeasonBackdrop scene="home" season="winter" /></div>);
  fireEvent.error(view.container.querySelector('img')!); expect(screen.getByRole('status')).toHaveTextContent('保留基础景色'); expect(view.container.querySelector('img')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: '重试季节画面' })); expect(clicked).not.toHaveBeenCalled();
  expect(view.container.querySelector('img')).toHaveAttribute('src', new URL('/seasons/home-four-seasons-v1.png?retry=1', window.location.href).href);
  fireEvent.error(view.container.querySelector('img')!); view.rerender(<SceneSeasonBackdrop scene="forest" season="winter" />);
  expect(screen.queryByRole('status')).toBeNull(); expect(view.container.querySelector('img')).toHaveAttribute('src', new URL('/seasons/forest-four-seasons-v1.png', window.location.href).href);
});
it('keeps seasonal artwork while rain is enabled, without starting audio or a scene mutation', async () => {
  vi.mocked(seasonApi.read).mockResolvedValue(autumn); render(<LivingScene space={{ ...space('home'), atmosphere: { rain: true, sound: true } }} onChange={vi.fn()} />);
  const board = screen.getByRole('group', { name: '场景' }); await waitFor(() => expect(board).toHaveAttribute('data-season', 'autumn'));
  expect(board.querySelector('img')).not.toBeNull(); expect(screen.getByLabelText('庭院正在下小雨')).toBeInTheDocument(); expect(api.living.action).not.toHaveBeenCalled();
});
it('keeps the confirmed main scene after a failed save is reconciled to old settings', async () => {
  vi.mocked(seasonApi.save).mockRejectedValue(new Error('offline')); render(<LivingScene space={space('home')} onChange={vi.fn()} />);
  await preview(); fireEvent.click(screen.getByRole('button', { name: '确认设置' })); await screen.findByText(/已核对服务器设置/);
  expect(screen.getByRole('group', { name: '场景' })).toHaveAttribute('data-season', 'base'); expect(seasonApi.save).toHaveBeenCalledTimes(1);
});
it('does not request an atlas when no season has been selected', () => {
  const view = render(<SceneSeasonBackdrop scene="forest" season={null} />); expect(view.container.querySelector('img')).toBeNull();
});
