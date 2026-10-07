import React from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import GatheringWorld from '@/components/gathering-world';
import { parseGathering } from '@/lib/gatherings';
import { AUTH_CHANGED, TOKEN_KEY } from '@/lib/auth';

vi.mock('@/components/private-image', () => ({ default: ({ alt }: { alt: string }) => <span role="img" aria-label={alt} /> }));
vi.mock('@/components/motion-player', () => ({ default: ({ name, activity }: { name: string; activity: string }) => <span data-testid="playing">{name}:{activity}</span> }));
function snapshot(activity = 'rest') {
  return parseGathering({ id: '11111111-1111-4111-8111-111111111111', title: '共同住处', scene_type: 'home', revision: 1,
    closed: false, is_manager: true, me: 'owner', invitation: null, members: [{ id: 'owner', name: '我', manager: true }],
    companions: [{ id: 1, name: '苹果', owner_id: 'owner', activity, x: .3, y: .5 },
      { id: 2, name: '杯子', owner_id: 'other', activity: 'walk', x: .6, y: .5 }],
    items: [], votes: [], events: [], stories: [], goal: null, story_enabled: false, season: { current_season: null } });
}
let reduced = false;
beforeEach(() => {
  reduced = false; localStorage.setItem(TOKEN_KEY, 'synthetic-member');
  vi.stubGlobal('matchMedia', () => ({ matches: reduced, addEventListener: vi.fn(), removeEventListener: vi.fn() }));
  Object.defineProperty(document, 'hidden', { configurable: true, value: false });
});
afterEach(() => { localStorage.clear(); vi.unstubAllGlobals(); Reflect.deleteProperty(document, 'hidden'); });

it('plays only the selected current activity, pauses and resets for a new activity', () => {
  const select = vi.fn();
  const { rerender } = render(<GatheringWorld gathering={snapshot()} focusedId={null} onSelect={select} />);
  expect(screen.queryByTestId('playing')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: '查看苹果的生活近况' }));
  expect(select).toHaveBeenCalledWith(1);
  rerender(<GatheringWorld gathering={snapshot()} focusedId={1} onSelect={select} />);
  expect(screen.getByTestId('playing')).toHaveTextContent('苹果:rest');
  fireEvent.click(screen.getByRole('button', { name: '暂停画面' }));
  expect(screen.queryByTestId('playing')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: '继续画面' }));
  expect(screen.getByTestId('playing')).toHaveTextContent('苹果:rest');
  rerender(<GatheringWorld gathering={snapshot('observe')} focusedId={1} onSelect={select} />);
  expect(screen.getByTestId('playing')).toHaveTextContent('苹果:observe');
  rerender(<GatheringWorld gathering={snapshot('talk')} focusedId={1} onSelect={select} />);
  expect(screen.queryByTestId('playing')).toBeNull();
  rerender(<GatheringWorld gathering={snapshot()} focusedId={2} onSelect={select} />);
  expect(screen.getAllByTestId('playing')).toHaveLength(1);
  expect(screen.getByTestId('playing')).toHaveTextContent('杯子:walk');
});

it('unmounts playback on stale state, recall, hiding, reduced motion and logout', () => {
  const g = snapshot(), select = vi.fn();
  const { rerender } = render(<GatheringWorld gathering={g} focusedId={1} onSelect={select} />);
  expect(screen.getByTestId('playing')).toBeInTheDocument();
  rerender(<GatheringWorld gathering={g} focusedId={1} onSelect={select} suspended />);
  expect(screen.queryByTestId('playing')).toBeNull();
  rerender(<GatheringWorld gathering={g} focusedId={1} onSelect={select} />);
  act(() => { Object.defineProperty(document, 'hidden', { configurable: true, value: true }); document.dispatchEvent(new Event('visibilitychange')); });
  expect(screen.queryByTestId('playing')).toBeNull();
  act(() => { Object.defineProperty(document, 'hidden', { configurable: true, value: false }); document.dispatchEvent(new Event('visibilitychange')); });
  expect(screen.getByTestId('playing')).toBeInTheDocument();
  act(() => { reduced = true; window.dispatchEvent(new Event(AUTH_CHANGED)); });
  expect(screen.queryByTestId('playing')).toBeNull();
  act(() => { reduced = false; window.dispatchEvent(new Event(AUTH_CHANGED)); });
  rerender(<GatheringWorld gathering={{ ...g, companions: [] }} focusedId={1} onSelect={select} />);
  expect(screen.queryByTestId('playing')).toBeNull();
  rerender(<GatheringWorld gathering={g} focusedId={1} onSelect={select} />);
  act(() => { localStorage.removeItem(TOKEN_KEY); window.dispatchEvent(new Event(AUTH_CHANGED)); });
  expect(screen.queryByTestId('playing')).toBeNull();
});
