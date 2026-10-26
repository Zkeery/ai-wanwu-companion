import React from 'react';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import SharedLivingWorld3D from '../components/shared-living-world-3d';
import { parseGathering } from '../lib/gatherings';
import type { Gathering } from '../lib/gatherings';
import type { HomeLeisureActivity, HomeLeisureSnapshot } from '../lib/living-home-leisure';

type Options = {
  localLeisurePreview?: boolean; localNaturalWorld?: boolean; localNaturalLeisure?: boolean;
  localRoomTransitions?: boolean; localCompanionDoors?: boolean;
  onLeisureChange?: (snapshot: HomeLeisureSnapshot, kind?: HomeLeisureActivity) => void;
};
type World = {
  gathering: Gathering; options: Options; dispose: ReturnType<typeof vi.fn>;
  start: ReturnType<typeof vi.fn>; stop: ReturnType<typeof vi.fn>;
  toggle: ReturnType<typeof vi.fn>; audio: ReturnType<typeof vi.fn>;
  publish: (kind?: HomeLeisureActivity, actorId?: number) => void;
};
const engine = vi.hoisted(() => ({ worlds: [] as World[] }));

// Test the real React controls and their local-only routing; no GPU or provider is invoked.
vi.mock('../lib/living-world-engine', () => ({
  createLivingWorld: vi.fn((_host: HTMLElement, _labels: HTMLElement, gathering: Gathering,
    _select: (id: number) => void, _door: unknown, options: Options = {}) => {
    let revision = 0;
    const publish = (kind?: HomeLeisureActivity, actorId = gathering.companions[0]?.id) => {
      options.onLeisureChange?.({ revision: ++revision,
        scope: { groupId: gathering.id, ownerId: gathering.me, synthetic: gathering.id.startsWith('synthetic-'), optIn: true },
        permitted: true,
        assignments: kind && actorId ? [{ actorId, seatId: kind + '-0', activity: kind, originalActivity: 'observe', startedAtElapsed: 0 }] : [],
        television: { powered: false, watchingActorIds: [] },
      }, kind);
    };
    const start = vi.fn((kind: HomeLeisureActivity, actorId?: number) => { publish(kind, actorId); return true; });
    const stop = vi.fn(() => { publish(); return true; });
    const world: World = { gathering, options, start, stop, publish, dispose: vi.fn(), toggle: vi.fn(), audio: vi.fn() };
    engine.worlds.push(world);
    return { update: vi.fn(), setMotion: vi.fn(), setReplay: vi.fn(), setBubbleReceipts: vi.fn(), setHouseView: vi.fn(),
      setDoorOpen: vi.fn(), toggleDoor: vi.fn(), setSelectionMenu: vi.fn(), rotate: vi.fn(), zoom: vi.fn(), reset: vi.fn(),
      startLocalLeisure: start, stopLocalLeisure: stop, toggleLocalLeisure: world.toggle, setLifeAudio: world.audio,
      focusLocalLeisure: vi.fn(), restartLocalMahjong: vi.fn(), dispose: world.dispose };
  }),
}));

function gathering(scene: 'forest' | 'desert' | 'home' = 'forest', id = 'synthetic-natural-leisure-ui', owner = 'owner-a') {
  return parseGathering({ id, title: '自然场景免费预览', scene_type: scene, revision: 1, closed: false, is_manager: true, me: owner,
    members: [{ id: 'owner-a', name: '成员A', manager: true }, { id: 'owner-b', name: '成员B', manager: false }],
    companions: [{ id: 4, name: '已有伙伴', owner_id: 'owner-a', activity: 'observe', area: 'outdoor', x: .5, y: .5,
      avatar3d: { version: 1, kind: 'cup', body: '#6da385', accent: '#f3dfbb', detail: '#364d44', seed: 4, source: 'procedural_existing_features' } }],
    items: [], votes: [], events: [], stories: [], goal: null, story_enabled: false, season: { current_season: 'summer' } });
}
const enabled = { visualStyle: 'realistic' as const, localLeisurePreview: true, localNaturalWorld: true,
  localNaturalLeisure: true, localRoomTransitions: true, localCompanionDoors: true };
const base = { focusedId: null, onSelect: vi.fn(), animate: true };
const latest = () => engine.worlds.at(-1)!;
const toolbar = () => screen.getByLabelText('本地休闲预览');
async function settled() { await act(async () => {}); }
function noHomeExtras() {
  expect(screen.queryByRole('button', { name: '看电视' })).toBeNull();
  expect(screen.queryByRole('button', { name: '打麻将' })).toBeNull();
  expect(screen.queryByRole('button', { name: '打开电视' })).toBeNull();
  expect(screen.queryByRole('button', { name: '新一局麻将' })).toBeNull();
  expect(screen.queryByRole('button', { name: /^(打开|关闭)(生活音效|伙伴声音)/ })).toBeNull();
  expect(screen.queryByLabelText('四川麻将规则与本局积分')).toBeNull();
}

beforeEach(() => {
  engine.worlds.length = 0;
  vi.stubGlobal('fetch', vi.fn(() => { throw new Error('natural leisure UI must stay offline'); }));
});
afterEach(() => { cleanup(); expect(fetch).not.toHaveBeenCalled(); vi.unstubAllGlobals(); });

describe('explicit natural tea and bench UI with a local engine contract', () => {
  it('keeps natural leisure off when the new opt-in is omitted', async () => {
    const previous = { visualStyle: 'realistic' as const, localLeisurePreview: true, localNaturalWorld: true,
      localRoomTransitions: true, localCompanionDoors: true };
    render(<SharedLivingWorld3D {...base} {...previous} gathering={gathering()} />);
    await settled();
    expect(screen.queryByLabelText('本地休闲预览')).toBeNull();
    expect(latest().options.localNaturalLeisure).not.toBe(true);
    expect(screen.getByRole('button', { name: /^林地/ })).toBeInTheDocument();
  });

  it('requires every local natural flag, realistic rendering, and a synthetic space', async () => {
    const guards = ['localLeisurePreview', 'localNaturalWorld', 'localNaturalLeisure', 'localRoomTransitions', 'localCompanionDoors'] as const;
    const variants = guards.map(flag => ({ ...enabled, [flag]: false }));
    for (const props of [...variants, { ...enabled, visualStyle: 'classic' as const }]) {
      const page = render(<SharedLivingWorld3D {...base} {...props} gathering={gathering()} />);
      await settled();
      expect(screen.queryByLabelText('本地休闲预览')).toBeNull();
      expect(latest().options.localNaturalLeisure).not.toBe(true);
      expect(latest().start).not.toHaveBeenCalled();
      page.unmount();
    }
    render(<SharedLivingWorld3D {...base} {...enabled} gathering={gathering('forest', 'production-space')} />);
    await settled();
    expect(screen.queryByLabelText('本地休闲预览')).toBeNull();
    expect(latest().options.localNaturalLeisure).not.toBe(true);
  });

  it.each(['forest', 'desert'] as const)('exposes only tea, bench and finish controls in %s', async scene => {
    render(<SharedLivingWorld3D {...base} {...enabled} gathering={gathering(scene)} localMahjongGame localMahjongRules="sichuan" localQuietAudio />);
    await settled();
    expect(within(toolbar()).getAllByRole('button').map(button => button.textContent)).toEqual(['喝茶', '长椅休息', '结束休闲，恢复原活动']);
    expect(within(toolbar()).getByRole('button', { name: '结束休闲，恢复原活动' })).toBeDisabled();
    expect(latest().options.localNaturalLeisure).toBe(true);
    noHomeExtras();
  });

  it('routes toolbar actions only to local start and stop without changing saved activities', async () => {
    const group = gathering(), before = JSON.stringify(group), onActivity = vi.fn();
    render(<SharedLivingWorld3D {...base} {...enabled} gathering={group} onActivity={onActivity} />);
    await settled(); const world = latest();
    fireEvent.click(within(toolbar()).getByRole('button', { name: '喝茶' }));
    expect(world.start).toHaveBeenLastCalledWith('tea');
    expect(within(toolbar()).getByRole('button', { name: '喝茶' })).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(within(toolbar()).getByRole('button', { name: '结束休闲，恢复原活动' }));
    expect(world.stop).toHaveBeenLastCalledWith();
    expect(within(toolbar()).getByRole('button', { name: '结束休闲，恢复原活动' })).toBeDisabled();
    fireEvent.click(within(toolbar()).getByRole('button', { name: '长椅休息' }));
    expect(world.start).toHaveBeenLastCalledWith('bench');
    expect(onActivity).not.toHaveBeenCalled(); expect(world.toggle).not.toHaveBeenCalled(); expect(world.audio).not.toHaveBeenCalled();
    expect(JSON.stringify(group)).toBe(before);
  });

  it('routes the selected companion menu to that actor and ends only that local assignment', async () => {
    const onActivity = vi.fn();
    render(<SharedLivingWorld3D {...base} {...enabled} gathering={gathering()} onActivity={onActivity} />);
    await settled(); const world = latest();
    fireEvent.click(screen.getByRole('button', { name: '查看已有伙伴的生活近况' }));
    const menu = screen.getByRole('group', { name: '已有伙伴的活动' });
    fireEvent.click(within(menu).getByRole('button', { name: '安排喝茶' }));
    expect(world.start).toHaveBeenLastCalledWith('tea', 4);
    fireEvent.click(within(menu).getByRole('button', { name: '结束本次休闲' }));
    expect(world.stop).toHaveBeenLastCalledWith(4);
    fireEvent.click(within(menu).getByRole('button', { name: '安排长椅休息' }));
    expect(world.start).toHaveBeenLastCalledWith('bench', 4);
    expect(within(menu).queryByRole('button', { name: '安排看电视' })).toBeNull();
    expect(within(menu).queryByRole('button', { name: '安排打麻将' })).toBeNull();
    expect(onActivity).not.toHaveBeenCalled();
  });

  it('keeps existing home leisure choices, television and sound controls available', async () => {
    render(<SharedLivingWorld3D {...base} {...enabled} gathering={gathering('home')} localMahjongGame localMahjongRules="sichuan" />);
    await settled();
    for (const name of ['喝茶', '看电视', '打麻将', '长椅休息', '打开电视', '新一局麻将']) expect(within(toolbar()).getByRole('button', { name })).toBeInTheDocument();
    expect(screen.getByLabelText('四川麻将规则与本局积分')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '打开生活音效' })).toBeInTheDocument();
    expect(latest().options.localNaturalLeisure).toBe(false);
  });

  it('disposes and rebuilds the world when the natural leisure opt-in changes', async () => {
    const group = gathering(), page = render(<SharedLivingWorld3D {...base} {...enabled} gathering={group} />);
    await settled(); const original = latest();
    page.rerender(<SharedLivingWorld3D {...base} {...enabled} localNaturalLeisure={false} gathering={group} />);
    await settled(); const disabled = latest();
    expect(disabled).not.toBe(original); expect(original.dispose).toHaveBeenCalledOnce();
    expect(disabled.options.localNaturalLeisure).toBe(false); expect(screen.queryByLabelText('本地休闲预览')).toBeNull();
    page.rerender(<SharedLivingWorld3D {...base} {...enabled} gathering={group} />);
    await settled(); expect(latest()).not.toBe(disabled); expect(disabled.dispose).toHaveBeenCalledOnce();
    expect(latest().options.localNaturalLeisure).toBe(true); expect(within(toolbar()).getByRole('button', { name: '喝茶' })).toHaveAttribute('aria-pressed', 'false');
  });

  it('recreates scene-local resources when switching between forest, desert and home', async () => {
    const page = render(<SharedLivingWorld3D {...base} {...enabled} gathering={gathering('forest')} />);
    await settled(); const forest = latest();
    page.rerender(<SharedLivingWorld3D {...base} {...enabled} gathering={gathering('desert')} />);
    await settled(); const desert = latest();
    expect(forest.dispose).toHaveBeenCalledOnce(); expect(desert).not.toBe(forest);
    expect(desert.gathering.scene_type).toBe('desert'); expect(desert.options.localNaturalLeisure).toBe(true); noHomeExtras();
    page.rerender(<SharedLivingWorld3D {...base} {...enabled} gathering={gathering('home')} />);
    await settled(); expect(desert.dispose).toHaveBeenCalledOnce(); expect(latest().options.localNaturalLeisure).toBe(false);
    expect(within(toolbar()).getByRole('button', { name: '看电视' })).toBeInTheDocument();
  });

  it('disposes the current engine once on unmount and does not start any activity on mount', async () => {
    const page = render(<SharedLivingWorld3D {...base} {...enabled} gathering={gathering()} />);
    await settled(); const world = latest();
    expect(world.start).not.toHaveBeenCalled(); expect(world.stop).not.toHaveBeenCalled();
    page.unmount(); expect(world.dispose).toHaveBeenCalledOnce();
  });
});
