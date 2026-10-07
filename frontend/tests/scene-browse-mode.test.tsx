import React from 'react';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import LivingScene from '@/components/living-scene';
import { api } from '@/lib/api';
import type { LivingSpace } from '@/lib/contracts';

vi.mock('@/components/season-settings', () => ({ default: () => null }));
vi.mock('@/components/space-decorations', () => ({ default: () => null }));
vi.mock('@/components/life-journal', () => ({ default: () => null }));
vi.mock('@/lib/api', async original => ({ ...await original<typeof import('@/lib/api')>(), api: { living: { action: vi.fn(), space: vi.fn() } } }));
const scenes = ['home', 'forest', 'desert'] as const;
const sample = (scene_type: LivingSpace['scene_type']): LivingSpace => ({ id: scene_type, scene_type, mode: 'private', companion_id: '1', revision: 2, observed_at: 100, can_undo: true,
  items: [{ id: 'plant', kind: 'tree', x: .4, y: .5, stored: false, growth_seconds: 0, stage: 'planted', care_remaining_seconds: 0, growth_status: 'needs_care' }] });
const button = (name: string) => screen.getByRole('button', { name });
const board = (scene: string) => screen.getByRole('group', { name: scene === 'desert' ? '绿洲沙地' : '场景' });
const plant = (scene: string) => within(board(scene)).getByRole('button');
class Pointer extends MouseEvent {
  pointerId: number; isPrimary: boolean;
  constructor(type: string, init: PointerEventInit = {}) { super(type, init); this.pointerId = init.pointerId ?? 1; this.isPrimary = true; }
}
beforeEach(() => {
  vi.clearAllMocks(); vi.stubGlobal('PointerEvent', Pointer);
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({ left: 0, top: 0, width: 800, height: 600 } as DOMRect);
  HTMLElement.prototype.setPointerCapture = vi.fn(); HTMLElement.prototype.hasPointerCapture = () => false;
  vi.mocked(api.living.action).mockImplementation(async id => sample(scenes.find(scene => scene === id) ?? 'home'));
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it.each(scenes)('%s defaults to browsing: gestures and keys cannot rearrange, care still works', async scene => {
  render(<LivingScene space={sample(scene)} onChange={vi.fn()} />);
  expect(button('布置场景')).toHaveAttribute('aria-pressed', 'false');
  expect(screen.queryByRole('button', { name: '撤销一步' })).toBeNull();
  expect(screen.queryByRole('combobox')).toBeNull();
  fireEvent.click(plant(scene));
  expect(screen.queryByRole('button', { name: '收纳' })).toBeNull();
  fireEvent.pointerDown(plant(scene), { button: 0, clientX: 250, clientY: 300 });
  fireEvent.pointerMove(plant(scene), { clientX: 350, clientY: 350 });
  fireEvent.pointerUp(plant(scene), { clientX: 350, clientY: 350 });
  fireEvent.keyDown(plant(scene), { key: 'ArrowRight' });
  fireEvent.click(board(scene), { clientX: 500, clientY: 450 });
  expect(api.living.action).not.toHaveBeenCalled();
  expect(plant(scene)).toHaveStyle({ touchAction: 'pan-y' });
  fireEvent.click(button('照料'));
  await waitFor(() => expect(api.living.action).toHaveBeenCalledExactlyOnceWith(scene, expect.any(String), 2, { action: 'care', item_id: 'plant' }));
});

it.each(scenes)('%s finishing editing cancels an unfinished gesture and hides write tools', scene => {
  render(<LivingScene space={sample(scene)} onChange={vi.fn()} />);
  fireEvent.click(button('布置场景')); fireEvent.click(plant(scene));
  expect(button('收纳')).toBeVisible(); expect(button('撤销一步')).toBeVisible();
  fireEvent.pointerDown(plant(scene), { button: 0, clientX: 250, clientY: 300 });
  fireEvent.pointerMove(plant(scene), { clientX: 350, clientY: 350 });
  fireEvent.click(button('完成布置'));
  fireEvent.pointerUp(plant(scene), { clientX: 350, clientY: 350 });
  expect(api.living.action).not.toHaveBeenCalled();
  expect(screen.queryByRole('button', { name: '收纳' })).toBeNull();
  expect(screen.queryByRole('button', { name: '撤销一步' })).toBeNull();
  fireEvent.click(button('布置场景'));
  expect(screen.getByRole('combobox')).toHaveValue('');
});

it.each(scenes)('%s leaves editing when hidden, changing spaces, or becoming read-only', scene => {
  const props = { space: sample(scene), onChange: vi.fn() };
  const view = render(<LivingScene {...props} />);
  fireEvent.click(button('布置场景'));
  view.rerender(<LivingScene {...props} visible={false} />);
  view.rerender(<LivingScene {...props} />);
  expect(button('布置场景')).toHaveAttribute('aria-pressed', 'false');
  fireEvent.click(button('布置场景'));
  view.rerender(<LivingScene {...props} space={{ ...props.space, id: 'another' }} />);
  expect(button('布置场景')).toHaveAttribute('aria-pressed', 'false');
  fireEvent.click(button('布置场景'));
  view.rerender(<LivingScene {...props} space={{ ...props.space, id: 'another' }} readOnly />);
  expect(screen.queryByRole('button', { name: '完成布置' })).toBeNull();
  view.rerender(<LivingScene {...props} space={{ ...props.space, id: 'another' }} />);
  expect(button('布置场景')).toHaveAttribute('aria-pressed', 'false');
  expect(api.living.action).not.toHaveBeenCalled();
});

it('discarding a desert template or pending placement does not save or return on reopening', () => {
  render(<LivingScene space={sample('desert')} onChange={vi.fn()} />);
  fireEvent.click(button('布置场景')); fireEvent.click(button('预览水边小憩'));
  fireEvent.click(button('完成布置')); fireEvent.click(button('布置场景'));
  expect(screen.queryByRole('button', { name: '应用这套布置' })).toBeNull();
  fireEvent.click(button('放置仙人掌')); fireEvent.click(button('完成布置'));
  fireEvent.click(board('desert'), { clientX: 500, clientY: 450 });
  fireEvent.click(button('布置场景'));
  expect(screen.queryByRole('button', { name: '取消放置' })).toBeNull();
  expect(api.living.action).not.toHaveBeenCalled();
});

it.each(scenes)('%s cancels an unfinished gesture in the background but preserves editing selection', scene => {
  const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
  render(<LivingScene space={sample(scene)} onChange={vi.fn()} />);
  fireEvent.click(button('布置场景'));
  fireEvent.click(plant(scene));
  fireEvent.pointerDown(plant(scene), { button: 0, clientX: 250, clientY: 300 });
  fireEvent.pointerMove(plant(scene), { clientX: 350, clientY: 350 });
  visibility.mockReturnValue('hidden'); fireEvent(document, new Event('visibilitychange'));
  visibility.mockReturnValue('visible'); fireEvent(document, new Event('visibilitychange'));
  fireEvent.pointerUp(plant(scene), { clientX: 350, clientY: 350 });
  expect(button('完成布置')).toHaveAttribute('aria-pressed', 'true');
  expect(plant(scene)).toHaveAttribute('aria-pressed', 'true');
  expect(api.living.action).not.toHaveBeenCalled();
});
