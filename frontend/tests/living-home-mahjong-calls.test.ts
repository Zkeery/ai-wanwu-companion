import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHomeMahjongCalls, HOME_MAHJONG_CALLS_ORIGIN, HOME_MAHJONG_CALL_TEXTS, type HomeMahjongCallStep } from '@/lib/living-home-mahjong-calls';
import { sampleHomeAmbience } from '@/lib/living-home-ambience';

function cueTimes(actorId = 4, odd = true, horizon = 30) {
  const result = new Map<number, number>();
  for (let time = 0; time < horizon; time += .01) { const cue = sampleHomeAmbience('mahjong', time, actorId).audio; if (cue?.kind === 'tile' && cue.episode % 2 === (odd ? 1 : 0)) result.set(cue.episode, cue.startedAt); }
  return [...result.values()].sort((a, b) => a - b);
}
const assignment = (actorId = 4, startedAtElapsed = 0) => ({ actorId, activity: 'mahjong', startedAtElapsed });
function frame(elapsed: number, changes: Partial<HomeMahjongCallStep> = {}): HomeMahjongCallStep { return { elapsed, moving: true, enabled: true, assignments: [assignment()], audibleIds: [4], ...changes }; }
function seededRandom(seed: number) {
  let state = seed >>> 0;
  return () => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state / 0x100000000; };
}
function sequence(calls: ReturnType<typeof createHomeMahjongCalls>, count: number) {
  const times = cueTimes(4, true, count * 7).slice(0, count); expect(times).toHaveLength(count);
  const results: NonNullable<ReturnType<typeof calls.step>>[] = []; let last = times[0] - .05; calls.step(frame(last));
  for (const time of times) { while (last + .5 < time - .05) { last += .5; calls.step(frame(last)); } calls.step(frame(time - .05)); const result = calls.step(frame(time + .01)); expect(result).not.toBeNull(); results.push(result!); last = time + .01; }
  return results;
}
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('local animation example mahjong tile calls', () => {
  it('baselines first, paused and disabled frames without replaying the same placement when resumed', () => {
    const time = cueTimes()[0], first = createHomeMahjongCalls(); expect(first.step(frame(time + .01))).toBeNull(); expect(first.step(frame(time + .05))).toBeNull();
    for (const changes of [{ moving: false }, { enabled: false }]) { const calls = createHomeMahjongCalls(); calls.step(frame(time - .05)); expect(calls.step(frame(time + .01, changes))).toBeNull(); expect(calls.step(frame(time + .05))).toBeNull(); }
  });

  it('calls only a fresh odd tile episode for placement, never the even draw episode or a late cue', () => {
    const draw = cueTimes(4, false)[0], place = cueTimes()[0], calls = createHomeMahjongCalls(); calls.step(frame(draw - .05)); expect(calls.step(frame(draw + .01))).toBeNull();
    const fresh = createHomeMahjongCalls(); fresh.step(frame(place - .05)); expect(fresh.step(frame(place + .01))).toMatchObject({ actorId: 4 });
    const late = createHomeMahjongCalls(); late.step(frame(place - .05)); expect(late.step(frame(place + .13))).toBeNull();
    expect(sampleHomeAmbience('mahjong', place + .01, 4).audio).toMatchObject({ kind: 'tile', episode: 1 });
  });

  it('uses assignment-relative elapsed and includes actor, assignment start and episode in each key', () => {
    const relative = cueTimes()[0], calls = createHomeMahjongCalls(), started = 100, actors = [assignment(4, started)];
    calls.step(frame(started + relative - .05, { assignments: actors })); const first = calls.step(frame(started + relative + .01, { assignments: actors })); expect(first?.key).toBe('local-mahjong-example:4:100:1');
    const next = [assignment(4, 200)]; calls.step(frame(200 + relative - .05, { assignments: next })); const second = calls.step(frame(200 + relative + .01, { assignments: next })); expect(second?.key).toBe('local-mahjong-example:4:200:1'); expect(second?.key).not.toBe(first?.key);
  });

  it('filters to audible mahjong actors, consumes inaudible episodes and returns at most one deterministic actor', () => {
    const assignments = [6, 4, 5].map(id => assignment(id, 10 - cueTimes(id)[0])), calls = createHomeMahjongCalls();
    calls.step(frame(9.95, { assignments, audibleIds: [5] })); expect(calls.step(frame(10.01, { assignments, audibleIds: new Set([5]) }))).toMatchObject({ actorId: 5 }); expect(calls.step(frame(10.06, { assignments, audibleIds: [4, 5, 6] }))).toBeNull();
    const stable = createHomeMahjongCalls(); stable.step(frame(9.95, { assignments, audibleIds: [4, 5, 6] })); expect(stable.step(frame(10.01, { assignments, audibleIds: [6, 5, 4] }))).toMatchObject({ actorId: 4 });
    const invalid = createHomeMahjongCalls(), time = cueTimes()[0]; const rows = [{ ...assignment(), activity: 'television' }, assignment(-1), assignment(0), assignment(4, NaN), assignment(5, time + 1)]; invalid.step(frame(time - .05, { assignments: rows })); expect(invalid.step(frame(time + .01, { assignments: rows, audibleIds: [4, 5] }))).toBeNull();
  });

  it('shares a two second cooldown across all actors and drops suppressed calls without queueing them', () => {
    const assignments = [assignment(4, 10 - cueTimes(4)[0]), assignment(5, 11 - cueTimes(5)[0]), assignment(6, 12.01 - cueTimes(6)[0])], calls = createHomeMahjongCalls();
    const at = (time: number) => calls.step(frame(time, { assignments, audibleIds: [4, 5, 6] })); at(9.95); expect(at(10.01)).toMatchObject({ actorId: 4 }); at(10.5); at(10.95); expect(at(11.01)).toBeNull(); expect(at(11.08)).toBeNull(); at(11.5); at(11.95); expect(at(12.02)).toMatchObject({ actorId: 6 });
  });

  it('deduplicates each placement and draws without replacement within the complete declared tile whitelist', () => {
    const calls = createHomeMahjongCalls({ random: seededRandom(4) }), times = cueTimes().slice(0, 3), results = []; let last = times[0] - .05; calls.step(frame(last));
    for (const time of times) { while (last + .5 < time - .05) { last += .5; calls.step(frame(last)); } calls.step(frame(time - .05)); const result = calls.step(frame(time + .01)); results.push(result); expect(result).not.toBeNull(); expect(calls.step(frame(time + .01))).toBeNull(); expect(calls.step(frame(time + .07))).toBeNull(); last = time + .07; }
    expect(new Set(results.map(row => row?.key)).size).toBe(3); expect(new Set(results.map(row => row?.text)).size).toBe(3); for (const row of results) expect(HOME_MAHJONG_CALL_TEXTS).toContain(row?.text);
    expect(HOME_MAHJONG_CALL_TEXTS).toEqual([
      '一万', '二万', '三万', '四万', '五万', '六万', '七万', '八万', '九万',
      '一筒', '二筒', '三筒', '四筒', '五筒', '六筒', '七筒', '八筒', '九筒',
      '一条', '二条', '三条', '四条', '五条', '六条', '七条', '八条', '九条',
      '东风', '南风', '西风', '北风', '红中', '发财', '白板',
    ]); expect(HOME_MAHJONG_CALLS_ORIGIN).toBe('local_animation_example');
  });

  it('covers every tile once in each shuffled 34-tile bag with reproducible seeded order and a different order for another seed', () => {
    const first = sequence(createHomeMahjongCalls({ random: seededRandom(4) }), 68), repeated = sequence(createHomeMahjongCalls({ random: seededRandom(4) }), 68), other = sequence(createHomeMahjongCalls({ random: seededRandom(17) }), 68);
    expect(repeated).toEqual(first); expect(other.map(row => row.text)).not.toEqual(first.map(row => row.text));
    for (const rows of [first, other]) for (const bag of [rows.slice(0, 34), rows.slice(34, 68)]) {
      expect(new Set(bag.map(row => row.text))).toEqual(new Set(HOME_MAHJONG_CALL_TEXTS)); expect(new Set(bag.map(row => row.text)).size).toBe(34);
      const names = bag.map(row => row.text), start = HOME_MAHJONG_CALL_TEXTS.indexOf(names[0] as typeof HOME_MAHJONG_CALL_TEXTS[number]);
      expect(names).not.toEqual(HOME_MAHJONG_CALL_TEXTS); expect(names.every((text, index) => text === HOME_MAHJONG_CALL_TEXTS[(start + index) % 34])).toBe(false);
    }
    expect(first[33].text).not.toBe(first[34].text); expect(other[33].text).not.toBe(other[34].text);
    expect(new Set(first.map(row => row.key)).size).toBe(68); expect(HOME_MAHJONG_CALL_TEXTS).toHaveLength(34); expect(Object.isFrozen(HOME_MAHJONG_CALL_TEXTS)).toBe(true);
    expect(first.every(row => !['碰', '杠', '胡', '杠上花'].includes(row.text))).toBe(true);
  });

  it('prevents an adjacent repeat at a bag boundary even when the same random stream would reshuffle identically', () => {
    const rows = sequence(createHomeMahjongCalls({ random: () => .999999 }), 68);
    expect(new Set(rows.slice(0, 34).map(row => row.text))).toEqual(new Set(HOME_MAHJONG_CALL_TEXTS)); expect(new Set(rows.slice(34).map(row => row.text))).toEqual(new Set(HOME_MAHJONG_CALL_TEXTS)); expect(rows[33].text).not.toBe(rows[34].text);
  });

  it('does not invoke randomness for baseline, paused, disabled, inaudible, even, late, duplicate or cooldown-suppressed events', () => {
    const place = cueTimes()[0], draw = cueTimes(4, false)[0];
    for (const [before, time, changes] of [
      [null, place + .01, {}], [place - .05, place + .01, { moving: false }], [place - .05, place + .01, { enabled: false }], [place - .05, place + .01, { audibleIds: [] }],
      [draw - .05, draw + .01, {}], [place - .05, place + .13, {}], [0, place + .01, {}], [place - .05, place + .01, { assignments: [] }],
    ] as Array<[number | null, number, Partial<HomeMahjongCallStep>]>) {
      const random = vi.fn(seededRandom(4)), calls = createHomeMahjongCalls({ random }); if (before !== null) calls.step(frame(before)); expect(calls.step(frame(time, changes))).toBeNull(); expect(random).not.toHaveBeenCalled();
    }
    function withCooldownPeer(includePeer: boolean) {
      const random = vi.fn(seededRandom(4)), calls = createHomeMahjongCalls({ random }), assignments = [assignment(4, 10 - cueTimes(4)[0]), ...(includePeer ? [assignment(5, 11 - cueTimes(5)[0])] : []), assignment(6, 12.01 - cueTimes(6)[0])];
      const at = (time: number) => calls.step(frame(time, { assignments, audibleIds: [4, 5, 6] })); at(9.95); const first = at(10.01); const randomCalls = random.mock.calls.length; expect(at(10.01)).toBeNull(); at(10.5); at(10.95); expect(at(11.01)).toBeNull(); expect(at(11.08)).toBeNull(); expect(random).toHaveBeenCalledTimes(randomCalls); at(11.5); at(11.95); const second = at(12.02); expect(first).not.toBeNull(); expect(second).not.toBeNull(); return [first!.text, second!.text];
    }
    expect(withCooldownPeer(true)).toEqual(withCooldownPeer(false));
  });

  it('clears the bag and prior tile on reset without shuffling until a fresh valid placement is returned', () => {
    const random = vi.fn(seededRandom(4)), calls = createHomeMahjongCalls({ random }), first = sequence(calls, 1)[0], oldCount = random.mock.calls.length; expect(oldCount).toBeGreaterThan(0);
    calls.reset(); expect(random).toHaveBeenCalledTimes(oldCount); random.mockImplementation(seededRandom(4)); const time = cueTimes()[0]; calls.step(frame(time - .05)); expect(random).toHaveBeenCalledTimes(oldCount); expect(calls.step(frame(time + .01))).toEqual(first); expect(random.mock.calls.length).toBeGreaterThan(oldCount);
  });

  it('rebases clock jumps, rewinds and invalid time instead of catching up a currently active tile cue', () => {
    const time = cueTimes()[0], calls = createHomeMahjongCalls(); calls.step(frame(0)); expect(calls.step(frame(time + .01))).toBeNull(); expect(calls.step(frame(time + .05))).toBeNull(); expect(calls.step(frame(-1))).toBeNull(); expect(calls.step(frame(time + .06))).toBeNull(); expect(calls.step(frame(NaN))).toBeNull(); expect(calls.step(frame(time + .07))).toBeNull();
    const rewind = createHomeMahjongCalls(); rewind.step(frame(time + .1)); expect(rewind.step(frame(time + .01))).toBeNull(); expect(rewind.step(frame(time + .05))).toBeNull();
  });

  it('resets explicitly, disposes permanently and performs no network, clock, global random or timer work when randomness is injected', () => {
    const time = cueTimes()[0], forbidden = vi.fn(() => { throw new Error('pure local calls only'); }); vi.stubGlobal('fetch', forbidden); vi.stubGlobal('setTimeout', forbidden); vi.stubGlobal('setInterval', forbidden); vi.spyOn(Date, 'now').mockImplementation(forbidden); vi.spyOn(Math, 'random').mockImplementation(forbidden);
    const calls = createHomeMahjongCalls({ random: () => .5 }); calls.step(frame(time - .05)); const first = calls.step(frame(time + .01)); expect(first).not.toBeNull(); calls.reset(); calls.step(frame(time - .05)); expect(calls.step(frame(time + .01))).toEqual(first); calls.dispose(); calls.dispose(); calls.reset(); expect(calls.step(frame(time - .05))).toBeNull(); expect(calls.step(frame(time + .01))).toBeNull(); expect(forbidden).not.toHaveBeenCalled();
  });
});
