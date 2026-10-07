import React from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import SceneCompanions from '@/components/scene-companions';
import SceneLifeNow from '@/components/scene-life-now';
import { setToken, clearToken } from '@/lib/auth';
import type { RuntimeSnapshot } from '@/lib/life-runtime';
import type { Character, LivingSpace } from '@/lib/contracts';

vi.mock('@/components/private-image', () => ({ default: () => <span>原图</span> }));
vi.mock('@/components/private-motion-player', () => ({ default: ({ activity }: { activity: string }) => <span>自动动作 {activity}</span> }));
vi.mock('@/components/companion-motion-preview', () => ({ default: ({ activity }: { activity?: string }) => <span>弹窗活动 {activity ?? 'none'}</span> }));
const person = { id: 4, name: '苹果', image_path: 'apple.png', status: 'ready' } as Character;
const space = { id: 'space', mode: 'private', companion_id: '4', scene_type: 'desert', items: [] } as unknown as LivingSpace;
const snapshot: RuntimeSnapshot = { origin: 'real_provider', space_id: space.id, companion_id: '4', present: true,
  observed_at: 100, next_allowed_at: 700, permission: { enabled: true, revision: 1, activities: ['rest', 'walk'] }, tasks: [],
  current_activity: { task_id: 'task', activity: 'walk', target_id: null, started_at: 100, expires_at: 102, source: 'viewing' } };
function Scene({ state = snapshot, stale = false }: { state?: RuntimeSnapshot; stale?: boolean }) {
  const props = { space, companions: [person], view: { snapshot: state, stale } };
  return <><SceneCompanions {...props} /><SceneLifeNow {...props} editing={false} onLocate={vi.fn()} onUpdated={vi.fn()} onRefresh={vi.fn()} /></>;
}
beforeEach(() => {
  vi.useFakeTimers(); setToken('lifecycle-test');
  Object.defineProperty(document, 'hidden', { value: false, configurable: true });
  Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
  vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() }));
  HTMLDialogElement.prototype.showModal = function () { this.setAttribute('open', ''); };
  HTMLDialogElement.prototype.close = function () { this.removeAttribute('open'); };
});
afterEach(() => { vi.useRealTimers(); clearToken(); vi.unstubAllGlobals(); });

it('expires both the automatic scene and open activity preview without a network reply', () => {
  render(<Scene />);
  expect(screen.getByText('自动动作 walk')).toBeInTheDocument();
  expect(screen.queryByText('场景动作预览')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: '看看苹果的动作' }));
  expect(screen.getByText('弹窗活动 walk')).toBeInTheDocument();
  act(() => vi.advanceTimersByTime(2000));
  expect(screen.queryByText('自动动作 walk')).toBeNull();
  expect(screen.getByText('弹窗活动 none')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: '关闭' }));
  expect(screen.getByText('场景动作预览')).toBeInTheDocument();
});

it('does not extend a task on an old poll and plays a genuinely new task', () => {
  const page = render(<Scene />);
  act(() => vi.advanceTimersByTime(1500));
  page.rerender(<Scene state={{ ...snapshot }} />);
  act(() => vi.advanceTimersByTime(500));
  expect(screen.queryByText('自动动作 walk')).toBeNull();
  page.rerender(<Scene state={{ ...snapshot, current_activity: { ...snapshot.current_activity!, expires_at: 110 } }} />);
  expect(screen.queryByText('自动动作 walk')).toBeNull();
  page.rerender(<Scene state={{ ...snapshot, observed_at: 102, current_activity: { ...snapshot.current_activity!, task_id: 'next', activity: 'rest', started_at: 102, expires_at: 104 } }} />);
  expect(screen.getByText('自动动作 rest')).toBeInTheDocument();
});

it('never mounts an already expired activity after refreshing the page', () => {
  render(<Scene state={{ ...snapshot, observed_at: 103 }} />);
  expect(screen.queryByText('自动动作 walk')).toBeNull();
  expect(screen.getByText('场景动作预览')).toBeInTheDocument();
});

it('pausing permissions cancels automatic playback and releases the manual entry', () => {
  const page = render(<Scene />);
  page.rerender(<Scene state={{ ...snapshot, permission: { ...snapshot.permission, enabled: false } }} />);
  expect(screen.queryByText('自动动作 walk')).toBeNull();
  expect(screen.getByText('场景动作预览')).toBeInTheDocument();
});

it('keeps manual playback unavailable while disconnected even after local expiry', () => {
  const page = render(<Scene />); page.rerender(<Scene stale />);
  act(() => vi.advanceTimersByTime(2000));
  expect(screen.queryByText('自动动作 walk')).toBeNull();
  expect(screen.queryByText('场景动作预览')).toBeNull();
  page.rerender(<Scene state={{ ...snapshot, observed_at: 103 }} />);
  expect(screen.getByText('场景动作预览')).toBeInTheDocument();
});
