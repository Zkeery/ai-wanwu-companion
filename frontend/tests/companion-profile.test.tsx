import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import Companion from '@/components/companion';
import { api } from '@/lib/api';
import { writeChatDraft } from '@/lib/chat-draft';
import type { CharacterOverview, Scene } from '@/lib/contracts';

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }), useSearchParams: () => new URLSearchParams(window.location.search) }));
vi.mock('@/lib/api', () => ({ api: { character: vi.fn(), characterOverview: vi.fn(), messages: vi.fn(), scene: vi.fn(), renameCharacter: vi.fn() }, errorText: (e: Error) => e.message }));
vi.mock('@/components/recreate-companion', () => ({ default: () => null }));
vi.mock('@/components/living-scene', () => ({ default: ({ readOnly }: { readOnly: boolean }) => <div data-testid="living-preview" data-readonly={readOnly}>已加载的生活画面</div> }));
vi.mock('@/components/personality-editor', () => ({ default: ({ onSaved, close }: { onSaved: (p: string) => void; close: () => void }) => <button onClick={() => { onSaved('慢热又护短'); close(); }}>确认测试性格</button> }));

const character = { id: 1, name: '小叶', persona: '原来的性格', opening_line: '你好', image_path: null, status: 'ready' as const, created_at: '2026-09-26T20:00:00' };
const space = { id: 'saved/home', scene_type: 'desert' as const, mode: 'private' as const, companion_id: '1', revision: 1, observed_at: 100, can_undo: false, items: [] };
const scene: Scene = { living: space, scene_name: '绿洲', elements: { rain: 0, tree: 0, cloud: 0, sound: 1 }, can_undo: false, feedback: null, proposal: null };
const presence: CharacterOverview = { character, residence: { space_id: space.id, scene_type: 'desert', mode: 'private' }, last_interaction_at: null };
beforeEach(() => {
  vi.resetAllMocks();
  HTMLDialogElement.prototype.showModal = function () { this.setAttribute('open', ''); };
  HTMLDialogElement.prototype.close = function () { this.removeAttribute('open'); };
  window.history.replaceState(null, '', '/companions/1?tab=profile'); writeChatDraft(1, '');
  vi.mocked(api.character).mockResolvedValue(character); vi.mocked(api.scene).mockResolvedValue(scene);
  vi.mocked(api.characterOverview).mockResolvedValue([presence]); vi.mocked(api.messages).mockResolvedValue([]);
});

it('distinguishes a visit from saved scenery and uses encoded destinations', async () => {
  vi.mocked(api.characterOverview).mockResolvedValue([{ ...presence, residence: null, gathering: { id: 'group/1', title: '朋友的小院' } }]);
  render(<Companion id={1}/>);
  const facts = await screen.findByLabelText('伙伴资料卡');
  expect(within(facts).getByText('正在“朋友的小院”相聚')).toBeVisible();
  expect(within(facts).getByText('沙漠绿洲 · 私人布置')).toBeVisible();
  expect(within(facts).getByRole('link', { name: /去相聚的地方/ })).toHaveAttribute('href', '/gatherings?space=group%2F1');
  expect(within(facts).getByRole('link', { name: /看看保存的布置/ })).toHaveAttribute('href', '/companions/1/scenes/desert/saved%2Fhome');
  expect(within(facts).getByText('2026年9月27日')).toBeVisible();
  expect(within(facts).queryByText(/独自生活/)).not.toBeInTheDocument();
});

it('does not infer presence from a saved space after an overview failure', async () => {
  vi.mocked(api.characterOverview).mockRejectedValue(new Error('offline'));
  render(<Companion id={1}/>); const facts = await screen.findByLabelText('伙伴资料卡');
  expect(within(facts).getByText('位置暂未核对')).toBeVisible();
  expect(within(facts).queryByRole('link', { name: /去现在的小天地/ })).not.toBeInTheDocument();
  expect(within(facts).queryByText('还没有选择住处')).not.toBeInTheDocument();
});

it('shows a verified empty residence without inventing a saved space', async () => {
  vi.mocked(api.characterOverview).mockResolvedValue([{ ...presence, residence: null }]);
  vi.mocked(api.scene).mockResolvedValue({ ...scene, living: undefined });
  render(<Companion id={1}/>); const facts = await screen.findByLabelText('伙伴资料卡');
  expect(within(facts).getByRole('link', { name: /安排一个住处/ })).toHaveAttribute('href', '/companions/1/scenes');
  expect(within(facts).getByText('还没有保存的小天地')).toBeVisible();
});

it('refreshes all facts atomically and preserves chat drafts and history on failure and retry', async () => {
  writeChatDraft(1, '还没说完的话');
  const view = render(<Companion id={1}/>); await screen.findByLabelText('伙伴资料卡');
  vi.mocked(api.character).mockResolvedValue({ ...character, name: '新名字', persona: '新的有效性格' });
  vi.mocked(api.characterOverview).mockRejectedValueOnce(new Error('位置读取失败'));
  fireEvent.click(screen.getByRole('button', { name: '更新资料' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('先保留上次看到的内容');
  expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('小叶');
  expect(screen.getByText('原来的性格')).toBeVisible();
  vi.mocked(api.characterOverview).mockResolvedValue([{ ...presence, residence: { space_id: 'shared-2', scene_type: 'forest', mode: 'shared' } }]);
  fireEvent.click(screen.getByRole('button', { name: '更新资料' })); await screen.findByText('资料已更新。');
  expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('新名字');
  expect(screen.getByText('新的有效性格')).toBeVisible();
  expect(screen.getByRole('link', { name: /去现在的小天地/ })).toHaveAttribute('href', '/companions/1/scenes/forest/shared-2');
  fireEvent.click(screen.getByRole('tab', { name: '聊天' })); view.rerender(<Companion id={1}/>);
  expect(screen.getByLabelText('想对伙伴说的话')).toHaveValue('还没说完的话');
  expect(api.messages).toHaveBeenCalledTimes(1); expect(api.renameCharacter).not.toHaveBeenCalled();
});

it('blocks simultaneous edits and aborts a pending refresh when the page leaves', async () => {
  const view = render(<Companion id={1}/>); await screen.findByLabelText('伙伴资料卡');
  let finish!: (v: typeof character) => void; let signal: AbortSignal | undefined;
  vi.mocked(api.character).mockImplementation((_id, s) => { signal = s; return new Promise(resolve => { finish = resolve; }); });
  fireEvent.click(screen.getByRole('button', { name: '更新资料' }));
  expect(screen.getByRole('button', { name: '修改名字' })).toBeDisabled();
  expect(screen.getByRole('button', { name: '调整性格' })).toBeDisabled();
  fireEvent.click(screen.getByRole('tab', { name: '生活' })); view.rerender(<Companion id={1}/>);
  expect(screen.getByTestId('living-preview')).toHaveAttribute('data-readonly', 'true');
  view.unmount(); expect(signal?.aborted).toBe(true);
  await act(async () => finish({ ...character, name: '迟到的名字' }));
  expect(screen.queryByText('迟到的名字')).not.toBeInTheDocument();
});

it('updates name and effective personality in the same companion without reloading the draft', async () => {
  writeChatDraft(1, '留着下次说');
  vi.mocked(api.renameCharacter).mockResolvedValue({ ...character, name: '小芽' });
  const view = render(<Companion id={1}/>); await screen.findByLabelText('伙伴资料卡');
  fireEvent.click(screen.getByRole('button', { name: '修改名字' }));
  fireEvent.change(screen.getByLabelText('伙伴名字'), { target: { value: '小芽' } });
  fireEvent.click(screen.getByRole('button', { name: '保存名字' }));
  await waitFor(() => expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('小芽'));
  expect(screen.getByRole('heading', { name: '认识小芽' })).toBeVisible();
  fireEvent.click(screen.getByRole('button', { name: '调整性格' })); fireEvent.click(screen.getByText('确认测试性格'));
  expect(screen.getByText('慢热又护短')).toBeVisible();
  fireEvent.click(screen.getByRole('tab', { name: '聊天' })); view.rerender(<Companion id={1}/>);
  expect(screen.getByRole('heading', { name: '和小芽聊聊' })).toBeVisible();
  expect(screen.getByLabelText('想对伙伴说的话')).toHaveValue('留着下次说');
});
