import React from 'react';
import { act, fireEvent, render, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import SharedLivingWorld3D from '@/components/shared-living-world-3d';
import { parseGathering, type Gathering } from '@/lib/gatherings';
import { createLivingBubbleClock, livingBubble } from '@/lib/living-world-bubbles';

const gpu = vi.hoisted(() => ({ instances: [] as Array<{ setAnimationLoop: ReturnType<typeof vi.fn> }> }));
// The real React effects, engine, shared-line selection and label DOM run together.
// Only WebGL is replaced; no model, HTTP or browser automation is used.
vi.mock('three', async original => {
  const actual = await original<typeof import('three')>();
  class OfflineRenderer {
    domElement = document.createElement('canvas');
    shadowMap = { enabled: false, type: 0 };
    outputColorSpace = ''; toneMapping = 0; toneMappingExposure = 1;
    setPixelRatio = vi.fn(); setSize = vi.fn(); setClearColor = vi.fn();
    setAnimationLoop = vi.fn(); render = vi.fn(); dispose = vi.fn(); forceContextLoss = vi.fn();
    constructor() { gpu.instances.push(this); }
  }
  return { ...actual, WebGLRenderer: OfflineRenderer };
});

function initial(me = 'owner'): Gathering {
  return parseGathering({ id: 'receive-clock', title: '合成共同住处', scene_type: 'home', revision: 1,
    closed: false, is_manager: me === 'owner', me, invitation: null,
    members: [{ id: 'owner', name: '我', manager: true }, { id: 'friend', name: '朋友', manager: false }],
    companions: [4, 5].map(id => ({ id, name: id === 4 ? '杯子' : '花束', owner_id: id === 4 ? 'owner' : 'friend',
      activity: 'talk', area: 'outdoor', x: id === 4 ? .4 : .6, y: .5,
      avatar3d: { version: 1, kind: id === 4 ? 'cup' : 'bouquet', body: '#6da385', accent: '#f3dfbb',
        detail: '#364d44', seed: id, source: 'procedural_existing_features' } })),
    items: [], votes: [], events: [], stories: [], goal: null, story_enabled: false, season: { current_season: null } });
}
const exchange: Gathering['events'][number] = { id: 'new-exchange', message: '合成已发布对话', at: 100,
  kind: 'dialogue', activity: null, characters: [4, 5], origin: 'real_provider', area: 'outdoor',
  lines: [{ character_id: 4, name: '杯子', text: '这儿的风很舒服。' },
    { character_id: 5, name: '花束', text: '是啊，陪你在这里坐一会儿。' }] };
const published = (me = 'owner'): Gathering => ({ ...initial(me), revision: 2, events: [exchange] });
const seconds = () => Date.now() / 1000;

beforeEach(() => {
  vi.useFakeTimers(); vi.setSystemTime(100_000); gpu.instances.length = 0;
  vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new Error('unexpected network request'))));
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(800);
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(500);
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('independent page-local receipt clocks', () => {
  it('starts both full lines when B first receives the event 15 seconds after A', () => {
    const a = createLivingBubbleClock(initial()), b = createLivingBubbleClock(initial('friend'));
    const ag = published(), bg = published('friend'), before = JSON.stringify(ag);
    a.observe(ag, 'outdoor', seconds());
    expect(livingBubble(ag, 4, seconds(), true, null, a.receipts)).toEqual({ kind: 'dialogue', text: exchange.lines![0].text });
    vi.advanceTimersByTime(3500);
    expect(livingBubble(ag, 5, seconds(), true, null, a.receipts)).toEqual({ kind: 'dialogue', text: exchange.lines![1].text });
    vi.advanceTimersByTime(11_500); b.observe(bg, 'outdoor', seconds());
    expect(livingBubble(ag, 4, seconds(), true, null, a.receipts)).toBeNull();
    expect(livingBubble(bg, 4, seconds(), true, null, b.receipts)).toEqual({ kind: 'dialogue', text: exchange.lines![0].text });
    vi.advanceTimersByTime(3500);
    expect(livingBubble(bg, 4, seconds(), true, null, b.receipts)).toBeNull();
    expect(livingBubble(bg, 5, seconds(), true, null, b.receipts)).toEqual({ kind: 'dialogue', text: exchange.lines![1].text });
    vi.advanceTimersByTime(3500);
    for (const id of [4, 5]) expect(livingBubble(bg, id, seconds(), true, null, b.receipts)).toBeNull();
    expect(JSON.stringify(ag)).toBe(before); expect(fetch).not.toHaveBeenCalled();
  });

  it('treats a first snapshot and a refreshed page as history, even when the event is very recent', () => {
    const g = published(), cold = createLivingBubbleClock(g);
    cold.observe(g, 'outdoor', seconds());
    expect(livingBubble(g, 4, seconds(), true, null, cold.receipts)).toBeNull();
    expect(livingBubble(g, 4, seconds(), true, seconds(), cold.receipts)).toEqual({ kind: 'history', text: exchange.lines![0].text });
    vi.advanceTimersByTime(3500);
    expect(livingBubble(g, 5, seconds(), true, 100, cold.receipts)).toEqual({ kind: 'history', text: exchange.lines![1].text });
    expect(createLivingBubbleClock(g).receipts.size).toBe(0);
  });

  it('never restarts a known event on polling, switching rooms or receiving an older snapshot', () => {
    const clock = createLivingBubbleClock(initial()), g = published(); clock.observe(g, 'outdoor', seconds());
    vi.advanceTimersByTime(4000); const polled = { ...g, revision: 3 }; clock.observe(polled, 'indoor', seconds());
    clock.observe(initial(), 'outdoor', seconds()); clock.observe(g, 'outdoor', seconds());
    expect(clock.receipts.get(exchange.id)).toBe(100);
    expect(livingBubble(g, 4, seconds(), true, null, clock.receipts)).toBeNull();
    expect(livingBubble(g, 5, seconds(), true, null, clock.receipts)?.text).toBe(exchange.lines![1].text);
    vi.advanceTimersByTime(4000); clock.observe(g, 'outdoor', seconds());
    expect(livingBubble(g, 4, seconds(), true, null, clock.receipts)).toBeNull();
    expect(livingBubble(g, 5, seconds(), true, null, clock.receipts)).toBeNull();
  });

  it('marks another room as seen without creating a delayed speech receipt when entering it later', () => {
    const clock = createLivingBubbleClock(initial());
    const g = { ...published(), companions: initial().companions.map(c => ({ ...c, area: 'indoor' as const })), events: [{ ...exchange, area: 'indoor' as const }] };
    clock.observe(g, 'outdoor', seconds()); vi.advanceTimersByTime(4000); clock.observe(g, 'indoor', seconds());
    expect(clock.receipts.size).toBe(0);
    expect(livingBubble(g, 4, seconds(), true, null, clock.receipts)).toBeNull();
    expect(livingBubble(g, 4, seconds(), true, seconds(), clock.receipts)?.kind).toBe('history');
  });

  it('keeps later saved activities authoritative when speech and the activity arrive together after a delay', () => {
    const clock = createLivingBubbleClock(initial()); vi.advanceTimersByTime(15_000);
    const g = { ...published(), events: [exchange, { id: 'later-activity', message: '合成后续活动', at: 101,
      kind: 'activity', activity: 'observe', characters: [4], origin: 'offline_rules', area: 'outdoor' as const }] };
    clock.observe(g, 'outdoor', seconds());
    expect(livingBubble(g, 4, seconds(), true, null, clock.receipts)).toBeNull();
    expect(livingBubble(g, 5, seconds(), true, null, clock.receipts)?.text).toBe(exchange.lines![1].text);
  });

  it.each(['account', 'space'])('clears receipts and baselines returned history after changing %s', change => {
    const clock = createLivingBubbleClock(initial()), g = published(); clock.observe(g, 'outdoor', seconds());
    const next = change === 'account' ? { ...g, me: 'friend' } : { ...g, id: 'another-space' };
    clock.observe(next, 'outdoor', seconds()); expect(clock.receipts.size).toBe(0);
    expect(livingBubble(next, 4, seconds(), true, null, clock.receipts)).toBeNull();
  });

  it('does not store content or create speech receipts for non-provider or incomplete records', () => {
    const clock = createLivingBubbleClock(initial()), g = { ...published(), events: [
      { ...exchange, id: 'offline', origin: 'offline_rules' }, { ...exchange, id: 'no-area', area: undefined },
      { ...exchange, id: 'no-lines', lines: undefined }] };
    clock.observe(g, 'outdoor', seconds()); expect([...clock.receipts]).toEqual([]);
    expect(livingBubble(g, 4, seconds(), true, null, clock.receipts)).toBeNull();
  });

  it('does not rewind the receipt clock while animation is paused', () => {
    const clock = createLivingBubbleClock(initial()), g = published(); clock.observe(g, 'outdoor', seconds());
    expect(livingBubble(g, 4, seconds(), false, null, clock.receipts)).toBeNull(); vi.advanceTimersByTime(4000);
    expect(livingBubble(g, 5, seconds(), true, null, clock.receipts)?.text).toBe(exchange.lines![1].text);
    vi.advanceTimersByTime(4000); expect(livingBubble(g, 4, seconds(), true, null, clock.receipts)).toBeNull();
    expect(livingBubble(g, 5, seconds(), true, null, clock.receipts)).toBeNull();
  });

  it('runs independent actual conversations in each visible home region without two speakers in one region', () => {
    const base = initial(), clock = createLivingBubbleClock(base);
    const indoor = { ...exchange, id: 'indoor-exchange', area: 'indoor' as const, characters: [6, 7],
      lines: [{ character_id: 6, name: '客厅甲', text: '坐在沙发上很舒服。' }, { character_id: 7, name: '客厅乙', text: '我们歇一会儿吧。' }] };
    const g = { ...published(), companions: [...base.companions, ...base.companions.map((c, i) => ({ ...c, id: i + 6, area: 'indoor' as const }))], events: [exchange, indoor] };
    vi.advanceTimersByTime(15_000); clock.observe(g, 'all', seconds());
    expect(livingBubble(g, 4, seconds(), true, null, clock.receipts)?.text).toBe(exchange.lines![0].text);
    expect(livingBubble(g, 6, seconds(), true, null, clock.receipts)?.text).toBe(indoor.lines[0].text);
    for (const id of [5, 7]) expect(livingBubble(g, id, seconds(), true, null, clock.receipts)).toBeNull();
    vi.advanceTimersByTime(3500); clock.observe(g, 'all', seconds());
    expect(livingBubble(g, 5, seconds(), true, null, clock.receipts)?.text).toBe(exchange.lines![1].text);
    expect(livingBubble(g, 7, seconds(), true, null, clock.receipts)?.text).toBe(indoor.lines[1].text);
    for (const id of [4, 6]) expect(livingBubble(g, id, seconds(), true, null, clock.receipts)).toBeNull();
    expect([...clock.receipts.values()]).toEqual([115, 115]);
  });
});

function drawFrame() {
  for (const instance of gpu.instances) {
    const callback = instance.setAnimationLoop.mock.lastCall?.[0] as ((time: number) => void) | null | undefined;
    callback?.(Date.now());
  }
}
function advance(ms: number) { act(() => { vi.advanceTimersByTime(ms); drawFrame(); }); }
function speech(container: HTMLElement) {
  return [...container.querySelectorAll<HTMLElement>('.living3d-marker:not([hidden]) .living3d-bubble:not([hidden])')].map(e => e.textContent);
}
function scene(g: Gathering, room = false, animate = true) {
  return <SharedLivingWorld3D gathering={g} focusedId={null} onSelect={vi.fn()} animate={animate} room={room} />;
}

describe('real React snapshot delivery to engine speech DOM', () => {
  it('renders one actual line at a time for two clients even when B receives the update 15 seconds late', () => {
    const a = render(scene(initial())), b = render(scene(initial('friend')));
    const ag = published(), bg = published('friend'), before = JSON.stringify([ag, bg]);
    a.rerender(scene(ag)); expect(speech(a.container)).toEqual([exchange.lines![0].text]); expect(speech(b.container)).toEqual([]);
    advance(3500); expect(speech(a.container)).toEqual([exchange.lines![1].text]);
    advance(11_500); b.rerender(scene(bg));
    expect(speech(a.container)).toEqual([]); expect(speech(b.container)).toEqual([exchange.lines![0].text]);
    expect(b.container.querySelector('.living3d-bubble small')).toBeNull();
    advance(3500); expect(speech(b.container)).toEqual([exchange.lines![1].text]);
    b.rerender(scene({ ...bg })); expect(speech(b.container)).toEqual([exchange.lines![1].text]);
    advance(3500); expect(speech(b.container)).toEqual([]);
    expect(JSON.stringify([ag, bg])).toBe(before); expect(fetch).not.toHaveBeenCalled();
  });

  it('preserves delivery times through a room switch and WebGL rebuild, then only replays history on an explicit click', () => {
    const view = render(scene(initial())), g = published(); view.rerender(scene(g)); advance(2000);
    view.rerender(scene({ ...g, companions: [], items: [] }, true)); expect(speech(view.container)).toEqual([]);
    advance(2000); view.rerender(scene(g)); expect(speech(view.container)).toEqual([exchange.lines![1].text]);
    act(() => view.container.querySelector('[data-testid="living3d-canvas"]')!.dispatchEvent(new CustomEvent('living3d-lost')));
    fireEvent.click(within(view.container).getByRole('button', { name: '重新打开立体画面' }));
    expect(speech(view.container)).toEqual([exchange.lines![1].text]); advance(4000); expect(speech(view.container)).toEqual([]);
    view.unmount(); const refreshed = render(scene(g)); expect(speech(refreshed.container)).toEqual([]);
    fireEvent.click(within(refreshed.container).getByRole('button', { name: '回看最近交流' }));
    expect(speech(refreshed.container)).toEqual([exchange.lines![0].text]);
    advance(3500); expect(speech(refreshed.container)).toEqual([exchange.lines![1].text]);
    fireEvent.click(within(refreshed.container).getByRole('button', { name: '暂停画面' })); expect(speech(refreshed.container)).toEqual([]);
    advance(4000); fireEvent.click(within(refreshed.container).getByRole('button', { name: '继续画面' })); expect(speech(refreshed.container)).toEqual([]);
    expect(fetch).not.toHaveBeenCalled();
  });
});
