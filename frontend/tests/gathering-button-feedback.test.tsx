import React, { useEffect } from 'react';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Gatherings from '@/components/gatherings';
import type { Gathering } from '@/lib/gatherings';
import { setToken } from '@/lib/auth';

// This suite exercises the real page, HTTP client and response parser. Its world
// reports synthetic occupancy; actual Three.js/floor/SQLite tests are separate.
type Activity = 'rest' | 'sleep' | 'walk' | 'observe' | 'talk';
const world = vi.hoisted(() => ({
  occupied: [2] as number[],
  activity: undefined as undefined | ((id: number, activity: Activity) => Promise<void> | void),
  occupancy: undefined as undefined | ((ids: readonly number[]) => void),
}));
vi.mock('@/components/team-shared', () => ({ useTeamSession: () => 'synthetic-feedback-session' }));
vi.mock('@/components/gathering-dialogue', () => ({ default: () => <p>合成隔离测试，不开启 AI 交流</p> }));
vi.mock('@/components/space-decorations', () => ({ default: () => null }));
vi.mock('@/components/gathering-world', () => ({ default: function SyntheticWorld({ gathering, onSelect, onActivity, onFloorOccupancyChange }: {
  gathering: Gathering; onSelect: (id: number) => void;
  onActivity?: typeof world.activity; onFloorOccupancyChange?: typeof world.occupancy;
}) {
  world.activity = onActivity; world.occupancy = onFloorOccupancyChange;
  useEffect(() => { onFloorOccupancyChange?.(world.occupied); }, [onFloorOccupancyChange]);
  return <div aria-label="共同生活场景"><span data-testid="authoritative-activity">{gathering.companions[0].activity}</span>
    {gathering.companions.map(c => <button key={c.id} onClick={() => onSelect(c.id)}>查看{c.name}的生活近况</button>)}
  </div>;
} }));

function initial() {
  return { id: 'feedback-space', title: '合成按键验证', scene_type: 'home', revision: 4,
    closed: false, is_manager: true, me: 'owner-a', invitation: null, dialogue_enabled: false,
    members: [{ id: 'owner-a', name: '甲', manager: true }, { id: 'owner-b', name: '乙', manager: false }],
    companions: [
      { id: 1, name: '甲的伙伴', owner_id: 'owner-a', activity: 'observe', area: 'outdoor', x: .3, y: .5 },
      { id: 2, name: '乙的伙伴', owner_id: 'owner-b', activity: 'sleep', area: 'bedroom', x: .6, y: .5 },
    ],
    items: [{ id: 'synthetic-tree', kind: 'tree', x: .4, y: .5, mine: true,
      contributor_name: '甲', stage: 'planted', care_remaining_seconds: 0, growth_status: 'needs_care' }],
    votes: [], events: [], stories: [], goal: null, story_enabled: false, season: { current_season: null } };
}
type HttpCall = { path: string; method: string; body: Record<string, unknown> | null };
let saved: ReturnType<typeof initial>, calls: HttpCall[], failure: 'reject' | 'lost' | null;
function response(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });
}
const posts = () => calls.filter(call => call.method === 'POST');
beforeEach(() => {
  saved = initial(); calls = []; failure = null; world.occupied = [2]; world.activity = undefined; world.occupancy = undefined;
  history.replaceState(null, '', '/gatherings?space=feedback-space'); setToken('synthetic-feedback-session');
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input).replace(/^.*\/api\/v1/, ''), method = init?.method ?? 'GET';
    const body = init?.body ? JSON.parse(String(init.body)) : null; calls.push({ path, method, body });
    if (method === 'GET' && path === '/gatherings') return response([]);
    if (method === 'GET' && path === '/characters') return response([{ id: 1, name: '甲的伙伴', persona: '', opening_line: '', image_path: null, status: 'ready', created_at: '' }]);
    if (method === 'GET' && path === '/gatherings/personal') return response({ inventory: [{ id: 'inventory-tree', kind: 'tree' }], notifications: [], memories: [] });
    if (method === 'GET' && path === '/gatherings/feedback-space') return response(saved);
    if (method === 'POST' && path === '/gatherings/feedback-space/commands') {
      if (failure === 'reject') return response({ error: { code: 'care_denied', message: '合成拒绝：照料未保存' } }, 409);
      const command = body.command;
      if (command.action === 'layout' && command.command.action === 'care') saved = { ...saved, revision: saved.revision + 1,
        items: saved.items.map(item => ({ ...item, stage: 'growing', care_remaining_seconds: 86399, growth_status: 'growing' })) };
      else if (command.action === 'activity') saved = { ...saved, revision: saved.revision + 1,
        companions: saved.companions.map(c => command.character_ids.includes(c.id) ? { ...c, activity: command.activity, area: 'outdoor' } : c) };
      else throw new Error('Unexpected mutation in isolated button test');
      if (failure === 'lost') throw new Error('合成断线：保存回执未收到');
      return response(saved);
    }
    throw new Error('Unexpected network route in isolated button test');
  }));
});
afterEach(() => { vi.unstubAllGlobals(); localStorage.clear(); });
async function mount() {
  render(<Gatherings />); await screen.findByRole('tablist', { name: '共同住处功能' });
  fireEvent.click(screen.getByText('伙伴管理与更多活动')); await act(async () => {});
}
function decorate() { fireEvent.click(screen.getByRole('tab', { name: '布置与照料' })); }
function decoratePanel() { return screen.getByRole('tabpanel'); }

describe('free gathering buttons with a peer upstairs', () => {
  it('disables structural placement/move/store/restore, explains why, but keeps care available', async () => {
    await mount(); decorate();
    expect(screen.getByText(/有伙伴在二楼。添加、移动、撤回或放回物件前/)).toBeVisible();
    for (const name of ['添加树', '添加长椅', '向旁边挪一挪', '撤回库存', '放回树']) {
      const button = screen.getByRole('button', { name }); expect(button).toBeDisabled(); fireEvent.click(button);
    }
    expect(screen.getByRole('button', { name: '照料' })).toBeEnabled();
    expect(posts()).toHaveLength(0);
    act(() => world.occupancy?.([]));
    for (const name of ['添加树', '添加长椅', '向旁边挪一挪', '撤回库存', '放回树']) expect(screen.getByRole('button', { name })).toBeEnabled();
    expect(screen.queryByText(/有伙伴在二楼。添加、移动、撤回或放回物件前/)).toBeNull();
  });

  it('submits care once and displays returned stage, coverage and nearby success feedback', async () => {
    await mount(); decorate(); expect(screen.getByText(/已种下 · 等待照料/)).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: '照料' }));
    expect(await screen.findByText('照料已保存，成长和照料时间已更新。')).toHaveAttribute('role', 'status');
    expect(screen.getByText(/生长中 · 已照料，还可保持约24小时/)).toBeVisible();
    expect(posts()).toHaveLength(1); expect(posts()[0].body).toMatchObject({ expected_revision: 4, command: { action: 'layout', command: { action: 'care', item_id: 'synthetic-tree' } } });
  });

  it.each(['reject', 'lost'] as const)('shows %s as unresolved without success or automatic POST retry', async kind => {
    failure = kind; await mount(); decorate(); const initialReads = calls.filter(c => c.path === '/gatherings/feedback-space' && c.method === 'GET').length;
    fireEvent.click(screen.getByRole('button', { name: '照料' }));
    const error = kind === 'reject' ? '合成拒绝：照料未保存' : '合成断线：保存回执未收到';
    expect(await within(decoratePanel()).findByRole('alert')).toHaveTextContent(error);
    expect(screen.queryByText('照料已保存，成长和照料时间已更新。')).toBeNull();
    expect(posts()).toHaveLength(1);
    expect(calls.filter(c => c.path === '/gatherings/feedback-space' && c.method === 'GET')).toHaveLength(initialReads + 1);
    expect(screen.getByText(kind === 'lost' ? /生长中 · 已照料，还可保持约24小时/ : /已种下 · 等待照料/)).toBeVisible();
    expect(screen.getByRole('button', { name: '照料' })).toBeEnabled();
  });

  it('allows an owned first-floor activity despite peer upstairs and renders only its returned snapshot', async () => {
    await mount();
    await act(async () => world.activity?.(1, 'walk'));
    expect(posts()).toHaveLength(1);
    expect(posts()[0].body).toMatchObject({ expected_revision: 4, command: { action: 'activity', character_ids: [1], activity: 'walk' } });
    expect(screen.getByTestId('authoritative-activity')).toHaveTextContent('walk');
    expect(screen.getByText('安排已保存，伙伴会按新活动行动。')).toHaveAttribute('role', 'status');
    expect(saved.companions[1]).toMatchObject({ id: 2, activity: 'sleep', owner_id: 'owner-b' });
  });

  it('keeps foreign activity controls absent and refuses a foreign callback without sending a request', async () => {
    await mount(); fireEvent.click(screen.getByRole('button', { name: '查看乙的伙伴的生活近况' }));
    const detail = screen.getByRole('region', { name: '乙的伙伴的生活近况' });
    expect(within(detail).queryByRole('button', { name: '选中安排活动' })).toBeNull();
    expect(within(detail).queryByRole('link', { name: '和乙的伙伴说话' })).toBeNull();
    await act(async () => world.activity?.(2, 'walk'));
    expect(posts()).toHaveLength(0); expect(saved.companions[1].activity).toBe('sleep');
    expect(screen.queryByText('安排已保存，伙伴会按新活动行动。')).toBeNull();
  });
});
