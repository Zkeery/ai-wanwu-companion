import React from 'react';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import ScenePicker from '@/app/companions/[id]/scenes/page';
import ScenePage from '@/app/companions/[id]/scenes/[type]/page';
import { api } from '@/lib/api';
import type { Character, CharacterOverview, LivingSpace, SpaceSummary } from '@/lib/contracts';

const nav = vi.hoisted(() => ({ params: { id: '9', type: 'home', spaceId: undefined as string | undefined }, push: vi.fn() }));
vi.mock('next/navigation', () => ({ useParams: () => nav.params, useRouter: () => ({ push: nav.push }) }));
vi.mock('@/lib/api', async original => ({ ...await original<typeof import('@/lib/api')>(), api: { character: vi.fn(), characters: vi.fn(), characterOverview: vi.fn(), living: { spaces: vi.fn(), location: vi.fn(), setLocation: vi.fn(), create: vi.fn(), space: vi.fn(), members: vi.fn(), action: vi.fn(), addMember: vi.fn(), removeMember: vi.fn() } } }));
const personal: LivingSpace = { id: 'private-9', scene_type: 'home', mode: 'private', companion_id: '9', revision: 2, observed_at: 1, items: [], can_undo: false };
const shared: SpaceSummary = { id: 'shared-1', scene_type: 'home', mode: 'shared', companion_id: null, revision: 3, members: [{ companion_id: '9', name: '果果' }] };
const characters: Character[] = [9, 10, 11].map(id => ({ id, name: '果果', persona: '活泼', opening_line: '你好', image_path: null, status: id === 11 ? 'failed' : 'ready', created_at: '' }));
let spaces: SpaceSummary[], location: string | null;
beforeEach(() => {
  vi.resetAllMocks(); nav.params = { id: '9', type: 'home', spaceId: undefined };
  spaces = [personal, { ...shared, members: [...shared.members!] }]; location = personal.id;
  vi.mocked(api.character).mockResolvedValue({ id: 9, name: '果果', persona: '活泼', opening_line: '你好', image_path: null, status: 'ready', created_at: '' });
  vi.mocked(api.characters).mockResolvedValue(characters);
  vi.mocked(api.characterOverview).mockImplementation(async () => characters.filter(c => c.status === 'ready').map(c => {
    const found = c.id === 9 ? spaces.find(s => s.id === location) : undefined;
    return { character: c, residence: found ? { space_id: found.id, scene_type: found.scene_type, mode: found.mode } : null,
      gathering: c.id === 9 && location && !found ? { id: location, title: '小队庭院' } : null,
      last_interaction_at: null, recent_activity: [] } as CharacterOverview;
  }));
  vi.mocked(api.living.spaces).mockImplementation(async () => spaces.map(s => ({ ...s, members: s.members ? [...s.members] : undefined })));
  vi.mocked(api.living.location).mockImplementation(async () => location);
  vi.mocked(api.living.setLocation).mockImplementation(async (_, id) => { location = id; return null; });
  vi.mocked(api.living.addMember).mockImplementation(async (id, c) => { spaces.find(s => s.id === id)!.members!.push({ companion_id: String(c), name: '果果' }); return null; });
  vi.mocked(api.living.removeMember).mockImplementation(async (id, c) => { const s = spaces.find(s => s.id === id)!; s.members = s.members!.filter(m => m.companion_id !== String(c)); if (c === 9 && location === id) location = null; return null; });
  vi.mocked(api.living.space).mockImplementation(async id => ({ ...personal, ...spaces.find(s => s.id === id), id }));
  vi.mocked(api.living.members).mockImplementation(async id => spaces.find(s => s.id === id)?.members ?? []);
});
async function sharedHome() {
  render(<ScenePicker />);
  fireEvent.click(await screen.findByRole('radio', { name: /和我的其他伙伴同住/ }));
  return within(screen.getByRole('article', { name: '家庭庭院' }));
}
it('reuses an existing shared instance without creating or adding an existing member', async () => {
  const home = await sharedHome();
  fireEvent.click(home.getByRole('button', { name: /搬进这个同住空间/ }));
  await waitFor(() => expect(nav.push).toHaveBeenCalledWith('/companions/9/scenes/home/shared-1'));
  expect(api.living.create).not.toHaveBeenCalled(); expect(api.living.addMember).not.toHaveBeenCalled();
});
it('adds only ready account companions, distinguishes duplicate names, and does not move invitees', async () => {
  const home = await sharedHome();
  expect(home.getByRole('option', { name: '果果 · #10' })).toBeInTheDocument();
  expect(home.queryByRole('option', { name: '果果 · #11' })).not.toBeInTheDocument();
  fireEvent.click(home.getByRole('button', { name: '加入成员' }));
  await screen.findByText(/已加入同住成员/);
  expect(api.living.addMember).toHaveBeenCalledWith('shared-1', 10);
  expect(api.living.setLocation).not.toHaveBeenCalled();
  expect(home.getByRole('button', { name: '移出果果 #10' })).toBeInTheDocument();
});
it('removes current member and reads back cleared location without deleting the shared space', async () => {
  location = shared.id;
  const home = await sharedHome();
  fireEvent.click(home.getByRole('button', { name: '移出果果 #9' }));
  await screen.findByText(/已移出同住成员/);
  expect(location).toBeNull(); expect(spaces.find(s => s.id === shared.id)).toBeDefined();
  expect(home.queryByText('当前所在')).not.toBeInTheDocument();
});
it('creates only on explicit request and blocks consecutive clicks', async () => {
  let resolve!: (v: LivingSpace) => void;
  vi.mocked(api.living.create).mockReturnValue(new Promise(r => { resolve = r; }));
  const home = await sharedHome(), button = home.getByRole('button', { name: '再建一个同住空间' });
  fireEvent.click(button); fireEvent.click(button);
  expect(api.living.create).toHaveBeenCalledTimes(1);
  expect(api.living.create).toHaveBeenCalledWith('home', 'shared');
  spaces.push({ ...shared, id: 'shared-2', members: [] });
  resolve({ ...personal, ...spaces[2] });
  await screen.findByText(/同住空间已准备好/);
  expect(home.getByLabelText('选择同住空间')).toHaveValue('shared-2');
});
it('reconciles a lost creation response and exposes the saved space without replaying', async () => {
  vi.mocked(api.living.create).mockImplementation(async () => { spaces.push({ ...shared, id: 'saved-but-lost', members: [] }); throw new Error('连接断开'); });
  const home = await sharedHome(); fireEvent.click(home.getByRole('button', { name: '再建一个同住空间' }));
  await screen.findByRole('alert');
  await waitFor(() => expect(home.getAllByRole('option').some(option => option.getAttribute('value') === 'saved-but-lost')).toBe(true));
  expect(api.living.create).toHaveBeenCalledTimes(1);
});
it('locks writes until an uncertain operation can be read back', async () => {
  const home = await sharedHome();
  vi.mocked(api.living.addMember).mockRejectedValueOnce(new Error('请求中断'));
  vi.mocked(api.living.spaces).mockRejectedValueOnce(new Error('无法核对'));
  fireEvent.click(home.getByRole('button', { name: '加入成员' }));
  const check = await screen.findByRole('button', { name: '核对居住状态' });
  expect(home.getByRole('button', { name: '加入成员' })).toBeDisabled();
  fireEvent.click(check); await screen.findByText('居住状态已核对，可以继续。');
  expect(api.living.addMember).toHaveBeenCalledTimes(1);
  expect(home.getByRole('button', { name: '加入成员' })).toBeEnabled();
});
it('keeps a successful membership when moving fails, without retrying the move', async () => {
  spaces[1].members = [];
  vi.mocked(api.living.setLocation).mockRejectedValueOnce(new Error('移动失败'));
  const home = await sharedHome(); fireEvent.click(home.getByRole('button', { name: /搬进这个同住空间/ }));
  await screen.findByRole('alert');
  expect(api.living.addMember).toHaveBeenCalledTimes(1); expect(api.living.setLocation).toHaveBeenCalledTimes(1);
  expect(nav.push).not.toHaveBeenCalled();
  await waitFor(() => expect(home.getByRole('button', { name: '移出果果 #9' })).toBeInTheDocument());
});
it('returns to the existing private space without altering shared memberships or creating a copy', async () => {
  location = shared.id;
  render(<ScenePicker />);
  fireEvent.click(await screen.findByRole('radio', { name: '独自生活' }));
  fireEvent.click(within(screen.getByRole('article', { name: '家庭庭院' })).getByRole('button', { name: /进去看看/ }));
  await waitFor(() => expect(nav.push).toHaveBeenCalledWith('/companions/9/scenes/home/private-9'));
  expect(api.living.create).not.toHaveBeenCalled(); expect(api.living.removeMember).not.toHaveBeenCalled();
});
it('reloads a specifically selected shared space and does not substitute the private one', async () => {
  nav.params.spaceId = shared.id;
  render(<ScenePage />); await screen.findByText('一起生活 · 共用同一份布置');
  expect(api.living.space).toHaveBeenCalledWith(shared.id); expect(api.living.setLocation).not.toHaveBeenCalled();
  expect(api.living.create).not.toHaveBeenCalled();
});
it('keeps the old home readable while its companion is visiting a gathering', async () => {
  location = 'gather-1';
  render(<ScenePicker />);
  const home = within(await screen.findByRole('article', { name: '家庭庭院' }));
  fireEvent.click(home.getByRole('button', { name: '查看已保存的住处' }));
  expect(nav.push).toHaveBeenCalledWith('/companions/9/scenes/home/private-9');
  expect(api.living.setLocation).not.toHaveBeenCalled();
});
it('shows an old private home without edit controls during a visit, then restores them at home', async () => {
  location = 'gather-1'; nav.params.spaceId = personal.id;
  const away = render(<ScenePage />);
  await screen.findByText(/原住处现在只能看看/);
  expect(screen.getByRole('link', { name: '去共同空间看看' })).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: '布置场景' })).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: '设置四季' })).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: /小树/ })).not.toBeInTheDocument();
  expect(api.living.action).not.toHaveBeenCalled();
  away.unmount();
  location = personal.id;
  render(<ScenePage />);
  expect(await screen.findByRole('button', { name: '布置场景' })).toBeInTheDocument();
  expect(screen.queryByText(/原住处现在只能看看/)).not.toBeInTheDocument();
});
it('shows only members actually living in a shared room and never moves one on view', async () => {
  spaces[1].members = [{ companion_id: '9', name: '果果' }, { companion_id: '10', name: '小树' }];
  location = shared.id; nav.params.spaceId = shared.id;
  render(<ScenePage />);
  await screen.findByText(/小树 #10 · 还没来到这里/);
  expect(screen.getAllByRole('link', { name: '和果果说话' })).toHaveLength(1);
  expect(screen.queryByRole('link', { name: '和小树说话' })).not.toBeInTheDocument();
  expect(api.living.setLocation).not.toHaveBeenCalled();
});
it('restores the current shared space via a legacy scene URL', async () => {
  location = shared.id;
  render(<ScenePage />); await screen.findByText('一起生活 · 共用同一份布置');
  expect(api.living.space).toHaveBeenCalledWith(shared.id);
});
it.each(['missing', 'wrong-type', 'removed-member'])('rejects %s explicit spaces without creating a private replacement', async reason => {
  nav.params.spaceId = reason === 'missing' ? 'gone' : shared.id;
  if (reason === 'wrong-type') spaces[1].scene_type = 'desert';
  if (reason === 'removed-member') spaces[1].members = [];
  render(<ScenePage />); await screen.findByRole('button', { name: /重新加载/ });
  expect(api.living.create).not.toHaveBeenCalled(); expect(api.living.setLocation).not.toHaveBeenCalled();
});
it('does not continue a pending move after leaving the page', async () => {
  spaces[1].members = [];
  let finish!: (value: unknown) => void;
  vi.mocked(api.living.addMember).mockReturnValue(new Promise(resolve => { finish = resolve; }));
  const view = render(<ScenePicker />);
  fireEvent.click(await screen.findByRole('radio', { name: /和我的其他伙伴同住/ }));
  fireEvent.click(within(screen.getByRole('article', { name: '家庭庭院' })).getByRole('button', { name: /搬进这个同住空间/ }));
  expect(api.living.addMember).toHaveBeenCalledTimes(1);
  view.unmount(); finish(null);
  await Promise.resolve(); await Promise.resolve();
  expect(api.living.setLocation).not.toHaveBeenCalled(); expect(nav.push).not.toHaveBeenCalled();
});
