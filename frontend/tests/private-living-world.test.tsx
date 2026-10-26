import React, { useState } from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import PrivateLivingWorld from '@/components/private-living-world';
import LivingScene from '@/components/living-scene';
import { api } from '@/lib/api';
import { setToken } from '@/lib/auth';
import type { Character, LivingSpace } from '@/lib/contracts';
import type { Gathering } from '@/lib/gatherings';
import type { HomeLeisureActivity } from '@/lib/living-home-leisure';

type WorldProps = { gathering: Gathering; animate: boolean; busy: boolean; persistentWorld: boolean;
  emptyMessage?: string;
  onActivity?: (id: number, activity: 'rest' | 'sleep' | 'walk' | 'observe' | 'talk') => Promise<void> | void;
  onLeisureAction?: (request: { actorId: number; activity: HomeLeisureActivity | null; seatId?: string }) => Promise<void> | void };
const holder = vi.hoisted(() => ({ props: null as WorldProps | null }));
vi.mock('next/dynamic', () => ({ default: () => function World(props: WorldProps) {
  holder.props = props;
  return <div data-testid="saved-world" data-activity={props.gathering.companions[0]?.activity} data-leisure={props.gathering.companions[0]?.leisure?.activity ?? ''}
    data-persistent={String(props.persistentWorld)} data-animate={String(props.animate)}>
    {props.emptyMessage && <p>{props.emptyMessage}</p>}
    <button disabled={props.busy || !props.onActivity} onClick={() => void props.onActivity?.(1, 'sleep')}>安排睡觉</button>
    <button disabled={props.busy || !props.onLeisureAction} onClick={() => void props.onLeisureAction?.({ actorId: 1, activity: 'tea', seatId: 'home-tea-0' })}>安排喝茶</button>
    <button disabled={props.busy || !props.onLeisureAction} onClick={() => void props.onLeisureAction?.({ actorId: 1, activity: null })}>停止休闲</button>
  </div>;
} }));
vi.mock('@/components/season-settings', () => ({ default: () => null }));
vi.mock('@/components/space-decorations', () => ({ default: () => null }));
vi.mock('@/components/life-journal', () => ({ default: () => null }));
vi.mock('@/lib/seasons', async original => ({ ...await original<typeof import('@/lib/seasons')>(), seasonApi: { read: vi.fn(async () => ({ current_season: 'autumn' })) } }));
vi.mock('@/lib/api', async original => ({ ...await original<typeof import('@/lib/api')>(), api: { living: { action: vi.fn(), space: vi.fn() } } }));
const person: Character = { id: 1, name: '旧伙伴', persona: '', opening_line: '', image_path: null, status: 'ready', created_at: '' };
const sample = (): LivingSpace => ({ id: 'actual-space', owner_id: 'owner-a', companion_id: '1', mode: 'private', scene_type: 'home', revision: 5, observed_at: 100, can_undo: true,
  resident_here: true,
  world: { activity: 'observe', area: 'outdoor' }, avatar3d: { version: 1, kind: 'cup', body: '#eeeeee', accent: '#aaaaaa', detail: '#333333', seed: 1, source: 'procedural_existing_features' },
  items: [{ id: 'tree', kind: 'tree', x: .3, y: .4, stored: false, flipped: true, growth_seconds: 0, stage: 'planted', care_remaining_seconds: 0, growth_status: 'needs_care' }] });
const editor = () => <p>原布置和照料入口</p>;
function Harness({ initial = sample(), visible = true, readOnly = false }: { initial?: LivingSpace; visible?: boolean; readOnly?: boolean }) {
  const [space, setSpace] = useState(initial);
  return <PrivateLivingWorld space={space} companions={[person]} visible={visible} readOnly={readOnly} onChange={setSpace} renderEditor={editor} />;
}
beforeEach(() => {
  vi.clearAllMocks(); setToken('unit-account-a'); holder.props = null;
  vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() } as unknown as MediaQueryList)));
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it('loads a real private ID and saves one free activity, then restores it on a fresh mount', async () => {
  let persisted = sample(); vi.mocked(api.living.action).mockImplementation(async (_id, _request, _revision, command) => {
    persisted = { ...persisted, revision: 6, world: { activity: command.activity as 'sleep', area: 'bedroom' } }; return persisted;
  });
  const first = render(<Harness />); expect(screen.getByTestId('saved-world')).toHaveAttribute('data-persistent', 'true');
  expect(holder.props?.gathering.id).toBe('actual-space'); fireEvent.click(screen.getByRole('button', { name: '安排睡觉' }));
  await waitFor(() => expect(screen.getByTestId('saved-world')).toHaveAttribute('data-activity', 'sleep'));
  expect(api.living.action).toHaveBeenCalledExactlyOnceWith('actual-space', expect.any(String), 5, { action: 'world_activity', activity: 'sleep' });
  expect(persisted.items).toEqual(sample().items); first.unmount(); render(<Harness initial={persisted} />);
  expect(screen.getByTestId('saved-world')).toHaveAttribute('data-activity', 'sleep'); expect(api.living.action).toHaveBeenCalledTimes(1);
});
it('persists and stops a leisure overlay without x/y or elapsed fields', async () => {
  let persisted = sample(); vi.mocked(api.living.action).mockImplementation(async (_id, _request, _revision, command) => {
    persisted = { ...persisted, revision: persisted.revision + 1, world: command.activity === null ? { activity: 'observe', area: 'outdoor' } : {
      activity: 'observe', area: 'outdoor', leisure: { activity: 'tea', seat_id: 'home-tea-0', station_version: 1 } } }; return persisted;
  });
  render(<Harness />); fireEvent.click(screen.getByRole('button', { name: '安排喝茶' }));
  await waitFor(() => expect(screen.getByTestId('saved-world')).toHaveAttribute('data-leisure', 'tea'));
  expect(api.living.action).toHaveBeenLastCalledWith('actual-space', expect.any(String), 5, { action: 'world_leisure', activity: 'tea', seat_id: 'home-tea-0', station_version: 1 });
  fireEvent.click(screen.getByRole('button', { name: '停止休闲' }));
  await waitFor(() => expect(screen.getByTestId('saved-world')).toHaveAttribute('data-leisure', ''));
  expect(api.living.action).toHaveBeenLastCalledWith('actual-space', expect.any(String), 6, { action: 'world_leisure', activity: null });
});
it('does not optimistically sit down or submit twice while a request is pending', async () => {
  let resolve!: (value: LivingSpace) => void; vi.mocked(api.living.action).mockReturnValue(new Promise(done => { resolve = done; }));
  render(<Harness />); const button = screen.getByRole('button', { name: '安排睡觉' }); fireEvent.click(button); fireEvent.click(button);
  expect(api.living.action).toHaveBeenCalledTimes(1); expect(screen.getByTestId('saved-world')).toHaveAttribute('data-activity', 'observe');
  await act(async () => resolve({ ...sample(), revision: 6, world: { activity: 'sleep', area: 'bedroom' } }));
  expect(screen.getByTestId('saved-world')).toHaveAttribute('data-activity', 'sleep');
});
it('reconciles a lost response by GET without retrying the model or original command', async () => {
  vi.mocked(api.living.action).mockRejectedValue(new Error('响应中断'));
  vi.mocked(api.living.space).mockResolvedValue({ ...sample(), revision: 6, world: { activity: 'sleep', area: 'bedroom' } });
  render(<Harness />); fireEvent.click(screen.getByRole('button', { name: '安排睡觉' }));
  await waitFor(() => expect(screen.getByTestId('saved-world')).toHaveAttribute('data-activity', 'sleep'));
  expect(api.living.action).toHaveBeenCalledTimes(1); expect(api.living.space).toHaveBeenCalledExactlyOnceWith('actual-space');
});
it('locks new actions after an unknown save until a valid snapshot is explicitly read', async () => {
  vi.mocked(api.living.action).mockRejectedValue(new Error('响应中断')); vi.mocked(api.living.space).mockRejectedValueOnce(new Error('离线'));
  render(<Harness />); fireEvent.click(screen.getByRole('button', { name: '安排睡觉' }));
  await screen.findByText(/保存结果尚未确认/); expect(screen.getByRole('button', { name: '安排睡觉' })).toBeDisabled();
  vi.mocked(api.living.space).mockResolvedValue(sample()); fireEvent.click(screen.getByRole('button', { name: '核对住处' }));
  await waitFor(() => expect(screen.getByRole('button', { name: '安排睡觉' })).not.toBeDisabled()); expect(api.living.action).toHaveBeenCalledTimes(1);
});
it('rejects a cross-owner readback and leaves the original scene locked', async () => {
  vi.mocked(api.living.action).mockRejectedValue(new Error('冲突')); vi.mocked(api.living.space).mockResolvedValue({ ...sample(), owner_id: 'another-owner' });
  const onChange = vi.fn(); render(<PrivateLivingWorld space={sample()} companions={[person]} visible readOnly={false} onChange={onChange} renderEditor={editor} />);
  fireEvent.click(screen.getByRole('button', { name: '安排睡觉' })); await screen.findByText(/保存结果尚未确认/); expect(onChange).not.toHaveBeenCalled();
});
it('keeps read-only and absent companions from using either write callback', async () => {
  const view = render(<Harness readOnly />); expect(screen.getByRole('button', { name: '安排睡觉' })).toBeDisabled();
  await act(async () => { await holder.props?.onActivity?.(1, 'sleep'); await holder.props?.onLeisureAction?.({ actorId: 1, activity: 'tea' }); });
  expect(api.living.action).not.toHaveBeenCalled(); view.unmount();
  render(<PrivateLivingWorld space={sample()} companions={[]} visible readOnly={false} onChange={vi.fn()} renderEditor={editor} />);
  await act(async () => { await holder.props?.onActivity?.(1, 'sleep'); }); expect(api.living.action).not.toHaveBeenCalled(); expect(holder.props?.gathering.companions).toEqual([]);
});
it('does not duplicate or write an away resident and displays it again only after a fresh true snapshot', async () => {
  const onChange = vi.fn(), away = { ...sample(), resident_here: false }, props = { companions: [person], visible: true, readOnly: false, onChange, renderEditor: editor };
  const view = render(<PrivateLivingWorld {...props} space={away} />);
  expect(holder.props?.gathering.companions).toEqual([]); expect(screen.getByText('伙伴在外面相聚，这里保留原布置。')).toBeInTheDocument();
  await act(async () => { await holder.props?.onActivity?.(1, 'sleep'); await holder.props?.onLeisureAction?.({ actorId: 1, activity: 'tea' }); });
  expect(api.living.action).not.toHaveBeenCalled(); expect(holder.props?.gathering.items).toHaveLength(1);
  view.rerender(<PrivateLivingWorld {...props} space={{ ...away, resident_here: true }} />);
  expect(holder.props?.gathering.companions).toHaveLength(1); expect(api.living.action).not.toHaveBeenCalled();
});
it('keeps a partial world payload without resident_here in the old read-only editor', () => {
  const unknown = { ...sample() }; delete unknown.resident_here;
  render(<LivingScene space={unknown} companion={person} onChange={vi.fn()} />);
  expect(screen.queryByTestId('saved-world')).toBeNull(); expect(screen.queryByRole('button', { name: '布置场景' })).toBeNull();
  expect(screen.getByRole('group', { name: '场景' })).toBeInTheDocument(); expect(api.living.action).not.toHaveBeenCalled();
});
it('adds a forest bench through the original editor and keeps its position after a fresh snapshot', async () => {
  let saved = { ...sample(), scene_type: 'forest' as const };
  vi.mocked(api.living.action).mockImplementation(async (_id, _request, _revision, command) => {
    saved = { ...saved, revision: 6, items: [...saved.items, { id: 'saved-bench', kind: String(command.kind), x: Number(command.x), y: Number(command.y), stored: false, growth_seconds: 0, stage: null, care_remaining_seconds: null, growth_status: null }] }; return saved;
  });
  function Forest() { const [space, setSpace] = useState<LivingSpace>(saved); return <LivingScene space={space} companion={person} onChange={setSpace} />; }
  const first = render(<Forest />); fireEvent.click(screen.getByRole('button', { name: '布置与照料' })); fireEvent.click(screen.getByRole('button', { name: '布置场景' }));
  fireEvent.click(screen.getByRole('button', { name: /长椅/ }));
  await waitFor(() => expect(saved.items).toHaveLength(2)); expect(api.living.action).toHaveBeenCalledExactlyOnceWith('actual-space', expect.any(String), 5, expect.objectContaining({ action: 'place', kind: 'bench' }));
  const point = { x: saved.items[1].x, y: saved.items[1].y }; first.unmount(); render(<Forest />);
  expect(holder.props?.gathering.items.find(item => item.id === 'saved-bench')).toMatchObject(point); expect(saved.items[0]).toEqual(sample().items[0]);
});
it('unmounts the world when hidden and discards a pending result after account changes', async () => {
  let resolve!: (value: LivingSpace) => void; vi.mocked(api.living.action).mockReturnValue(new Promise(done => { resolve = done; }));
  const onChange = vi.fn(), props = { space: sample(), companions: [person], visible: true, readOnly: false, onChange, renderEditor: editor };
  const view = render(<PrivateLivingWorld {...props} />); fireEvent.click(screen.getByRole('button', { name: '安排睡觉' }));
  view.rerender(<PrivateLivingWorld {...props} visible={false} />); expect(screen.queryByTestId('saved-world')).toBeNull();
  act(() => setToken('unit-account-b')); await act(async () => resolve({ ...sample(), revision: 6 }));
  expect(onChange).not.toHaveBeenCalled(); expect(screen.getByText(/登录状态已改变/)).toBeInTheDocument();
});
it.each(['home', 'forest', 'desert'] as const)('%s retains the original layout editor and returns to 3D without changing coordinates', scene_type => {
  render(<LivingScene space={{ ...sample(), scene_type }} companion={person} onChange={vi.fn()} />);
  expect(screen.getByTestId('saved-world')).toBeInTheDocument(); fireEvent.click(screen.getByRole('button', { name: '布置与照料' }));
  expect(screen.queryByTestId('saved-world')).toBeNull(); expect(screen.getByRole('button', { name: '布置场景' })).toBeInTheDocument();
  expect(screen.getByRole('group', { name: scene_type === 'desert' ? '绿洲沙地' : '场景' })).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: '回到立体生活' })); expect(holder.props?.gathering.items[0]).toMatchObject({ x: .3, y: .4, flipped: true });
  expect(api.living.action).not.toHaveBeenCalled();
});
