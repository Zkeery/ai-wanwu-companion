import React, { useEffect } from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import SceneLifeNow from '@/components/scene-life-now';
import { AUTH_CHANGED, TOKEN_KEY } from '@/lib/auth';
import { runtimeApi, type RuntimeSnapshot } from '@/lib/life-runtime';
import type { Character, LivingSpace } from '@/lib/contracts';
const calls = vi.hoisted(() => ({ mount: vi.fn(), release: vi.fn() }));
vi.mock('@/components/private-image', () => ({ default: () => <span>静态</span> }));
vi.mock('@/components/private-motion-player', () => ({ default: function Player({ id, activity, scene, compact }: { id: number; activity: string; scene?: boolean; compact?: boolean }) {
  useEffect(() => { calls.mount(id, activity, !!scene); return () => calls.release(id, activity, !!scene); }, [id, activity, scene]);
  return <p data-compact={!!compact}>{scene ? '场景动作' : '对应动作'} {activity}</p>;
} }));
vi.mock('@/lib/life-runtime', async original => ({ ...await original<typeof import('@/lib/life-runtime')>(), runtimeApi: { save: vi.fn(), read: vi.fn(), run: vi.fn(), schedule: vi.fn() } }));
const sid = '11111111-1111-4111-8111-111111111111', tid = '22222222-2222-4222-8222-222222222222', iid = '33333333-3333-4333-8333-333333333333';
const person: Character = { id: 1, name: '小满', persona: '', opening_line: '', image_path: 'characters/fixture.png', status: 'ready', created_at: '' };
const space: LivingSpace = { id: sid, scene_type: 'home', mode: 'private', companion_id: '1', revision: 1, observed_at: 100, can_undo: false, items: [{ id: iid, kind: 'tree', x: .5, y: .5, stored: false, growth_seconds: 0, stage: 'planted', care_remaining_seconds: 0, growth_status: 'needs_care' }] };
const snapshot: RuntimeSnapshot = { origin: 'offline_fixture', space_id: sid, companion_id: '1', present: true, observed_at: 200, next_allowed_at: 700, permission: { enabled: true, activities: ['rest', 'walk', 'observe'], revision: 3 }, tasks: [{ id: tid, state: 'done', created_at: 100, retry_at: 0, activity: 'observe', target_id: iid, error_code: null }], current_activity: { task_id: tid, activity: 'observe', target_id: iid, started_at: 105, expires_at: 705, source: 'viewing' } };
const props = { view: { snapshot, stale: false }, space, companions: [person], editing: false, onLocate: vi.fn(), onUpdated: vi.fn(), onRefresh: vi.fn() };
const open = () => fireEvent.click(screen.getByRole('button', { name: '此刻在做什么' }));
beforeEach(() => {
  vi.clearAllMocks(); localStorage.setItem(TOKEN_KEY, 'synthetic-motion-account');
  vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() }));
  Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
  HTMLDialogElement.prototype.showModal = function () { this.setAttribute('open', ''); };
  HTMLDialogElement.prototype.close = function () { this.removeAttribute('open'); };
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); localStorage.clear(); });
it.each(['home', 'forest', 'desert'] as const)('shows %s activity in the scene and hands playback to its detail', scene_type => {
  render(<SceneLifeNow {...props} space={{ ...space, scene_type }} />);
  expect(calls.mount).toHaveBeenCalledExactlyOnceWith(1, 'observe', true); open();
  expect(screen.getByText('对应动作 observe')).toHaveAttribute('data-compact', 'false');
  expect(calls.release).toHaveBeenCalledWith(1, 'observe', true);
  expect(calls.mount).toHaveBeenLastCalledWith(1, 'observe', false);
  fireEvent.click(screen.getByRole('button', { name: '关闭' }));
  expect(calls.release).toHaveBeenCalledWith(1, 'observe', false);
  expect(calls.mount).toHaveBeenLastCalledWith(1, 'observe', true);
  expect(screen.getByText('场景动作 observe')).toHaveAttribute('data-compact', 'true');
  expect(runtimeApi.run).not.toHaveBeenCalled(); expect(runtimeApi.schedule).not.toHaveBeenCalled();
  expect(runtimeApi.save).not.toHaveBeenCalled();
});
it('switches the scene asset with the saved task and releases it on pause or stale data', () => {
  const view = render(<SceneLifeNow {...props} />);
  expect(calls.mount).toHaveBeenCalledExactlyOnceWith(1, 'observe', true);
  const rest = { ...snapshot, current_activity: { ...snapshot.current_activity!,
    task_id: '44444444-4444-4444-8444-444444444444', activity: 'rest' as const, target_id: null } };
  view.rerender(<SceneLifeNow {...props} view={{ snapshot: rest, stale: false }} />);
  expect(calls.release).toHaveBeenCalledWith(1, 'observe', true);
  expect(calls.mount).toHaveBeenLastCalledWith(1, 'rest', true);
  view.rerender(<SceneLifeNow {...props} view={{ snapshot: rest, stale: true }} />);
  expect(calls.release).toHaveBeenCalledWith(1, 'rest', true);
  expect(screen.queryByText('场景动作 rest')).not.toBeInTheDocument();
  expect(runtimeApi.schedule).not.toHaveBeenCalled(); expect(runtimeApi.run).not.toHaveBeenCalled();
});
it('does not fetch scene media while hidden or reduced motion is requested', () => {
  Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
  const view = render(<SceneLifeNow {...props} />);
  expect(calls.mount).not.toHaveBeenCalled();
  act(() => { Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
    document.dispatchEvent(new Event('visibilitychange')); });
  expect(calls.mount).toHaveBeenCalledExactlyOnceWith(1, 'observe', true);
  view.unmount(); vi.clearAllMocks();
  vi.stubGlobal('matchMedia', () => ({ matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn() }));
  render(<SceneLifeNow {...props} />);
  expect(calls.mount).not.toHaveBeenCalled();
});
it('releases the scene player immediately when the account changes', () => {
  render(<SceneLifeNow {...props} />);
  expect(calls.mount).toHaveBeenCalledExactlyOnceWith(1, 'observe', true);
  act(() => { localStorage.setItem(TOKEN_KEY, 'different-account'); window.dispatchEvent(new Event(AUTH_CHANGED)); });
  expect(calls.release).toHaveBeenCalledExactlyOnceWith(1, 'observe', true);
  expect(screen.queryByLabelText('伙伴当前活动画面')).not.toBeInTheDocument();
  expect(runtimeApi.save).not.toHaveBeenCalled();
});
it.each(['stale', 'pause', 'stored', 'missing', 'editing', 'away'] as const)('releases playback when %s invalidates the current task', reason => {
  const view = render(<SceneLifeNow {...props} />); open();
  const next = { ...props, view: { snapshot: { ...snapshot }, stale: false }, space: { ...space }, companions: [person] };
  if (reason === 'stale') next.view.stale = true;
  if (reason === 'pause') next.view.snapshot.permission = { ...snapshot.permission, enabled: false };
  if (reason === 'stored') next.space.items = space.items.map(i => ({ ...i, stored: true }));
  if (reason === 'missing') next.space.items = [];
  if (reason === 'editing') next.editing = true;
  if (reason === 'away') next.companions = [];
  view.rerender(<SceneLifeNow {...next} />);
  expect(calls.release).toHaveBeenCalledWith(1, 'observe', false);
  expect(screen.queryByText('场景动作 observe')).not.toBeInTheDocument();
  expect(screen.queryByText('对应动作 observe')).not.toBeInTheDocument();
});
it('retains the same task on normal refresh, remounts the new activity, and expires locally', () => {
  vi.useFakeTimers();
  const view = render(<SceneLifeNow {...props} />); open();
  view.rerender(<SceneLifeNow {...props} view={{ snapshot: { ...snapshot, observed_at: 201 }, stale: false }} />);
  expect(calls.mount).toHaveBeenCalledTimes(2);
  const rest = { ...snapshot, tasks: [{ ...snapshot.tasks[0], activity: 'rest' as const, target_id: null }],
    current_activity: { ...snapshot.current_activity!, task_id: '44444444-4444-4444-8444-444444444444', activity: 'rest' as const, target_id: null } };
  rest.tasks[0].id = rest.current_activity.task_id;
  view.rerender(<SceneLifeNow {...props} view={{ snapshot: rest, stale: false }} />);
  expect(calls.release).toHaveBeenCalledWith(1, 'observe', false);
  expect(calls.mount).toHaveBeenLastCalledWith(1, 'rest', false);
  act(() => vi.advanceTimersByTime(505000));
  expect(calls.release).toHaveBeenCalledWith(1, 'rest', false);
});
it('releases on page hiding and account change without writing', () => {
  render(<SceneLifeNow {...props} />); open();
  act(() => { Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true }); document.dispatchEvent(new Event('visibilitychange')); });
  expect(calls.release).toHaveBeenCalledWith(1, 'observe', false);
  act(() => { Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true }); document.dispatchEvent(new Event('visibilitychange')); });
  expect(calls.mount).toHaveBeenCalledTimes(3);
  act(() => { localStorage.setItem(TOKEN_KEY, 'different-account'); window.dispatchEvent(new Event(AUTH_CHANGED)); });
  expect(calls.release).toHaveBeenCalledTimes(3);
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument(); expect(runtimeApi.save).not.toHaveBeenCalled();
});
