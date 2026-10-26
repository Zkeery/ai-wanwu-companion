import { sampleHomeAmbience } from './living-home-ambience';
import type { HomeLocalSpeechCaption } from './living-home-local-speech';

export const HOME_MAHJONG_CALLS_ORIGIN = 'local_animation_example' as const;
export const HOME_MAHJONG_CALL_TEXTS = Object.freeze([
  '一万', '二万', '三万', '四万', '五万', '六万', '七万', '八万', '九万',
  '一筒', '二筒', '三筒', '四筒', '五筒', '六筒', '七筒', '八筒', '九筒',
  '一条', '二条', '三条', '四条', '五条', '六条', '七条', '八条', '九条',
  '东风', '南风', '西风', '北风', '红中', '发财', '白板',
] as const);
export type HomeMahjongCallStep = Readonly<{
  elapsed: number; moving: boolean; enabled: boolean;
  assignments: readonly Readonly<{ actorId: number; activity: string; startedAtElapsed: number }>[];
  audibleIds: readonly number[] | ReadonlySet<number>;
}>;

/** Example calls for the local animation only; no tiles, rules or game results
 * are inferred. The caller owns the synthetic preview gate and local playback.
 */
export function createHomeMahjongCalls(options: { random?: () => number } = {}) {
  const random = options.random ?? Math.random;
  let bag: (typeof HOME_MAHJONG_CALL_TEXTS)[number][] = [], previousTile: string | null = null;
  function nextTile() {
    if (!bag.length) {
      bag = [...HOME_MAHJONG_CALL_TEXTS];
      for (let i = bag.length - 1; i > 0; i--) {
        const sample = random(), unit = Number.isFinite(sample) ? Math.max(0, Math.min(1 - Number.EPSILON, sample)) : 0;
        const j = Math.floor(unit * (i + 1));
        [bag[i], bag[j]] = [bag[j], bag[i]];
      }
      // Keep a fresh shuffled bag from repeating the last tile just announced.
      if (bag[bag.length - 1] === previousTile) [bag[0], bag[bag.length - 1]] = [bag[bag.length - 1], bag[0]];
    }
    const tile = bag.pop()!; previousTile = tile; return tile;
  }
  let lastElapsed: number | null = null, lastCallElapsed = -Infinity, disposed = false;
  const seen = new Set<string>();
  function reset() { lastElapsed = null; lastCallElapsed = -Infinity; seen.clear(); bag = []; previousTile = null; }
  return {
    step(input: HomeMahjongCallStep): HomeLocalSpeechCaption | null {
      if (disposed) return null;
      if (!Number.isFinite(input.elapsed) || input.elapsed < 0) { lastElapsed = null; return null; }
      const rebase = lastElapsed === null || input.elapsed < lastElapsed || input.elapsed - lastElapsed > .75;
      if (lastElapsed !== null && input.elapsed < lastElapsed) lastCallElapsed = -Infinity;
      lastElapsed = input.elapsed;
      const audible = new Set(input.audibleIds), candidates: Omit<HomeLocalSpeechCaption, 'text'>[] = [];
      for (const assignment of [...input.assignments].sort((a, b) => a.actorId - b.actorId || a.startedAtElapsed - b.startedAtElapsed)) {
        const { actorId, activity, startedAtElapsed } = assignment;
        if (activity !== 'mahjong' || !Number.isSafeInteger(actorId) || actorId <= 0 || !Number.isFinite(startedAtElapsed) || startedAtElapsed < 0 || input.elapsed < startedAtElapsed) continue;
        const relative = input.elapsed - startedAtElapsed, cue = sampleHomeAmbience('mahjong', relative, actorId).audio;
        if (!cue || cue.kind !== 'tile' || cue.episode % 2 !== 1) continue;
        const key = 'local-mahjong-example:' + actorId + ':' + startedAtElapsed + ':' + cue.episode;
        if (seen.has(key)) continue;
        seen.add(key);
        if (rebase || !input.enabled || !input.moving || !audible.has(actorId) || relative - cue.startedAt > .12 + 1e-9) continue;
        candidates.push(Object.freeze({ key, actorId }));
      }
      if (input.elapsed - lastCallElapsed < 2 || !candidates.length) return null;
      lastCallElapsed = input.elapsed; return Object.freeze({ ...candidates[0], text: nextTile() });
    },
    reset() { if (!disposed) reset(); },
    dispose() { if (disposed) return; reset(); disposed = true; },
  };
}
