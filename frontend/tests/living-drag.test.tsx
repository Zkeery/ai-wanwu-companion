import React, { useState } from 'react';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
// Journal has its own request/lifecycle suite; these tests isolate drag/atmosphere.
vi.mock('@/components/life-journal', () => ({ default: () => null }));
vi.mock('@/lib/activities', () => ({ activities: { inSpace: vi.fn().mockResolvedValue([]) }, decorationNames: {} }));
import LivingScene from '@/components/living-scene';
import { api } from '@/lib/api';
import type { LivingSpace } from '@/lib/contracts';

vi.mock('@/lib/seasons', async original => ({ ...await original<typeof import('@/lib/seasons')>(), seasonApi: { read: vi.fn().mockResolvedValue({ settings: null, current_season: null, revision: 0, started_at: null, next_change_at: null, observed_at: 1, timezone: 'Asia/Shanghai' }) } }));
vi.mock('@/lib/api', async original => ({ ...await original<typeof import('@/lib/api')>(), api: { living: { action: vi.fn(), space: vi.fn() } } }));
const space: LivingSpace = { id: 'one', scene_type: 'home', mode: 'private', companion_id: '1', revision: 1, observed_at: 1, can_undo: false, items: [{ id: 'tree-1', kind: 'tree', x: 0.3, y: 0.4, stored: false, growth_seconds: 0, stage: 'planted', care_remaining_seconds: 0, growth_status: 'needs_care' }] };
class Pointer extends MouseEvent {
  pointerId: number; isPrimary: boolean;
  constructor(type: string, props: PointerEventInit = {}) { super(type, props); this.pointerId = props.pointerId ?? 1; this.isPrimary = props.isPrimary ?? true; }
}
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal('PointerEvent', Pointer);
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({ x: 10, y: 20, left: 10, top: 20, right: 514, bottom: 416, width: 504, height: 396, toJSON() {} });
  HTMLElement.prototype.setPointerCapture = vi.fn();
  HTMLElement.prototype.releasePointerCapture = vi.fn();
  HTMLElement.prototype.hasPointerCapture = () => true;
  vi.mocked(api.living.action).mockImplementation(async (_id, _request, _revision, cmd) => ({ ...space, revision: 2, can_undo: true, items: [{ ...space.items[0], ...(cmd as object) }] }));
  vi.mocked(api.living.space).mockResolvedValue(space);
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });
function Harness() { const [s, set] = useState(space); return <LivingScene space={s} onChange={set} />; }
function item() { return within(screen.getByRole('group', { name: '场景' })).getByRole('button'); }
function begin() { fireEvent.click(screen.getByRole('button', { name: '布置场景' })); fireEvent.click(item()); }
function drag(dx = 80, dy = 30) {
  // Offset pointer intentionally from the object's center; preserve this offset.
  fireEvent.pointerDown(item(), { pointerId: 1, clientX: 199, clientY: 200, button: 0 });
  fireEvent.pointerMove(item(), { pointerId: 1, clientX: 199 + dx, clientY: 200 + dy });
  fireEvent.pointerUp(item(), { pointerId: 1, clientX: 199 + dx, clientY: 200 + dy });
}
it('does not move in browsing mode or before selecting an object', () => {
  render(<Harness />); drag();
  fireEvent.click(screen.getByRole('button', { name: '布置场景' })); drag();
  expect(api.living.action).not.toHaveBeenCalled();
});
it('previews only while dragging and saves a single normalized move preserving pointer offset', async () => {
  render(<Harness />); begin();
  fireEvent.pointerDown(item(), { pointerId: 1, clientX: 199, clientY: 200, button: 0 });
  fireEvent.pointerMove(item(), { pointerId: 1, clientX: 279, clientY: 230 });
  expect(api.living.action).not.toHaveBeenCalled();
  expect(screen.getByRole('status')).toHaveTextContent('松手保存位置');
  fireEvent.pointerUp(item(), { pointerId: 1, clientX: 279, clientY: 230 });
  fireEvent.pointerUp(item(), { pointerId: 1, clientX: 279, clientY: 230 });
  await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('位置已保存'));
  expect(api.living.action).toHaveBeenCalledTimes(1);
  expect(api.living.action).toHaveBeenCalledWith('one', expect.any(String), 1, { action: 'move', item_id: 'tree-1', x: 0.5, y: 0.5 });
  expect(screen.getByRole('button', { name: '撤销一步' })).toBeEnabled();
});
it('rejects an outside drop without clamping or writing', () => {
  render(<Harness />); begin(); drag(500, 0);
  expect(screen.getByRole('alert')).toHaveTextContent('保留原来的位置');
  expect(api.living.action).not.toHaveBeenCalled();
});
it.each(['pointerCancel', 'lostPointerCapture', 'escape', 'resize'])('cancels %s without persisting', (event) => {
  render(<Harness />); begin();
  fireEvent.pointerDown(item(), { clientX: 199, clientY: 200, button: 0 });
  fireEvent.pointerMove(item(), { clientX: 279, clientY: 230 });
  if (event === 'escape') fireEvent.keyDown(window, { key: 'Escape' });
  else if (event === 'resize') fireEvent(window, new Event('resize'));
  else if (event === 'pointerCancel') fireEvent.pointerCancel(item());
  else fireEvent.lostPointerCapture(item());
  fireEvent.pointerUp(item(), { clientX: 279, clientY: 230 });
  expect(api.living.action).not.toHaveBeenCalled();
  expect(screen.getByRole('status')).toBeEmptyDOMElement();
});
it('does not submit taps or a drag ending at the original location', () => {
  render(<Harness />); begin(); drag(2, 1); drag(0, 0);
  expect(api.living.action).not.toHaveBeenCalled();
});
it('moves with accessible direction buttons and the latest revision', async () => {
  render(<Harness />); begin(); fireEvent.click(screen.getByRole('button', { name: '向右移动' }));
  await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('位置已保存'));
  fireEvent.click(screen.getByRole('button', { name: '向下移动' }));
  await waitFor(() => expect(api.living.action).toHaveBeenCalledTimes(2));
  expect(api.living.action).toHaveBeenLastCalledWith('one', expect.any(String), 2, { action: 'move', item_id: 'tree-1', x: 0.35, y: 0.45 });
});
it('locks after an uncertain write until a read succeeds without replaying the move', async () => {
  vi.mocked(api.living.action).mockRejectedValueOnce(new Error('断线'));
  vi.mocked(api.living.space).mockRejectedValueOnce(new Error('断线'));
  render(<Harness />); begin(); drag();
  const recover = await screen.findByRole('button', { name: '核对场景' });
  expect(screen.getByRole('button', { name: '向右移动' })).toBeDisabled();
  fireEvent.click(recover);
  await waitFor(() => expect(screen.queryByRole('button', { name: '核对场景' })).not.toBeInTheDocument());
  expect(api.living.action).toHaveBeenCalledTimes(1);
});
it('ignores a completed write after switching spaces', async () => {
  let resolve!: (s: LivingSpace) => void;
  vi.mocked(api.living.action).mockReturnValue(new Promise(r => { resolve = r; }));
  const change = vi.fn(); const { rerender } = render(<LivingScene space={space} onChange={change} />);
  begin(); drag();
  rerender(<LivingScene space={{ ...space, id: 'two' }} onChange={change} />);
  await act(async () => resolve({ ...space, revision: 2 }));
  expect(change).not.toHaveBeenCalled();
  expect(screen.getByRole('button', { name: '布置场景' })).toHaveAttribute('aria-pressed', 'false');
});
it('rejects an in-flight gesture when a newer revision arrives', () => {
  const change = vi.fn(); const { rerender } = render(<LivingScene space={space} onChange={change} />); begin();
  fireEvent.pointerDown(item(), { clientX: 199, clientY: 200, button: 0 });
  rerender(<LivingScene space={{ ...space, revision: 3 }} onChange={change} />);
  fireEvent.pointerUp(item(), { clientX: 279, clientY: 230 });
  expect(api.living.action).not.toHaveBeenCalled();
});

it('uses the same normalized displacement on a narrower board', async () => {
  vi.mocked(HTMLElement.prototype.getBoundingClientRect).mockReturnValue({ x: 10, y: 20, left: 10, top: 20, right: 314, bottom: 416, width: 304, height: 396, toJSON() {} });
  render(<Harness />); begin(); drag(40, 30);
  await waitFor(() => expect(api.living.action).toHaveBeenCalledWith('one', expect.any(String), 1, { action: 'move', item_id: 'tree-1', x: 0.5, y: 0.5 }));
});

it('keeps layout stable when beginning another drag after an invalid drop', async () => {
  render(<Harness />); begin(); drag(500, 0);
  fireEvent.pointerDown(item(), { clientX: 199, clientY: 200, button: 0 });
  expect(screen.getByRole('alert')).toHaveTextContent('保留原来的位置');
  fireEvent.pointerMove(item(), { clientX: 279, clientY: 230 });
  fireEvent.pointerUp(item(), { clientX: 279, clientY: 230 });
  await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('位置已保存'));
  expect(screen.queryByRole('alert')).not.toBeInTheDocument();
});

it('lets users select an overlapped item by name without precise tapping', async () => {
  render(<Harness />);
  fireEvent.click(screen.getByRole('button', { name: '布置场景' }));
  fireEvent.change(screen.getByRole('combobox', { name: '选择物件' }), { target: { value: 'tree-1' } });
  expect(item()).toHaveAttribute('aria-pressed', 'true');
  fireEvent.click(screen.getByRole('button', { name: '向右移动' }));
  await waitFor(() => expect(api.living.action).toHaveBeenCalledTimes(1));
});
it('shows the effective care period, then refreshes expiration without losing selection', async () => {
  vi.mocked(api.living.action).mockResolvedValueOnce({ ...space, revision: 2, items: [{ ...space.items[0], growth_status: 'growing', care_remaining_seconds: 86400 }] });
  render(<Harness />); fireEvent.click(item()); fireEvent.click(screen.getByRole('button', { name: '照料' }));
  await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('照料已保存'));
  // Care keeps this tree selected so the saved result is visible immediately.
  expect(within(screen.getByRole('region', { name: '小树成长详情' })).getByText('照料有效 · 剩约 24 小时')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: '照料' })).toBeDisabled();
  fireEvent.click(screen.getByRole('button', { name: '刷新状态' }));
  await waitFor(() => expect(screen.getByText('等你来照料')).toBeInTheDocument());
  expect(screen.getByRole('button', { name: '照料' })).toBeEnabled();
});
it('explains that a stored plant pauses growth', () => {
  render(<LivingScene space={{ ...space, items: [{ ...space.items[0], stored: true, growth_status: 'stored' }] }} onChange={vi.fn()} />);
  expect(screen.getByText('已收纳 · 暂停成长')).toBeInTheDocument();
});
