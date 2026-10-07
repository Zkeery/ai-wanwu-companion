import React, { useState } from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
// Journal has its own request/lifecycle suite; these tests isolate drag/atmosphere.
vi.mock('@/components/life-journal', () => ({ default: () => null }));
vi.mock('@/lib/activities', () => ({ activities: { inSpace: vi.fn().mockResolvedValue([]) }, decorationNames: {} }));
import LivingScene from '@/components/living-scene';
import { api } from '@/lib/api';
import { type LivingSpace, parseScene } from '@/lib/contracts';
const audio = vi.hoisted(() => ({ enable: vi.fn(), volume: vi.fn(), close: vi.fn() }));
vi.mock('@/lib/rain-audio', () => ({ RainAudio: class { enable = audio.enable; volume = audio.volume; close = audio.close; } }));
vi.mock('@/lib/seasons', async original => ({ ...await original<typeof import('@/lib/seasons')>(), seasonApi: { read: vi.fn().mockResolvedValue({ settings: null, current_season: null, revision: 0, started_at: null, next_change_at: null, observed_at: 1, timezone: 'Asia/Shanghai' }) } }));
vi.mock('@/lib/api', async original => ({ ...await original<typeof import('@/lib/api')>(), api: { living: { action: vi.fn(), space: vi.fn() } } }));
const space: LivingSpace = { id: 'home', scene_type: 'home', mode: 'private', companion_id: '1', revision: 3, observed_at: 1, can_undo: false, items: [], atmosphere: { rain: true, sound: true } };
beforeEach(() => { vi.clearAllMocks(); audio.enable.mockResolvedValue(undefined); });
function Harness() { const [s,set] = useState(space); return <LivingScene space={s} onChange={set} />; }
it('requires a gesture to play rain and stops when unmounted', async () => {
  const r = render(<Harness />);
  expect(audio.enable).not.toHaveBeenCalled();
  expect(audio.volume).toHaveBeenLastCalledWith(false);
  fireEvent.click(screen.getByText('开启声音'));
  await waitFor(() => expect(audio.volume).toHaveBeenLastCalledWith(true));
  r.unmount(); expect(audio.close).toHaveBeenCalledOnce();
});
it('persists quiet in the same revision and silences enabled local audio', async () => {
  vi.mocked(api.living.action).mockResolvedValue({ ...space, revision: 4, atmosphere: { rain: true, sound: false } });
  render(<Harness />);
  fireEvent.click(screen.getByText('开启声音'));
  await waitFor(() => expect(audio.volume).toHaveBeenLastCalledWith(true));
  fireEvent.click(screen.getByText('安静一会'));
  await waitFor(() => expect(audio.volume).toHaveBeenLastCalledWith(false));
  expect(api.living.action).toHaveBeenCalledWith('home', expect.any(String), 3, { action: 'atmosphere', weather: 'quiet' });
});
it('hides courtyard atmosphere tools outside home and does not reuse audio across spaces', async () => {
  const r=render(<LivingScene space={space} onChange={vi.fn()} />);
  fireEvent.click(screen.getByText('开启声音'));
  await waitFor(() => expect(audio.volume).toHaveBeenLastCalledWith(true));
  r.rerender(<LivingScene space={{ ...space, id: 'desert', scene_type: 'desert' }} onChange={vi.fn()} />);
  expect(screen.queryByText('开启声音')).toBeNull();
  expect(screen.queryByText('安静一会')).toBeNull();
  expect(audio.close).toHaveBeenCalledOnce();
});
it('exposes audio failure without changing saved atmosphere', async () => {
  audio.enable.mockRejectedValue(new Error('声音未能开启'));
  render(<Harness />); fireEvent.click(screen.getByText('开启声音'));
  await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('声音未能开启'));
  expect(api.living.action).not.toHaveBeenCalled();
});
it('preserves the canonical living snapshot through the legacy scene contract', () => {
  const result=parseScene({ scene_name: '家庭庭院', elements: { rain: 1, tree: 0, cloud: 1, sound: 1 }, can_undo: false, proposal: null, feedback: null, living: space });
  expect(result.living).toEqual(space);
});
it('places a new object in an open slot without moving existing saved objects', async () => {
  const s: LivingSpace = { ...space, items: [{ id: 'existing', kind: 'tree', x: .05, y: .15, stored: false, growth_seconds: 0, stage: 'planted', care_remaining_seconds: 0, growth_status: 'needs_care' }] };
  vi.mocked(api.living.action).mockResolvedValue(s);
  render(<LivingScene space={s} onChange={vi.fn()} />);
  fireEvent.click(screen.getByRole('button', { name: '布置场景' }));
  fireEvent.click(screen.getByRole('button', { name: /长椅/ }));
  await waitFor(() => expect(api.living.action).toHaveBeenCalledWith('home', expect.any(String), 3, { action: 'place', kind: 'bench', x: .5, y: .15 }));
});
