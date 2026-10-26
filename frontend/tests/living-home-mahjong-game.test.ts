import { describe, expect, it, vi } from 'vitest';
import { createHomeMahjongGame, HOME_MAHJONG_GAME_TILES as T, isHomeMahjongWinningHand,
  type HomeMahjongGameEvent, type HomeMahjongGamePreset, type HomeMahjongGameSnapshot } from '../lib/living-home-mahjong-game';
const actors = [1, 2, 3, 4].map(actorId => ({ actorId, seatId: 'seat-' + actorId }));
const offsets: Readonly<Record<string, number>> = { m: 0, p: 9, s: 18, z: 27 };
const tiles = (codes: string) => codes.split(/\s+/).filter(Boolean).map(code => T[(offsets[code[0]] ?? -100) + Number(code.slice(1)) - 1]);
function seeded(seed: number) { let state = seed >>> 0; return () => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state / 0x100000000; }; }
function preset(hints: readonly (readonly string[])[], first: readonly string[] = [], turn = 0, tail: readonly string[] = []): HomeMahjongGamePreset {
  const pool = T.flatMap(tile => Array<string>(4).fill(tile)), hands = Array.from({ length: 4 }, (_, i) => [...(hints[i] ?? [])]);
  const take = (tile: string) => { const at = pool.indexOf(tile); if (at < 0) throw new Error('invalid fixture fifth copy: ' + tile); pool.splice(at, 1); };
  for (const hand of hands) for (const tile of hand) take(tile); for (const tile of [...first, ...tail]) take(tile);
  const random = seeded(4819); for (let i = pool.length - 1; i > 0; i--) { const j = Math.floor(random() * (i + 1)); [pool[i], pool[j]] = [pool[j], pool[i]]; }
  for (const hand of hands) while (hand.length < 13) hand.push(pool.pop()!);
  return { hands, wall: [...first, ...pool, ...tail], turn };
}
function conserved(snapshot: HomeMahjongGameSnapshot) {
  if (snapshot.status === 'waiting') return;
  const physical = snapshot.players.flatMap(p => [...p.hand, ...p.discards, ...p.melds.flatMap(m => m.tiles)]);
  expect(physical.length + snapshot.wallRemaining).toBe(136); expect(snapshot.wallRemaining).toBeGreaterThanOrEqual(0);
  const counts = new Map<string, number>(); for (const tile of physical) { expect(T).toContain(tile); counts.set(tile, (counts.get(tile) ?? 0) + 1); }
  expect([...counts.values()].every(count => count <= 4)).toBe(true);
  for (const p of snapshot.players) for (const meld of p.melds) {
    expect(meld.tiles.length).toBe(meld.kind === 'kong' ? 4 : 3);
    if (meld.kind === 'chow') { const indices = meld.tiles.map(tile => T.indexOf(tile));
      expect(indices[0]).toBeLessThan(27); expect(Math.floor(indices[0] / 9)).toBe(Math.floor(indices[2] / 9));
      expect(indices[1]).toBe(indices[0] + 1); expect(indices[2]).toBe(indices[0] + 2);
    } else expect(new Set(meld.tiles).size).toBe(1);
  }
}
function runner(value?: HomeMahjongGamePreset, random = seeded(8)) {
  const game = createHomeMahjongGame({ preset: value, random }); let time = 0;
  const events: HomeMahjongGameEvent[] = []; game.step({ elapsed: time, moving: true, enabled: true, actors });
  const frame = (delta = .1) => { time += delta; const result = game.step({ elapsed: time, moving: true, enabled: true, actors });
    conserved(result.snapshot); if (result.event) events.push(result.event); return result; };
  const until = (kind: HomeMahjongGameEvent['kind'], limit = 1000) => { for (let i = 0; i < limit; i++) { const result = frame(); if (result.event?.kind === kind) return result; if (result.snapshot.status !== 'playing') break; } throw new Error('did not reach ' + kind); };
  return { game, frame, until, events, now: () => time };
}
const pairedDiscard = tiles('m4 m4 m5 m5 m6 m6 p4 p4 p5 p5 s6 s6 z7');
const pointCannon = preset([pairedDiscard, tiles('m1 m1 m1 p2 p2 p2 s3 s3 s3 z1 z1 z1 z7')], tiles('s7'));
describe('basic local mahjong winning shapes', () => {
  it('recognizes four groups plus a pair, exposed melds, and seven pairs without mutating input', () => {
    const regular = Object.freeze(tiles('m1 m2 m3 m4 m5 m6 p2 p2 p2 s7 s8 s9 z1 z1'));
    expect(isHomeMahjongWinningHand(regular)).toBe(true);
    expect(isHomeMahjongWinningHand(tiles('m4 m5 m6 p2 p2 p2 s7 s8 s9 z1 z1'), 1)).toBe(true);
    expect(isHomeMahjongWinningHand(tiles('m1 m1 m2 m2 p3 p3 p7 p7 s4 s4 z1 z1 z7 z7'))).toBe(true);
    expect(isHomeMahjongWinningHand(tiles('m1 m1 m1 m1 p3 p3 p7 p7 s4 s4 z1 z1 z7 z7'))).toBe(true);
    expect(isHomeMahjongWinningHand(tiles('z1 z1'), 4)).toBe(true); expect(regular).toHaveLength(14);
  });
  it('rejects honor runs, suit-boundary runs, missing pairs, wrong lengths and fifth copies', () => {
    expect(isHomeMahjongWinningHand(tiles('z1 z2 z3 m1 m2 m3 p1 p2 p3 s1 s2 s3 z7 z7'))).toBe(false);
    expect(isHomeMahjongWinningHand(tiles('m8 m9 p1 m1 m2 m3 p3 p4 p5 s1 s2 s3 z7 z7'))).toBe(false);
    expect(isHomeMahjongWinningHand(tiles('m1 m2 m3 m4 m5 m6 p1 p2 p3 s1 s2 s3 z1 z2'))).toBe(false);
    expect(isHomeMahjongWinningHand(tiles('m1 m1 m1 m1 m1 m2 m3 p1 p2 p3 s1 s2 s3 z1'))).toBe(false);
    expect(isHomeMahjongWinningHand(tiles('m1 m2'))).toBe(false); expect(isHomeMahjongWinningHand(['bad'])).toBe(false);
    for (const count of [-1, .5, 5, Number.NaN]) expect(isHomeMahjongWinningHand(tiles('z1 z1'), count)).toBe(false);
  });
});
describe('four actual seats and valid 136-tile deals', () => {
  it('starts only with four unique actor/seat pairs, sorts seats stably and deals thirteen each', () => {
    const random = vi.fn(seeded(3)), game = createHomeMahjongGame({ random });
    for (const input of [actors.slice(0, 3), [...actors, actors[0]], [actors[0], actors[0], actors[2], actors[3]], actors.map((a, i) => i === 3 ? { ...a, seatId: 'seat-1' } : a)]) {
      expect(game.step({ elapsed: 0, enabled: true, moving: true, actors: input }).snapshot.status).toBe('waiting'); }
    expect(random).not.toHaveBeenCalled(); const first = game.step({ elapsed: 0, enabled: true, moving: true, actors: [...actors].reverse() });
    expect(first.event).toBeNull(); expect(first.snapshot.status).toBe('playing'); expect(first.snapshot.phase).toBe('draw');
    expect(first.snapshot.players.map(p => p.actorId)).toEqual([1, 2, 3, 4]); expect(first.snapshot.players.every(p => p.hand.length === 13)).toBe(true); expect(first.snapshot.wallRemaining).toBe(84); conserved(first.snapshot);
    const other = createHomeMahjongGame({ random: seeded(3) }); expect(other.step({ elapsed: 0, moving: true, enabled: true, actors }).snapshot.players).toEqual(first.snapshot.players);
    const revision = first.snapshot.revision; expect(game.step({ elapsed: .1, enabled: true, moving: true, actors }).snapshot.revision).toBe(revision);
  });
  it('rejects invalid presets rather than creating short walls or fifth copies and preserves caller arrays', () => {
    expect(() => createHomeMahjongGame({ preset: null as unknown as HomeMahjongGamePreset })).toThrow(RangeError);
    const valid = preset([[], [], [], []]); const before = JSON.stringify(valid); createHomeMahjongGame({ preset: valid }); expect(JSON.stringify(valid)).toBe(before);
    const copies = (value: HomeMahjongGamePreset) => JSON.parse(JSON.stringify(value)) as { hands: string[][]; wall: string[]; turn: number };
    const short = copies(valid); short.wall.pop(); expect(() => createHomeMahjongGame({ preset: short })).toThrow(RangeError);
    const hand = copies(valid); hand.hands[0].pop(); expect(() => createHomeMahjongGame({ preset: hand })).toThrow(RangeError);
    const invalid = copies(valid); invalid.wall[0] = 'not a tile'; expect(() => createHomeMahjongGame({ preset: invalid })).toThrow(RangeError);
    const fifth = copies(valid); const index = fifth.wall.findIndex(tile => tile !== '白板'); fifth.wall[index] = '白板'; expect(() => createHomeMahjongGame({ preset: fifth })).toThrow(RangeError);
    expect(() => createHomeMahjongGame({ preset: { ...valid, turn: 4 } })).toThrow(RangeError);
    const game = createHomeMahjongGame({ random: () => 1 }); expect(() => game.step({ elapsed: 0, moving: true, enabled: true, actors })).toThrow(RangeError); expect(game.getSnapshot().status).toBe('waiting');
  });
  it('exhausts a complete real 84-tile wall without a win and never starts another round', () => {
    const run = runner(undefined, seeded(284)); let frames = 0;
    while (run.game.getSnapshot().status === 'playing' && frames++ < 9000) run.frame();
    const ended = run.game.getSnapshot(); expect(ended.status).toBe('exhausted'); expect(ended.wallRemaining).toBe(0);
    expect(ended.lastEvent).toMatchObject({ kind: 'exhausted', tile: null, text: '流局' });
    expect(run.events.filter(event => event.kind === 'draw')).toHaveLength(84); expect(run.events.some(event => event.kind === 'win')).toBe(false);
    conserved(ended); const count = run.events.length; for (let i = 0; i < 100; i++) run.frame();
    expect(run.events).toHaveLength(count); expect(run.game.getSnapshot().lastEvent).toBe(ended.lastEvent); expect(run.game.getSnapshot().wallRemaining).toBe(0);
  });
  it('keeps physical tile counts conserved after every phase and never creates a fifth visible copy', () => {
    const run = runner(); let frames = 0;
    while (run.game.getSnapshot().status === 'playing' && frames++ < 9000) run.frame();
    expect(frames).toBeLessThan(9000); expect(['won', 'exhausted']).toContain(run.game.getSnapshot().status);
    expect(run.events.every((event, i) => i === 0 || event.id > run.events[i - 1].id)).toBe(true);
    const ended = run.game.getSnapshot(), revision = ended.revision; for (let i = 0; i < 20; i++) expect(run.frame().event).toBeNull();
    expect(run.game.getSnapshot().revision).toBe(revision); expect(run.game.getSnapshot().lastEvent).toEqual(ended.lastEvent);
  });
});
describe('timing, freeze and local lifecycle', () => {
  it('emits draw into hold and selects the actual discarded tile before the discard animation', () => {
    const run = runner(pointCannon); const draw = run.until('draw'); expect(draw.snapshot.phase).toBe('hold'); expect(draw.snapshot.players[0].hand).toHaveLength(14); expect(draw.event?.tile).toBe('七条');
    const discard = run.until('discard'); expect(discard.event?.tile).toBe('白板'); expect(discard.snapshot.phase).toBe('discard'); expect(discard.snapshot.lastEvent?.tile).toBe('白板'); expect(discard.snapshot.players[0].discards.at(-1)).toBe('白板');
    expect(discard.snapshot.players[0].hand).toHaveLength(13); for (let i = 0; i < 7; i++) expect(run.frame().event).toBeNull();
    const claim = run.frame(); expect(claim.snapshot.phase).toBe('claim'); expect(claim.event).toBeNull();
  });
  it('baselines initial, pause, disabled, busy, backward and large-jump frames without catching up', () => {
    const game = createHomeMahjongGame({ random: seeded(1) });
    expect(game.step({ elapsed: 0, moving: false, enabled: true, actors }).snapshot.status).toBe('waiting');
    const initial = game.step({ elapsed: 10, moving: true, enabled: true, actors }); expect(initial.event).toBeNull();
    for (const overrides of [{ moving: false }, { enabled: false }, { busy: true }]) {
      const before = game.getSnapshot(); expect(game.step({ elapsed: 100, moving: true, enabled: true, actors, ...overrides }).event).toBeNull();
      expect(game.step({ elapsed: 100.1, moving: true, enabled: true, actors }).snapshot).toEqual(before); }
    expect(game.step({ elapsed: 500, moving: true, enabled: true, actors }).event).toBeNull();
    expect(game.step({ elapsed: 1, moving: true, enabled: true, actors }).event).toBeNull();
    const before = game.getSnapshot(); expect(game.step({ elapsed: Number.NaN, moving: true, enabled: true, actors }).snapshot).toBe(before);
    expect(game.step({ elapsed: 1000, moving: true, enabled: true, actors }).event).toBeNull();
    expect(game.step({ elapsed: 1000.5, moving: true, enabled: true, actors }).snapshot.phaseProgress).toBeCloseTo(.1);
  });
  it('resets on removal or changed seats, deeply freezes snapshots, and leaves disposed games inert', () => {
    const run = runner(pointCannon); run.until('draw'); const snapshot = run.game.getSnapshot(), input = Object.freeze(actors.map(a => Object.freeze({ ...a })));
    expect(Object.isFrozen(snapshot)).toBe(true); expect(Object.isFrozen(snapshot.players[0].hand)).toBe(true); expect(Object.isFrozen(snapshot.lastEvent)).toBe(true);
    expect(run.game.step({ elapsed: 2, enabled: true, moving: true, actors: [...input].reverse() }).snapshot.status).toBe('playing');
    const changed = actors.map((a, i) => i === 0 ? { ...a, seatId: 'seat-0' } : a);
    expect(run.game.step({ elapsed: 2.1, enabled: true, moving: true, actors: changed }).snapshot.status).toBe('waiting'); expect(run.game.getSnapshot().players).toHaveLength(0);
    expect(run.game.step({ elapsed: 2.2, enabled: true, moving: true, actors: changed }).snapshot.status).toBe('playing');
    expect(run.game.step({ elapsed: 2.3, enabled: true, moving: true, actors: actors.slice(1) }).snapshot.status).toBe('waiting');
    run.game.reset(); const waiting = run.game.getSnapshot(); run.game.dispose(); expect(run.game.step({ elapsed: 900, enabled: true, moving: true, actors }).snapshot).toBe(waiting); run.game.reset(); expect(run.game.getSnapshot()).toBe(waiting);
  });
  it('uses no network, wall clock or timers for any local game step', () => {
    const fetch = vi.spyOn(globalThis, 'fetch'), timer = vi.spyOn(globalThis, 'setTimeout'), interval = vi.spyOn(globalThis, 'setInterval'), date = vi.spyOn(Date, 'now');
    try { const run = runner(pointCannon); for (let i = 0; i < 100; i++) run.frame(); run.game.reset(); run.game.dispose();
      expect(fetch).not.toHaveBeenCalled(); expect(timer).not.toHaveBeenCalled(); expect(interval).not.toHaveBeenCalled(); expect(date).not.toHaveBeenCalled(); }
    finally { fetch.mockRestore(); timer.mockRestore(); interval.mockRestore(); date.mockRestore(); }
  });
});
describe('real tile conditions for claims and supplements', () => {
  it('wins off the actual discard and leaves the final winning hand intact', () => {
    const run = runner(pointCannon); const result = run.until('win'); expect(result.event).toMatchObject({ actorId: 2, fromActorId: 1, tile: '白板', text: '胡' });
    expect(result.snapshot.status).toBe('won'); expect(result.snapshot.phase).toBe('ended'); expect(isHomeMahjongWinningHand(result.snapshot.players[1].hand)).toBe(true);
    expect(result.snapshot.players[0].discards).not.toContain('白板'); expect(result.event?.afterKong).toBeUndefined();
  });
  it('pungs only a real pair and discards next without an intervening draw', () => {
    const value = preset([pairedDiscard, tiles('z7 z7 m1 m2 m7 m8 p1 p2 p6 p7 s1 s3 s9')], tiles('s7'));
    const run = runner(value); const pung = run.until('pung'); expect(pung.event).toMatchObject({ actorId: 2, fromActorId: 1, tile: '白板', text: '碰' });
    expect(pung.snapshot.phase).toBe('hold'); expect(pung.snapshot.players[1].hand).toHaveLength(11); expect(pung.snapshot.players[1].melds[0].tiles).toEqual(['白板', '白板', '白板']);
    const after = run.events.length; const discard = run.until('discard'); expect(discard.event?.actorId).toBe(2); expect(run.events.slice(after).map(e => e.kind)).toEqual(['discard']);
  });
  it('exposed kongs claim exactly three matching tiles and must draw a supplement before discarding', () => {
    const value = preset([pairedDiscard, tiles('z7 z7 z7 m1 m2 m7 m8 p1 p2 p6 p7 s1 s3')], tiles('s7'), 0, tiles('s8'));
    const run = runner(value); const kong = run.until('kong'); expect(kong.event).toMatchObject({ actorId: 2, fromActorId: 1, tile: '白板', text: '杠' });
    expect(kong.snapshot.phase).toBe('draw'); expect(kong.snapshot.players[1].melds[0].concealed).toBeUndefined(); expect(kong.snapshot.players[1].hand).toHaveLength(10); expect(kong.snapshot.players[1].melds[0].tiles).toHaveLength(4);
    const after = run.events.length; const draw = run.until('draw'); expect(draw.event).toMatchObject({ actorId: 2, tile: '八条', afterKong: true }); expect(draw.snapshot.players[1].hand).toHaveLength(11);
    expect(run.events.slice(after).map(e => e.kind)).toEqual(['draw']); expect(draw.event?.text).not.toBe('杠上花');
  });
  it('concealed kongs remove four real tiles, supplement, then call kong-flower only on an actual win', () => {
    const value = preset([tiles('z7 z7 z7 z7 m1 m2 m3 p1 p2 p3 s1 s2 s3')], tiles('z1'), 0, tiles('z1'));
    const run = runner(value); const kong = run.until('kong'); expect(kong.event).toMatchObject({ actorId: 1, tile: '白板', text: '杠' }); expect(kong.event?.fromActorId).toBeUndefined();
    expect(kong.snapshot.players[0].hand).toHaveLength(10); expect(kong.snapshot.players[0].melds[0].concealed).toBe(true); expect(kong.snapshot.phase).toBe('draw');
    const draw = run.until('draw'); expect(draw.event?.afterKong).toBe(true); expect(draw.event?.tile).toBe('东风');
    const win = run.until('win'); expect(win.event).toMatchObject({ actorId: 1, text: '杠上花', afterKong: true, tile: '东风' });
    expect(isHomeMahjongWinningHand(win.snapshot.players[0].hand, 1)).toBe(true);
  });
  it('draws normally from the front but supplements from the tail, without inventing a kong-flower on a nonwinning tail', () => {
    // Front East would complete the hand after the kong; the actual tail South must not.
    const value = preset([tiles('z7 z7 z7 z7 m1 m2 m3 p1 p2 p3 s1 s2 s3')], tiles('z1 z1'), 0, tiles('z2'));
    expect(value.wall[0]).toBe('东风'); expect(value.wall[1]).toBe('东风'); expect(value.wall.at(-1)).toBe('南风');
    const run = runner(value); const ordinary = run.until('draw'); expect(ordinary.event?.tile).toBe('东风'); expect(ordinary.event?.afterKong).toBeUndefined();
    const kong = run.until('kong'); expect(kong.event?.tile).toBe('白板'); const draw = run.until('draw');
    expect(draw.event).toMatchObject({ actorId: 1, tile: '南风', afterKong: true }); expect(draw.snapshot.wallRemaining).toBe(82);
    expect(isHomeMahjongWinningHand(draw.snapshot.players[0].hand, 1)).toBe(false);
    const next = run.until('discard'); expect(next.event?.actorId).toBe(1); expect(run.events.some(event => event.kind === 'win' || event.text === '杠上花')).toBe(false);
  });
  it('calls ordinary self-draw without inventing a kong', () => {
    const value = preset([tiles('m1 m2 m3 m4 m5 m6 p1 p2 p3 s1 s2 s3 z1')], tiles('z1'));
    const run = runner(value); const result = run.until('win'); expect(result.event).toMatchObject({ actorId: 1, text: '自摸', tile: '东风' });
    expect(result.event?.afterKong).toBeUndefined(); expect(run.events.some(e => e.kind === 'kong')).toBe(false);
  });
  it('gives a real winning hand priority over an earlier clockwise kong claimant', () => {
    const p0 = tiles('p4 p4 p5 p5 p6 p6 s4 s4 s5 s5 s6 s6 m5');
    const p1 = tiles('m5 m5 m5 m7 m8 p7 p8 p9 s7 s8 s9 z4 z5');
    const p2 = tiles('m1 m2 m3 m4 m6 p1 p2 p3 s1 s2 s3 z1 z1');
    const run = runner(preset([p0, p1, p2], tiles('p7'))); const result = run.until('win'); expect(result.event).toMatchObject({ actorId: 3, fromActorId: 1, tile: '五万', text: '胡' });
    expect(run.events.some(e => e.kind === 'kong')).toBe(false);
  });
  it('chooses the nearest clockwise winner when multiple hands really win on the discard', () => {
    const p0 = tiles('p4 p4 p5 p5 p6 p6 s4 s4 s5 s5 s6 s6 m5');
    const p1 = tiles('m4 m6 p1 p2 p3 p4 p5 p6 s1 s2 s3 z1 z1'), p2 = tiles('m4 m6 p1 p2 p3 p4 p5 p6 s1 s2 s3 z2 z2');
    const run = runner(preset([p0, p1, p2], tiles('p7'))); expect(run.until('win').event?.actorId).toBe(2);
  });
});

const claimsP0 = tiles('p4 p4 p5 p5 p6 p6 s4 s4 s5 s5 s6 s6 m5');
const claimsP1 = tiles('m5 m5 m1 m2 m3 m7 m8 m9 p7 p8 p9 p8 z7');
const claimsP2 = tiles('m4 m6 p1 p2 p3 p4 p5 p6 s1 s2 z1 z1 z7');
const claimsP3 = tiles('m1 m1 m2 m2 m3 m3 m7 m7 m8 m8 m9 m9 z4');
const chowHands = [claimsP0, tiles('m4 m6 m5 m7 m8 m9 p1 p2 p3 s1 s2 s3 z7'),
  tiles('m5 m7 m8 m9 p7 p8 p9 s7 s8 s9 z1 z2 z3'), tiles('m5 m1 m1 m2 m2 m3 m3 m7 m7 m8 m8 z4 z5')];
const addedKongPreset = () => preset([claimsP0, claimsP1, claimsP2, claimsP3], tiles('p7 s8 z5 z3 m5'), 0, tiles('p8'));
const robKongPreset = () => preset([claimsP0, claimsP1, claimsP2, claimsP3], tiles('p7 s3 z5 z3 m5'), 0, tiles('p8'));
function fourthPungTile(run: ReturnType<typeof runner>) {
  for (let i = 0; i < 600; i++) { const result = run.frame();
    if (result.event?.kind === 'draw' && result.event.actorId === 2 && result.event.tile === '五万') return result;
    if (result.snapshot.status !== 'playing') break;
  }
  throw new Error('did not reach the actual fourth tile after a real pung');
}
describe('chows only from the next clockwise seat', () => {
  it('consumes the real discard and two owned tiles, then holds and discards without another draw', () => {
    const run = runner(preset(chowHands, tiles('p7'))), draw = run.until('draw'); expect(draw.event?.actorId).toBe(1);
    const discarded = run.until('discard'); expect(discarded.event?.tile).toBe('五万'); const wall = discarded.snapshot.wallRemaining;
    const result = run.until('chow'); expect(result.event).toMatchObject({ actorId: 2, tile: '五万', text: '吃', fromActorId: 1 });
    expect(result.snapshot.phase).toBe('hold'); expect(result.snapshot.wallRemaining).toBe(wall);
    expect(result.snapshot.players[1].melds).toEqual([{ kind: 'chow', tiles: ['四万', '五万', '六万'] }]);
    expect(result.snapshot.players[0].discards).not.toContain('五万'); expect(result.snapshot.players[1].hand).toHaveLength(11);
    const count = run.events.length; expect(run.until('discard').event?.actorId).toBe(2); expect(run.events.slice(count).map(e => e.kind)).toEqual(['discard']);
  });
  it('never lets a non-next seat chow even when that hand has the two exact matching tiles', () => {
    const run = runner(preset([chowHands[0], chowHands[2], chowHands[1], chowHands[3]], tiles('p7')));
    run.until('draw'); run.until('discard'); const next = run.until('draw'); expect(next.event?.actorId).toBe(2);
    expect(run.events.some(e => e.kind === 'chow')).toBe(false); expect(next.snapshot.players.every(p => p.melds.length === 0)).toBe(true);
  });
  it('does not turn honors or a nine-to-next-suit boundary into a chow', () => {
    const honor = preset([pairedDiscard, tiles('z5 z6 m1 m2 m3 p1 p2 p3 s1 s2 s3 m7 m9'), tiles('z7'), tiles('z7')], tiles('s7'), 0, tiles('z7'));
    const boundary = preset([tiles('p4 p4 p5 p5 p6 p6 s4 s4 s5 s5 s6 s6 m9'),
      tiles('p1 p2 m1 m2 m3 p4 p5 p6 s1 s2 s3 z1 z2'), tiles('m9'), tiles('m9')], tiles('p7'), 0, tiles('m9'));
    for (const value of [honor, boundary]) {
      const run = runner(value); run.until('draw'); run.until('discard');
      for (let frame = 0; frame < 30 && run.game.getSnapshot().status === 'playing'; frame++) run.frame();
      expect(run.events.some(e => e.kind === 'chow')).toBe(false);
    }
  });
  it('gives another real pung claimant priority over the next seat chow', () => {
    const next = tiles('m4 m6 m1 m2 m3 p1 p2 p3 s1 s2 s3 z6 z7');
    const pair = tiles('m5 m5 m7 m8 m9 p7 p8 p9 s7 s8 s9 z1 z2');
    const run = runner(preset([claimsP0, next, pair, claimsP3], tiles('p7'), 0, tiles('m5')));
    const result = run.until('pung'); expect(result.event).toMatchObject({ actorId: 3, tile: '五万', fromActorId: 1 });
    expect(run.events.some(e => e.kind === 'chow')).toBe(false);
  });
});
describe('real added kongs and atomic rob-kong winning claims', () => {
  it('upgrades an existing real pung only after holding its fourth tile, then supplements from the tail and may win', () => {
    const run = runner(addedKongPreset()); const pung = run.until('pung'); expect(pung.event).toMatchObject({ actorId: 2, tile: '五万' });
    const before = fourthPungTile(run); expect(before.snapshot.players[1].melds).toEqual([{ kind: 'pung', tiles: ['五万', '五万', '五万'] }]);
    expect(before.snapshot.players[1].hand.filter(t => t === '五万')).toHaveLength(1); expect(isHomeMahjongWinningHand([...before.snapshot.players[2].hand, '五万'])).toBe(false);
    const upgraded = run.until('kong'); expect(upgraded.event).toMatchObject({ actorId: 2, tile: '五万', text: '杠' }); expect(upgraded.event?.fromActorId).toBeUndefined();
    expect(upgraded.snapshot.phase).toBe('draw'); expect(upgraded.snapshot.wallRemaining).toBe(before.snapshot.wallRemaining);
    expect(upgraded.snapshot.players[1].melds).toEqual([{ kind: 'kong', tiles: ['五万', '五万', '五万', '五万'] }]);
    expect(upgraded.snapshot.players[1].melds[0].concealed).toBeUndefined();
    expect(upgraded.snapshot.players[1].hand).toHaveLength(before.snapshot.players[1].hand.length - 1);
    expect(before.snapshot.players[1].melds[0].kind).toBe('pung');
    const draw = run.until('draw'); expect(draw.event).toMatchObject({ actorId: 2, tile: '八筒', afterKong: true });
    expect(draw.snapshot.wallRemaining).toBe(before.snapshot.wallRemaining - 1);
    const win = run.until('win'); expect(win.event).toMatchObject({ actorId: 2, text: '杠上花', tile: '八筒', afterKong: true }); expect(win.event?.robbedKong).toBeUndefined();
  });
  it('checks a true rob-kong win before upgrading the pung or consuming any supplement tile', () => {
    const run = runner(robKongPreset()); run.until('pung'); const fourth = fourthPungTile(run), before = fourth.snapshot;
    expect(isHomeMahjongWinningHand([...before.players[2].hand, '五万'])).toBe(true);
    expect(before.players[1].melds[0].tiles).toHaveLength(3); expect(before.players[1].hand.filter(t => t === '五万')).toHaveLength(1);
    const prior = run.events.length; const result = run.until('win'); expect(result.event).toMatchObject({ actorId: 3, tile: '五万', text: '抢杠胡', fromActorId: 2, robbedKong: true });
    expect(result.event?.afterKong).toBeUndefined(); expect(result.snapshot.wallRemaining).toBe(before.wallRemaining);
    expect(result.snapshot.players[1].melds).toEqual(before.players[1].melds); expect(result.snapshot.players[1].melds[0].kind).toBe('pung');
    expect(result.snapshot.players[1].hand.filter(t => t === '五万')).toHaveLength(0);
    expect(result.snapshot.players[2].hand.length).toBe(before.players[2].hand.length + 1); expect(result.snapshot.players[2].hand.filter(t => t === '五万')).toHaveLength(1);
    expect(isHomeMahjongWinningHand(result.snapshot.players[2].hand)).toBe(true); expect(run.events.slice(prior).map(e => e.kind)).toEqual(['win']);
    const final = result.snapshot; for (let i = 0; i < 20; i++) run.frame(); expect(run.game.getSnapshot().lastEvent).toBe(final.lastEvent);
  });
  it('pauses a pending fourth tile without catchup, then resolves the same rob claim; reset discards all old meld ownership', () => {
    const run = runner(robKongPreset()); run.until('pung'); const fourth = fourthPungTile(run), snapshot = fourth.snapshot;
    let time = run.now() + 100; expect(run.game.step({ elapsed: time, enabled: true, moving: false, actors }).snapshot).toBe(snapshot);
    time += .1; expect(run.game.step({ elapsed: time, enabled: true, moving: true, actors }).event).toBeNull();
    let result: HomeMahjongGameEvent | null = null;
    for (let i = 0; i < 18; i++) { time += .1; const frame = run.game.step({ elapsed: time, enabled: true, moving: true, actors }); conserved(frame.snapshot); if (frame.event) result = frame.event; }
    expect(result).toMatchObject({ kind: 'win', actorId: 3, text: '抢杠胡', robbedKong: true });
    run.game.reset(); expect(run.game.getSnapshot().status).toBe('waiting'); expect(run.game.getSnapshot().players).toHaveLength(0);
    const fresh = run.game.step({ elapsed: time + 1, enabled: true, moving: true, actors }); expect(fresh.event).toBeNull();
    expect(fresh.snapshot.players.every(p => p.hand.length === 13 && p.melds.length === 0 && p.discards.length === 0)).toBe(true); conserved(fresh.snapshot);
  });
});

describe('concealed-kong face visibility marker', () => {
  it('marks only an actual concealed kong, keeps old snapshots immutable and clears all markers on reset', () => {
    const value = preset([tiles('z7 z7 z7 z7 m1 m2 m3 p1 p2 p3 s1 s2 s3')], tiles('z1'), 0, tiles('z1'));
    const run = runner(value), kong = run.until('kong'), oldMeld = kong.snapshot.players[0].melds[0];
    expect(oldMeld).toEqual({ kind: 'kong', concealed: true, tiles: ['白板', '白板', '白板', '白板'] });
    expect(Object.isFrozen(oldMeld)).toBe(true); expect(Object.isFrozen(oldMeld.tiles)).toBe(true);
    const wall = kong.snapshot.wallRemaining; expect(run.until('draw').snapshot.wallRemaining).toBe(wall - 1);
    run.game.reset(); expect(run.game.getSnapshot().status).toBe('waiting'); expect(run.game.getSnapshot().players).toHaveLength(0);
    const fresh = run.game.step({ elapsed: run.now() + 1, moving: true, enabled: true, actors }).snapshot;
    expect(fresh.players.every(player => player.melds.length === 0)).toBe(true); conserved(fresh);
    expect(oldMeld.concealed).toBe(true); expect(oldMeld.tiles).toHaveLength(4);
  });
});
