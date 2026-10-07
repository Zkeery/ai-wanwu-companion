import React from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import SceneCompanions from '@/components/scene-companions';
import { setToken, clearToken } from '@/lib/auth';
import { clearPrivateMotionCache } from '@/lib/private-motion';
import type { Character, LivingSpace } from '@/lib/contracts';

vi.mock('@/lib/private-motion', () => ({ clearPrivateMotionCache: vi.fn() }));
vi.mock('@/components/private-image', () => ({ default: () => <span>原图</span> }));
vi.mock('@/components/companion-motion-preview', () => ({ default: () => <span>弹窗预览</span> }));
vi.mock('@/components/private-motion-player', () => ({ default: ({ activity, scene, onSceneStill }: { activity: string; scene: boolean; onSceneStill: (png: string) => void }) =>
  <button onClick={() => onSceneStill('data:image/png;base64,fixture')}>绘制{scene ? '场景' : ''}{activity}帧</button> }));

const person: Character = { id: 4, name: '苹果', persona: '', opening_line: '', image_path: 'apple.jpg', status: 'ready', created_at: '' };
const space: LivingSpace = { id: 'private-home', scene_type: 'home', mode: 'private', companion_id: '4', revision: 1, observed_at: 100, can_undo: false, items: [] };
const props = { companions: [person], space };
let reduced = false;
let preferenceChanged: (() => void) | undefined;
const open = () => fireEvent.click(screen.getByRole('button', { name: '在场景里预览苹果动作' }));
const preview = () => screen.queryByRole('group', { name: '苹果的场景动作预览' });
beforeEach(() => {
  vi.clearAllMocks(); reduced = false; setToken('scene-preview-owner');
  Object.defineProperty(document, 'hidden', { value: false, configurable: true });
  vi.stubGlobal('matchMedia', () => ({ matches: reduced, addEventListener: (_: string, fn: () => void) => { preferenceChanged = fn; }, removeEventListener: vi.fn() }));
  HTMLDialogElement.prototype.showModal = function () { this.setAttribute('open', ''); };
  HTMLDialogElement.prototype.close = function () { this.removeAttribute('open'); };
});
afterEach(() => { cleanup(); clearToken(); vi.unstubAllGlobals(); });

it.each(['home', 'forest', 'desert'] as const)('previews the bound walk in %s only after a real frame is available', scene_type => {
  const boardClick = vi.fn();
  render(<div onClick={boardClick}><SceneCompanions {...props} space={{ ...space, scene_type }} /></div>);
  expect(preview()).toBeNull(); open();
  expect(preview()).toHaveAttribute('data-moving', 'false');
  expect(screen.getByRole('button', { name: '暂停预览' })).toBeDisabled();
  fireEvent.click(screen.getByText('绘制场景walk帧'));
  expect(preview()).toHaveAttribute('data-moving', 'true');
  fireEvent.click(screen.getByRole('button', { name: '暂停预览' }));
  expect(preview()).toHaveAttribute('data-moving', 'false');
  expect(screen.getByAltText('苹果的散步暂停画面')).toBeInTheDocument();
  expect(screen.queryByText('绘制场景walk帧')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: '继续预览' }));
  expect(screen.getByText('绘制场景walk帧')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: '结束预览' }));
  expect(preview()).toBeNull(); expect(clearPrivateMotionCache).toHaveBeenCalledWith(4);
  expect(boardClick).not.toHaveBeenCalled();
});

it.each(['editing', 'space', 'account', 'hidden', 'reduced', 'left', 'stale', 'activity'] as const)('ends preview on %s without automatically reviving it', change => {
  const view = render(<SceneCompanions {...props} />); open();
  if (change === 'editing') view.rerender(<SceneCompanions {...props} editing />);
  if (change === 'space') view.rerender(<SceneCompanions {...props} space={{ ...space, id: 'another-space' }} />);
  if (change === 'account') act(() => setToken('another-owner'));
  if (change === 'hidden') act(() => { Object.defineProperty(document, 'hidden', { value: true, configurable: true }); document.dispatchEvent(new Event('visibilitychange')); });
  if (change === 'reduced') act(() => { reduced = true; preferenceChanged?.(); });
  if (change === 'left') view.rerender(<SceneCompanions {...props} companions={[]} />);
  if (change === 'stale') view.rerender(<SceneCompanions {...props} view={{ snapshot: null, stale: true }} />);
  if (change === 'activity') view.rerender(<SceneCompanions {...props} view={{ snapshot: { space_id: space.id, companion_id: '4', present: true, observed_at: 100, permission: { enabled: true }, current_activity: { task_id: 'active-task', activity: 'walk', expires_at: 700 } }, stale: false } as never} />);
  expect(preview()).toBeNull();
  if (change === 'hidden') act(() => { Object.defineProperty(document, 'hidden', { value: false, configurable: true }); document.dispatchEvent(new Event('visibilitychange')); });
  if (change === 'reduced') act(() => { reduced = false; preferenceChanged?.(); });
  view.rerender(<SceneCompanions {...props} />);
  expect(preview()).toBeNull();
});

it('does not offer a scene preview for shared spaces or a different resident', () => {
  const view = render(<SceneCompanions {...props} space={{ ...space, mode: 'shared' } as never} />);
  expect(screen.queryByRole('button', { name: '在场景里预览苹果动作' })).toBeNull();
  view.rerender(<SceneCompanions {...props} space={{ ...space, companion_id: '8' }} />);
  expect(screen.queryByRole('button', { name: '在场景里预览苹果动作' })).toBeNull();
});

it.each(['rest', 'observe'] as const)('switches paused walk to %s without carrying its frame or movement', activity => {
  render(<SceneCompanions {...props} />); open();
  fireEvent.click(screen.getByText('绘制场景walk帧'));
  fireEvent.click(screen.getByRole('button', { name: '暂停预览' }));
  fireEvent.click(screen.getByRole('button', { name: activity === 'rest' ? '休息' : '观察' }));
  expect(screen.queryByAltText('苹果的散步暂停画面')).toBeNull();
  expect(screen.getByRole('button', { name: '暂停预览' })).toBeDisabled();
  expect(preview()).toHaveAttribute('data-activity', activity);
  fireEvent.click(screen.getByText('绘制场景' + activity + '帧'));
  expect(preview()).toHaveAttribute('data-moving', 'false');
  fireEvent.click(screen.getByRole('button', { name: '暂停预览' }));
  expect(screen.getByAltText('苹果的' + (activity === 'rest' ? '休息' : '观察') + '暂停画面')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: '散步' }));
  expect(preview()).toHaveAttribute('data-moving', 'false');
  fireEvent.click(screen.getByText('绘制场景walk帧'));
  expect(preview()).toHaveAttribute('data-moving', 'true');
});
