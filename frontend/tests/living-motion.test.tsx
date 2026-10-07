import React, { useEffect } from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import LivingScene from '@/components/living-scene';
import { api } from '@/lib/api';
import type { Character, LivingSpace } from '@/lib/contracts';
import { setToken } from '@/lib/auth';

vi.mock('@/lib/motion-preparation', () => ({ readMotionPreparation: vi.fn(async () => null) }));

const lifecycle = vi.hoisted(() => ({ mount: vi.fn(), release: vi.fn() }));
vi.mock('@/components/private-motion-player', () => ({ default: function Player({ id, activity }: { id: number; activity?: string }) {
  useEffect(() => { lifecycle.mount(id); return () => lifecycle.release(id); }, [id]);
  return <p>播放器 {id} · {activity ?? 'default'}</p>;
} }));
vi.mock('@/components/private-image', () => ({ default: () => <span>伙伴头像</span> }));
vi.mock('@/components/season-settings', () => ({ default: () => null }));
vi.mock('@/components/space-decorations', () => ({ default: () => null }));
vi.mock('@/lib/api', async original => ({ ...await original<typeof import('@/lib/api')>(), api: { living: { action: vi.fn(), space: vi.fn() } } }));
const space: LivingSpace = { id: 'home', scene_type: 'home', mode: 'private', companion_id: '1', revision: 3, observed_at: 1, can_undo: false, items: [], atmosphere: { rain: false, sound: false } };
const apple: Character = { id: 1, name: '苹果', persona: '', opening_line: '', image_path: 'characters/apple.png', status: 'ready', created_at: '' };
const cup = { ...apple, id: 2, name: '杯子' };
beforeEach(() => {
  vi.clearAllMocks();
  setToken('living-motion-test');
  HTMLDialogElement.prototype.showModal = function () { this.setAttribute('open', ''); };
  HTMLDialogElement.prototype.close = function () { this.removeAttribute('open'); };
});

it('opens only the chosen present companion on demand without changing the scene or chat link', () => {
  const change = vi.fn();
  render(<LivingScene space={space} companions={[apple, cup]} onChange={change} />);
  expect(lifecycle.mount).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: '布置场景' }));
  fireEvent.click(screen.getByRole('button', { name: '看看杯子的动作' }));
  expect(screen.getByRole('dialog', { name: '杯子的动作' })).toBeInTheDocument();
  expect(lifecycle.mount).toHaveBeenCalledExactlyOnceWith(2);
  expect(screen.getByRole('link', { name: '和杯子说话' })).toHaveAttribute('href', '/companions/2?tab=chat');
  expect(document.querySelector('a button')).toBeNull();
  expect(api.living.action).not.toHaveBeenCalled();
  expect(change).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: '关闭' }));
  expect(lifecycle.release).toHaveBeenCalledExactlyOnceWith(2);
  expect(screen.getByRole('button', { name: '完成布置' })).toBeInTheDocument();
});

it('releases playback when the life tab hides and does not reopen it on return', () => {
  const props = { space, companion: apple, onChange: vi.fn() };
  const view = render(<LivingScene {...props} visible />);
  fireEvent.click(screen.getByRole('button', { name: '布置场景' }));
  fireEvent.click(screen.getByRole('button', { name: '看看苹果的动作' }));
  view.rerender(<LivingScene {...props} visible={false} />);
  expect(lifecycle.release).toHaveBeenCalledExactlyOnceWith(1);
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  view.rerender(<LivingScene {...props} visible />);
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: '布置场景' })).toHaveAttribute('aria-pressed', 'false');
});

it('removes an absent companion and closes stale playback on membership or space changes', () => {
  const change = vi.fn();
  const view = render(<LivingScene space={space} companions={[apple, cup]} onChange={change} />);
  fireEvent.click(screen.getByRole('button', { name: '看看苹果的动作' }));
  view.rerender(<LivingScene space={space} companions={[cup]} onChange={change} />);
  expect(lifecycle.release).toHaveBeenCalledWith(1);
  expect(screen.queryByRole('button', { name: '看看苹果的动作' })).not.toBeInTheDocument();
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: '看看杯子的动作' }));
  view.rerender(<LivingScene space={{ ...space, id: 'another' }} companions={[cup]} onChange={change} />);
  expect(lifecycle.release).toHaveBeenCalledWith(2);
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  expect(api.living.action).not.toHaveBeenCalled();
});

it('retains chat without an image and offers no motion entry for an empty former home', () => {
  const view = render(<LivingScene space={space} companions={[{ ...apple, image_path: null }]} onChange={vi.fn()} />);
  expect(screen.getByRole('link', { name: '和苹果说话' })).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: /看看.*的动作/ })).not.toBeInTheDocument();
  view.rerender(<LivingScene space={space} companions={[]} readOnly onChange={vi.fn()} />);
  expect(screen.queryByLabelText('此刻在场的伙伴')).not.toBeInTheDocument();
  expect(lifecycle.mount).not.toHaveBeenCalled();
});

it('previews prepared activity slots without scheduling life and resets selection after close', () => {
  const change = vi.fn();
  render(<LivingScene space={space} companions={[apple, cup]} onChange={change} />);
  fireEvent.click(screen.getByRole('button', { name: '看看苹果的动作' }));
  fireEvent.click(screen.getByRole('button', { name: '散步' }));
  expect(screen.getByText('播放器 1 · walk')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: '散步' })).toHaveAttribute('aria-pressed', 'true');
  fireEvent.click(screen.getByRole('button', { name: '观察' }));
  expect(screen.getByText('播放器 1 · observe')).toBeInTheDocument();
  expect(api.living.action).not.toHaveBeenCalled();
  expect(change).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: '关闭' }));
  fireEvent.click(screen.getByRole('button', { name: '看看杯子的动作' }));
  expect(screen.getByText('播放器 2 · default')).toBeInTheDocument();
});
