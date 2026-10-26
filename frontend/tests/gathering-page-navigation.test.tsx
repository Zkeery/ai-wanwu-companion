import React, { useState } from 'react';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import Gatherings from '@/components/gatherings';
import { gatherings, parseGathering, type Gathering } from '@/lib/gatherings';
import { api } from '@/lib/api';
import { TOKEN_KEY } from '@/lib/auth';
import type { Character } from '@/lib/contracts';

const worldSignals = vi.hoisted(() => ({ activity: undefined as undefined | ((id: number, activity: 'rest' | 'sleep' | 'walk' | 'observe' | 'talk') => Promise<void> | void) }));
vi.mock('@/components/team-shared', () => ({ useTeamSession: () => 'navigation-session' }));
vi.mock('@/components/gathering-world', () => ({
  default: ({ gathering, onSelect, suspended, onActivity }: { gathering: Gathering; onSelect: (id: number) => void; suspended?: boolean; onActivity?: typeof worldSignals.activity }) => {
    worldSignals.activity = onActivity;
    return <div aria-label="共同生活场景" data-suspended={String(!!suspended)}>{gathering.companions.map(c => <button key={c.id} onClick={() => onSelect(c.id)}>查看{c.name}的生活近况</button>)}</div>;
  },
}));
vi.mock('@/components/gathering-dialogue', () => ({ default: ({ compact }: { compact?: boolean }) => <p data-compact={String(!!compact)}>交流功能测试占位</p> }));
vi.mock('@/components/space-decorations', () => ({
  default: function DecorationDraft() {
    const [draft, setDraft] = useState('');
    return <label>布置草稿<input value={draft} onChange={e => setDraft(e.target.value)} /></label>;
  },
}));
vi.mock('@/lib/api', async original => ({ ...await original<typeof import('@/lib/api')>(), api: { characters: vi.fn() } }));
vi.mock('@/lib/gatherings', async original => ({ ...await original<typeof import('@/lib/gatherings')>(), gatherings: { list: vi.fn(), personal: vi.fn(), read: vi.fn(), preview: vi.fn(), create: vi.fn(), command: vi.fn(), join: vi.fn() } }));

const tabs = ['伙伴与活动', '布置与照料', '共同记录', '成员与设置'] as const;
function snapshot(manager = true): Gathering {
  return parseGathering({ id: 'navigation-space', title: '任务清楚的共同住处', scene_type: 'home', revision: 4, closed: false, is_manager: manager, me: 'owner', invitation: null,
    members: [{ id: 'owner', name: '我', manager }, { id: 'other', name: '朋友', manager: !manager }],
    companions: [{ id: 1, name: '小叶', owner_id: 'owner', activity: 'rest', x: .3, y: .5 }, { id: 2, name: '小花', owner_id: 'other', activity: 'observe', x: .6, y: .5 }],
    items: [{ id: 'tree', kind: 'tree', x: .4, y: .5, mine: true, contributor_name: '我', growth_status: 'growing' }],
    votes: [], events: [], stories: [], goal: null, story_enabled: false, season: { current_season: 'autumn' } });
}
beforeEach(() => {
  vi.resetAllMocks(); history.replaceState(null, '', '/gatherings?space=navigation-space');
  worldSignals.activity = undefined;
  localStorage.setItem(TOKEN_KEY, 'navigation-session');
  vi.mocked(gatherings.list).mockResolvedValue([]);
  vi.mocked(gatherings.personal).mockResolvedValue({ inventory: [{ id: 'saved-tree', kind: 'tree' }], notifications: [], memories: [] });
  vi.mocked(api.characters).mockResolvedValue([{ id: 1, name: '小叶', status: 'ready' }, { id: 3, name: '小苹果', status: 'ready' }] as Character[]);
  vi.mocked(gatherings.read).mockResolvedValue(snapshot());
});
afterEach(() => { vi.useRealTimers(); localStorage.clear(); });

async function mount(openManagement = true) {
  render(<Gatherings />);
  await screen.findByRole('tablist', { name: '共同住处功能' });
  if (openManagement) fireEvent.click(screen.getByText('伙伴管理与更多活动'));
}
function openTab(name: typeof tabs[number]) { fireEvent.click(screen.getByRole('tab', { name })); }
function noWrites() {
  for (const write of [gatherings.create, gatherings.join, gatherings.command]) expect(write).not.toHaveBeenCalled();
}

it('starts with companions and exposes four exclusive, connected task panels without writing', async () => {
  await mount(false);
  const navigation = screen.getByRole('tablist', { name: '共同住处功能' });
  expect(within(navigation).getAllByRole('tab')).toHaveLength(4);
  for (const name of tabs) {
    const tab = within(navigation).getByRole('tab', { name });
    const panel = document.getElementById(tab.getAttribute('aria-controls')!);
    expect(panel).toHaveAttribute('role', 'tabpanel');
    expect(panel).toHaveAttribute('aria-labelledby', tab.id);
    expect(tab).toHaveAttribute('aria-selected', String(name === '伙伴与活动'));
    expect(panel?.hidden).toBe(name !== '伙伴与活动');
  }
  expect(screen.getAllByRole('tabpanel')).toHaveLength(1);
  expect(document.querySelectorAll('[role="tabpanel"]')).toHaveLength(4);
  expect(screen.getByText('伙伴管理与更多活动').closest('details')).not.toHaveAttribute('open');
  fireEvent.click(screen.getByText('伙伴管理与更多活动'));
  expect(screen.getByText('＋ 带伙伴来').closest('details')).not.toHaveAttribute('open');
  fireEvent.click(screen.getByText('＋ 带伙伴来'));
  expect(screen.getByRole('button', { name: '带 小苹果 来' })).toBeEnabled();
  expect(screen.queryByRole('button', { name: '提议调整四季' })).toBeNull();
  noWrites();
});

it('switches tasks without sending commands or exposing hidden task controls', async () => {
  await mount();
  for (const name of tabs) {
    openTab(name);
    expect(screen.getByRole('tab', { name })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getAllByRole('tabpanel')).toHaveLength(1);
    const selected = screen.getByRole('tabpanel');
    expect(selected).toHaveAttribute('id', screen.getByRole('tab', { name }).getAttribute('aria-controls'));
  }
  expect(screen.getByRole('button', { name: '提议调整四季' })).toBeEnabled();
  expect(screen.queryByRole('button', { name: '休息' })).toBeNull();
  noWrites();
});

it('keeps participant selection and an unfinished decoration draft across task switches', async () => {
  await mount();
  fireEvent.click(screen.getByRole('checkbox', { name: '参与活动' }));
  openTab('布置与照料');
  fireEvent.change(screen.getByLabelText('布置草稿'), { target: { value: '小树旁边' } });
  openTab('共同记录'); openTab('成员与设置'); openTab('伙伴与活动');
  expect(screen.getByRole('checkbox', { name: '参与活动' })).toBeChecked();
  openTab('布置与照料');
  expect(screen.getByLabelText('布置草稿')).toHaveValue('小树旁边');
  noWrites();
});

it('quick task entries only select their destination and never create invitations or decorations', async () => {
  await mount();
  fireEvent.click(screen.getByRole('button', { name: '布置住处' }));
  expect(screen.getByRole('tab', { name: '布置与照料' })).toHaveAttribute('aria-selected', 'true');
  fireEvent.click(screen.getByRole('button', { name: '邀请朋友' }));
  expect(screen.getByRole('tab', { name: '成员与设置' })).toHaveAttribute('aria-selected', 'true');
  expect(screen.getByRole('button', { name: '生成新邀请' })).toBeEnabled();
  noWrites();
});

it('requests compact AI exchange and keeps its component mounted while browsing other tasks', async () => {
  await mount();
  const exchange = screen.getByText('交流功能测试占位');
  expect(exchange).toHaveAttribute('data-compact', 'true');
  openTab('成员与设置'); openTab('共同记录'); openTab('伙伴与活动');
  expect(screen.getByText('交流功能测试占位')).toBe(exchange);
  expect(exchange).toHaveAttribute('data-compact', 'true');
  noWrites();
});

it('hides and suspends the scene for settings and records, then restores the same instance', async () => {
  await mount();
  const world = screen.getByLabelText('共同生活场景');
  expect(world).toBeVisible();
  expect(world).toHaveAttribute('data-suspended', 'false');
  fireEvent.click(screen.getByRole('button', { name: '布置住处' }));
  expect(world).toBeVisible();
  fireEvent.click(screen.getByRole('button', { name: '邀请朋友' }));
  expect(world).not.toBeVisible();
  expect(world).toHaveAttribute('data-suspended', 'true');
  openTab('共同记录');
  expect(world).not.toBeVisible();
  expect(world).toHaveAttribute('data-suspended', 'true');
  openTab('伙伴与活动');
  expect(screen.getByLabelText('共同生活场景')).toBe(world);
  expect(world).toBeVisible();
  expect(world).toHaveAttribute('data-suspended', 'false');
  noWrites();
});

it('keeps only the current owner’s participation and recall controls and sends selected owned IDs', async () => {
  const original = snapshot();
  vi.mocked(gatherings.read).mockResolvedValue(original);
  vi.mocked(gatherings.command).mockResolvedValue({ ...original, revision: 5 });
  await mount();
  expect(screen.getAllByRole('checkbox', { name: '参与活动' })).toHaveLength(1);
  expect(screen.getAllByRole('button', { name: '回家' })).toHaveLength(1);
  fireEvent.click(screen.getByRole('button', { name: '查看小花的生活近况' }));
  expect(screen.queryByRole('button', { name: '选中安排活动' })).toBeNull();
  expect(screen.queryByRole('link', { name: '和小花说话' })).toBeNull();
  fireEvent.click(screen.getByRole('checkbox', { name: '参与活动' }));
  openTab('布置与照料'); openTab('伙伴与活动');
  fireEvent.click(screen.getByRole('button', { name: '散步' }));
  await act(async () => {});
  expect(gatherings.command).toHaveBeenCalledTimes(1);
  expect(gatherings.command).toHaveBeenCalledWith(original, { action: 'activity', character_ids: [1], activity: 'walk' }, expect.any(String));
});

it('wires one world-menu activity to the existing owned command and refuses a foreign target or repeated pending dispatch', async () => {
  const original = snapshot(); let finish!: (value: Gathering) => void;
  vi.mocked(gatherings.read).mockResolvedValue(original);
  vi.mocked(gatherings.command).mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  await mount(); expect(worldSignals.activity).toBeTypeOf('function');
  await act(async () => worldSignals.activity?.(2, 'walk'));
  noWrites();
  let duplicate!: Promise<void> | void;
  act(() => { void worldSignals.activity?.(1, 'walk'); duplicate = worldSignals.activity?.(1, 'walk'); });
  await expect(Promise.resolve(duplicate)).rejects.toThrow('上一项操作正在保存');
  expect(gatherings.command).toHaveBeenCalledTimes(1);
  expect(gatherings.command).toHaveBeenCalledWith(original, { action: 'activity', character_ids: [1], activity: 'walk' }, expect.any(String));
  await act(async () => finish({ ...original, revision: 5, companions: original.companions.map(c => c.id === 1 ? { ...c, activity: 'walk' } : c) }));
  expect(gatherings.command).toHaveBeenCalledTimes(1);
});

it('retains the current owner’s recall target after visiting another task', async () => {
  const original = snapshot();
  vi.mocked(gatherings.read).mockResolvedValue(original);
  vi.mocked(gatherings.command).mockResolvedValue({ ...original, revision: 5, companions: [original.companions[1]] });
  await mount(); openTab('共同记录'); openTab('伙伴与活动');
  fireEvent.click(screen.getByRole('button', { name: '回家' }));
  await act(async () => {});
  expect(gatherings.command).toHaveBeenCalledTimes(1);
  expect(gatherings.command).toHaveBeenCalledWith(original, { action: 'recall', character_id: 1 }, expect.any(String));
  expect(screen.queryByRole('button', { name: '回家' })).toBeNull();
});

it('selects an owned companion by its row name, retains it across tasks and submits one activity', async () => {
  const original = snapshot();
  let finish!: (value: Gathering) => void;
  vi.mocked(gatherings.read).mockResolvedValue(original);
  vi.mocked(gatherings.command).mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  await mount();
  const selection = screen.getByRole('checkbox', { name: '参与活动' });
  const row = selection.closest('label');
  expect(row).not.toBeNull();
  expect(selection).not.toBeChecked();
  for (const name of ['休息', '散步', '观察', '相聚']) expect(screen.getByRole('button', { name })).toBeDisabled();
  fireEvent.click(within(row!).getByText('小叶'));
  expect(selection).toBeChecked();
  openTab('共同记录'); openTab('伙伴与活动');
  expect(screen.getByRole('checkbox', { name: '参与活动' })).toBeChecked();
  const walk = screen.getByRole('button', { name: '散步' });
  expect(walk).toBeEnabled();
  noWrites();
  fireEvent.click(walk); fireEvent.click(walk);
  expect(gatherings.command).toHaveBeenCalledTimes(1);
  expect(gatherings.command).toHaveBeenCalledWith(original, { action: 'activity', character_ids: [1], activity: 'walk' }, expect.any(String));
  await act(async () => finish({ ...original, revision: 5, companions: original.companions.map(c => c.id === 1 ? { ...c, activity: 'walk' } : c) }));
});

it('keeps friends in a read-only group with no selection or recall actions', async () => {
  await mount();
  const friends = screen.getByRole('group', { name: '朋友的伙伴' });
  expect(within(friends).getByText('小花')).toBeVisible();
  expect(within(friends).queryByRole('checkbox')).toBeNull();
  expect(within(friends).queryByRole('button', { name: '回家' })).toBeNull();
  expect(screen.getAllByRole('checkbox', { name: '参与活动' })).toHaveLength(1);
  expect(screen.getAllByRole('button', { name: '回家' })).toHaveLength(1);
  noWrites();
});

it('offers bedroom sleep only after selecting an owned home companion and sends one saved activity command', async () => {
  const original = snapshot();
  let finish!: (value: Gathering) => void;
  vi.mocked(gatherings.read).mockResolvedValue(original);
  vi.mocked(gatherings.command).mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  await mount();
  const sleep = screen.getByRole('button', { name: '睡觉' });
  expect(sleep).toBeDisabled();
  expect(screen.getByText('坐客厅沙发')).toBeVisible();
  expect(screen.getByText('进卧室睡觉')).toBeVisible();
  fireEvent.click(screen.getByRole('checkbox', { name: '参与活动' }));
  expect(sleep).toBeEnabled(); noWrites();
  fireEvent.click(sleep); fireEvent.click(sleep);
  expect(gatherings.command).toHaveBeenCalledTimes(1);
  expect(gatherings.command).toHaveBeenCalledWith(original, { action: 'activity', character_ids: [1], activity: 'sleep' }, expect.any(String));
  await act(async () => finish({ ...original, revision: 5, companions: original.companions.map(c => c.id === 1 ? { ...c, area: 'bedroom' as const, activity: 'sleep' } : c) }));
  expect(within(screen.getByRole('group', { name: '自己的伙伴' })).getByText(/睡觉 · 卧室/)).toBeVisible();
});

it.each(['forest', 'desert'])('retains the four existing %s activities without offering home-only bedroom sleep', async scene => {
  vi.mocked(gatherings.read).mockResolvedValue({ ...snapshot(), scene_type: scene });
  await mount();
  expect(screen.queryByRole('button', { name: '睡觉' })).toBeNull();
  for (const name of ['休息', '散步', '观察', '相聚']) expect(screen.getByRole('button', { name })).toBeDisabled();
  noWrites();
});

it('keeps management operations unavailable to ordinary members while preserving their exit', async () => {
  vi.mocked(gatherings.read).mockResolvedValue(snapshot(false));
  await mount(); openTab('成员与设置');
  expect(screen.getByRole('button', { name: '退出共同生活' })).toBeEnabled();
  for (const name of ['生成新邀请', '撤销邀请', '转交管理', '移除', '发起解散投票']) expect(screen.queryByRole('button', { name })).toBeNull();
  noWrites();
});

it('retains the selected task, owner selection and child draft when a newer read arrives', async () => {
  const original = snapshot();
  vi.mocked(gatherings.read).mockResolvedValueOnce(original).mockResolvedValue({ ...original, revision: 5, companions: original.companions.map(c => c.id === 1 ? { ...c, activity: 'walk' } : c) });
  vi.useFakeTimers();
  await act(async () => { render(<Gatherings />); });
  fireEvent.click(screen.getByText('伙伴管理与更多活动'));
  fireEvent.click(screen.getByRole('checkbox', { name: '参与活动' }));
  openTab('布置与照料');
  fireEvent.change(screen.getByLabelText('布置草稿'), { target: { value: '保留这个草稿' } });
  await act(async () => { await vi.advanceTimersByTimeAsync(15000); });
  expect(gatherings.read).toHaveBeenCalledTimes(2);
  expect(screen.getByRole('tab', { name: '布置与照料' })).toHaveAttribute('aria-selected', 'true');
  expect(screen.getByLabelText('布置草稿')).toHaveValue('保留这个草稿');
  openTab('伙伴与活动');
  expect(screen.getByRole('checkbox', { name: '参与活动' })).toBeChecked();
  expect(screen.getByRole('button', { name: '散步' })).toBeEnabled();
  noWrites();
});
