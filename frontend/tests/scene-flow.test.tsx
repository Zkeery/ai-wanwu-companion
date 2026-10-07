import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import ScenePicker from '@/app/companions/[id]/scenes/page';
import ScenePage from '@/app/companions/[id]/scenes/[type]/page';
import LivingScene from '@/components/living-scene';
import { api, ApiError } from '@/lib/api';
import type { LivingSpace } from '@/lib/contracts';

vi.mock('next/navigation', () => ({ useParams: () => ({ id: '9', type: 'home' }), useRouter: () => ({ push: vi.fn() }) }));
vi.mock('@/lib/seasons', async original => ({ ...await original<typeof import('@/lib/seasons')>(), seasonApi: { read: vi.fn().mockResolvedValue({ settings: null, current_season: null, revision: 0, started_at: null, next_change_at: null, observed_at: 1, timezone: 'Asia/Shanghai' }) } }));
vi.mock('@/lib/api', async original => ({ ...await original<typeof import('@/lib/api')>(), api: { character: vi.fn(), characters: vi.fn(), characterOverview: vi.fn(), living: { spaces: vi.fn(), location: vi.fn(), setLocation: vi.fn(), create: vi.fn(), space: vi.fn(), members: vi.fn(), action: vi.fn() } } }));
const space: LivingSpace = { id: 'space-1', scene_type: 'home', mode: 'private', companion_id: '9', revision: 1, observed_at: 1, items: [], can_undo: false };
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(api.character).mockResolvedValue({ id: 9, name: '果果', persona: '活泼', opening_line: '你好', image_path: null, status: 'ready', created_at: '' });
  vi.mocked(api.characters).mockResolvedValue([]);
  vi.mocked(api.characterOverview).mockResolvedValue([]);
  vi.mocked(api.living.spaces).mockResolvedValue([space]);
  vi.mocked(api.living.location).mockResolvedValue(null);
  vi.mocked(api.living.setLocation).mockResolvedValue(null);
  vi.mocked(api.living.space).mockResolvedValue(space);
});
it('retries a failed scene picker read', async () => {
  vi.mocked(api.living.spaces).mockRejectedValueOnce(new Error('连接断开'));
  render(<ScenePicker />);
  fireEvent.click(await screen.findByRole('button', { name: /重新加载/ }));
  expect(await screen.findByText('家庭庭院')).toBeInTheDocument();
  expect(api.living.spaces).toHaveBeenCalledTimes(2);
});
it('retries a failed scene detail read', async () => {
  vi.mocked(api.living.space).mockRejectedValueOnce(new Error('连接断开'));
  render(<ScenePage />);
  fireEvent.click(await screen.findByRole('button', { name: /重新加载/ }));
  expect(await screen.findByRole('heading', { name: '家庭庭院' })).toBeInTheDocument();
  expect(api.living.space).toHaveBeenCalledTimes(2);
});
it('does not move the companion when opening an existing scene directly', async () => {
  render(<ScenePage />);
  await screen.findByRole('heading', { name: '家庭庭院' });
  expect(api.living.setLocation).not.toHaveBeenCalled();
});
it('provides safe exits when the current account cannot read a companion', async () => {
  vi.mocked(api.living.location).mockRejectedValueOnce(new ApiError('伙伴不存在', 404, 'not_found'));
  render(<ScenePage />);
  expect(await screen.findByText(/当前账号无法打开这个伙伴或场景/)).toBeInTheDocument();
  expect(screen.getByRole('link', { name: '返回我的伙伴' })).toHaveAttribute('href', '/');
  expect(screen.getByRole('link', { name: '看四季画面' })).toHaveAttribute('href', '/scene-preview');
  expect(screen.queryByRole('button', { name: /重新加载/ })).not.toBeInTheDocument();
  expect(api.living.create).not.toHaveBeenCalled();
  expect(api.living.setLocation).not.toHaveBeenCalled();
});
it('recovers the latest revision after a conflicting action without replaying it', async () => {
  const change = vi.fn();
  vi.mocked(api.living.action).mockRejectedValueOnce(new ApiError('场景已更新', 409, 'conflict'));
  vi.mocked(api.living.space).mockResolvedValueOnce({ ...space, revision: 2 });
  render(<LivingScene space={space} onChange={change} />);
  fireEvent.click(screen.getByRole('button', { name: '布置场景' }));
  fireEvent.click(screen.getByRole('button', { name: /小树/ }));
  await waitFor(() => expect(change).toHaveBeenCalledWith(expect.objectContaining({ revision: 2 })));
  expect(api.living.action).toHaveBeenCalledTimes(1);
});
