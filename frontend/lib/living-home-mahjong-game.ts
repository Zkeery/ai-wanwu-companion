import { scoreSichuanHand, getSichuanWaits, type SichuanSuit } from './living-home-sichuan-score';
/** Local four-seat basic mahjong. No money, network, models, timers or automatic new rounds. */
export type HomeMahjongGameEvent = Readonly<{
  id: number; kind: 'draw' | 'discard' | 'chow' | 'pung' | 'kong' | 'win' | 'exhausted';
  actorId: number; tile: string | null; text: string; fromActorId?: number; afterKong?: boolean; robbedKong?: boolean;
}>;
export type HomeMahjongGameSnapshot = Readonly<{
  status: 'waiting' | 'playing' | 'won' | 'exhausted';
  players: readonly Readonly<{ actorId: number; seatId: string; hand: readonly string[];
    melds: readonly Readonly<{ kind: 'chow' | 'pung' | 'kong'; concealed?: boolean; tiles: readonly string[] }>[]; discards: readonly string[];
    won?: boolean; winningTile?: string | null; missingSuit?: SichuanSuit | null; score?: number }>[];
  turnActorId: number | null; phase: 'draw' | 'hold' | 'discard' | 'claim' | 'exchange' | 'dingque' | 'win' | 'ended';
  phaseProgress: number; wallRemaining: number; lastEvent: HomeMahjongGameEvent | null; revision: number;
  rules?: 'basic' | 'sichuan'; totalTiles?: number; exchangeDirection?: 1 | 2 | 3;
  settlement?: Readonly<{ reason: 'three-winners' | 'wall-exhausted'; readyActorIds: readonly number[]; flowerPigActorIds: readonly number[] }>;
  scoreTransfers?: readonly HomeMahjongScoreTransfer[];
}>;
export type HomeMahjongGameActor = Readonly<{ actorId: number; seatId: string }>;
export type HomeMahjongGamePreset = Readonly<{ hands: readonly (readonly string[])[]; wall: readonly string[]; turn?: number; exchangeDirection?: 1 | 2 | 3 }>;
export type HomeMahjongGameOptions = Readonly<{ rules?: 'basic' | 'sichuan'; random?: () => number; preset?: HomeMahjongGamePreset }>;
export type HomeMahjongScoreTransfer = Readonly<{ fromActorId: number; toActorId: number; points: number;
  reason: 'win' | 'exposed-kong' | 'added-kong' | 'concealed-kong' | 'flower-pig' | 'ready' | 'kong-refund' }>;
export type { SichuanSuit } from './living-home-sichuan-score';
export type HomeMahjongGameStep = Readonly<{ elapsed: number; moving: boolean; enabled: boolean; busy?: boolean; actors: readonly HomeMahjongGameActor[] }>;
const numerals = ['一', '二', '三', '四', '五', '六', '七', '八', '九'];
export const HOME_MAHJONG_GAME_TILES: readonly string[] = Object.freeze([
  ...['万', '筒', '条'].flatMap(suit => numerals.map(n => n + suit)), '东风', '南风', '西风', '北风', '红中', '发财', '白板',
]);
const tileIndices = new Map(HOME_MAHJONG_GAME_TILES.map((tile, index) => [tile, index]));
const PHASE_SECONDS = Object.freeze({ draw: 1, hold: 1.8, discard: .8, claim: 1.2, exchange: 2, dingque: 1.2, win: 1.2, ended: 1 });
type Meld = { kind: 'chow' | 'pung' | 'kong'; concealed?: boolean; tiles: number[] };
type Player = { actorId: number; seatId: string; hand: number[]; melds: Meld[]; discards: number[] };
function parseTiles(input: readonly string[]): number[] | null {
  if (!Array.isArray(input)) return null;
  const counts = Array<number>(34).fill(0), result: number[] = [];
  for (const value of input) { const index = tileIndices.get(value); if (index === undefined || ++counts[index] > 4) return null; result.push(index); }
  return result;
}
function completeGroups(counts: number[], remaining: number, memo: Map<string, boolean>): boolean {
  const first = counts.findIndex(count => count > 0);
  if (first < 0) return remaining === 0; if (remaining <= 0) return false;
  const key = remaining + ':' + counts.join(''); const cached = memo.get(key); if (cached !== undefined) return cached;
  let result = false;
  if (counts[first] >= 3) { counts[first] -= 3; result = completeGroups(counts, remaining - 1, memo); counts[first] += 3; }
  if (!result && first < 27 && first % 9 <= 6 && counts[first + 1] > 0 && counts[first + 2] > 0) {
    counts[first]--; counts[first + 1]--; counts[first + 2]--;
    result = completeGroups(counts, remaining - 1, memo); counts[first]++; counts[first + 1]++; counts[first + 2]++;
  }
  memo.set(key, result); return result;
}
/** Basic four groups plus a pair, or seven pairs without exposed melds. Honors never form sequences. */
export function isHomeMahjongWinningHand(hand: readonly string[], meldCount = 0): boolean {
  if (!Number.isInteger(meldCount) || meldCount < 0 || meldCount > 4) return false;
  const tiles = parseTiles(hand); if (!tiles || tiles.length !== 14 - meldCount * 3) return false;
  const counts = Array<number>(34).fill(0); for (const tile of tiles) counts[tile]++;
  if (meldCount === 0 && counts.every(count => count % 2 === 0)) return true;
  const memo = new Map<string, boolean>();
  for (let pair = 0; pair < 34; pair++) if (counts[pair] >= 2) {
    counts[pair] -= 2; const won = completeGroups(counts, 4 - meldCount, memo); counts[pair] += 2; if (won) return true;
  }
  return false;
}
function validatePreset(preset: HomeMahjongGamePreset): { hands: number[][]; wall: number[]; turn: number } {
  if (!preset || !Array.isArray(preset.hands) || preset.hands.length !== 4 || !Array.isArray(preset.wall) || preset.wall.length !== 84)
    throw new RangeError('麻将预设必须为四家13张起手和84张牌墙');
  const hands = preset.hands.map(hand => parseTiles(hand)); const wall = parseTiles(preset.wall), turn = preset.turn ?? 0;
  if (hands.some(hand => !hand || hand.length !== 13) || !wall || !Number.isInteger(turn) || turn < 0 || turn > 3)
    throw new RangeError('麻将预设含非法牌、起手张数或轮次');
  const counts = Array<number>(34).fill(0);
  for (const tile of [...hands.flatMap(hand => hand!), ...wall]) counts[tile]++;
  if (counts.some(count => count !== 4)) throw new RangeError('麻将预设必须保持136张且每种正好4张');
  return { hands: hands.map(hand => [...hand!].sort((a, b) => a - b)), wall: [...wall], turn };
}
function orderedActors(input: readonly HomeMahjongGameActor[]): HomeMahjongGameActor[] | null {
  if (!Array.isArray(input) || input.length !== 4) return null;
  const ids = new Set<number>(), seats = new Set<string>(), actors: HomeMahjongGameActor[] = [];
  for (const actor of input) {
    if (!actor || !Number.isSafeInteger(actor.actorId) || actor.actorId <= 0 || typeof actor.seatId !== 'string'
      || !actor.seatId || actor.seatId.length > 120 || actor.seatId.trim() !== actor.seatId || ids.has(actor.actorId) || seats.has(actor.seatId)) return null;
    ids.add(actor.actorId); seats.add(actor.seatId); actors.push({ actorId: actor.actorId, seatId: actor.seatId });
  }
  return actors.sort((a, b) => a.seatId < b.seatId ? -1 : a.seatId > b.seatId ? 1 : 0);
}
function countsOf(hand: readonly number[]) { const counts = Array<number>(34).fill(0); for (const tile of hand) counts[tile]++; return counts; }
function handWins(player: Player, extra?: number) {
  return isHomeMahjongWinningHand((extra === undefined ? player.hand : [...player.hand, extra]).map(tile => HOME_MAHJONG_GAME_TILES[tile]), player.melds.length);
}
function removeTiles(hand: number[], tile: number, count: number) { for (let n = 0; n < count; n++) { const at = hand.indexOf(tile); if (at < 0) throw new Error('麻将内部牌数不一致'); hand.splice(at, 1); } }
function createBasicHomeMahjongGame(options: HomeMahjongGameOptions = {}) {
  if (options.random !== undefined && typeof options.random !== 'function') throw new TypeError('random必须为本地函数');
  const random = options.random ?? Math.random, preset = options.preset === undefined ? null : validatePreset(options.preset);
  let disposed = false, players: Player[] = [], wall: number[] = [], turn = 0, revision = 0, eventId = 0;
  let status: HomeMahjongGameSnapshot['status'] = 'waiting', phase: HomeMahjongGameSnapshot['phase'] = 'ended';
  let phaseElapsed = 0, lastElapsed: number | null = null, scope: string | null = null, lastEvent: HomeMahjongGameEvent | null = null;
  let discard: { tile: number; from: number } | null = null, supplement = false, lastDrawAfterKong = false, lastDrawnTile: number | null = null;
  let holdReason: 'draw' | 'pung' = 'draw';
  function snapshot(): HomeMahjongGameSnapshot {
    return Object.freeze({ status, players: Object.freeze(players.map(player => Object.freeze({ actorId: player.actorId, seatId: player.seatId,
      hand: Object.freeze(player.hand.map(tile => HOME_MAHJONG_GAME_TILES[tile])),
      melds: Object.freeze(player.melds.map(meld => Object.freeze({ kind: meld.kind, ...(meld.concealed === undefined ? {} : { concealed: meld.concealed }), tiles: Object.freeze(meld.tiles.map(tile => HOME_MAHJONG_GAME_TILES[tile])) }))),
      discards: Object.freeze(player.discards.map(tile => HOME_MAHJONG_GAME_TILES[tile])), }))),
      turnActorId: status === 'waiting' ? null : players[turn]?.actorId ?? null, phase,
      phaseProgress: phase === 'ended' ? status === 'waiting' ? 0 : 1 : Math.min(1, phaseElapsed / PHASE_SECONDS[phase]),
      wallRemaining: wall.length, lastEvent, revision });
  }
  let current = snapshot();
  const publish = () => { current = snapshot(); return current; };
  function randomIndex(size: number) {
    const value = random(); if (!Number.isFinite(value) || value < 0 || value >= 1) throw new RangeError('random必须返回[0,1)内的有限数');
    return Math.floor(value * size);
  }
  function resetState() {
    players = []; wall = []; turn = 0; status = 'waiting'; phase = 'ended'; phaseElapsed = 0; lastElapsed = null; scope = null; lastEvent = null;
    discard = null; supplement = lastDrawAfterKong = false; lastDrawnTile = null; holdReason = 'draw'; revision++; publish();
  }
  function begin(actors: readonly HomeMahjongGameActor[]) {
    let hands: number[][], nextWall: number[];
    if (preset) { hands = preset.hands.map(hand => [...hand]); nextWall = [...preset.wall]; }
    else {
      const deck = Array.from({ length: 136 }, (_, index) => Math.floor(index / 4));
      for (let i = deck.length - 1; i > 0; i--) { const j = randomIndex(i + 1); [deck[i], deck[j]] = [deck[j], deck[i]]; }
      hands = Array.from({ length: 4 }, (_, seat) => deck.slice(seat * 13, seat * 13 + 13).sort((a, b) => a - b)); nextWall = deck.slice(52);
    }
    players = actors.map((actor, index) => ({ ...actor, hand: hands[index], melds: [], discards: [] })); wall = nextWall;
    turn = preset?.turn ?? 0; status = 'playing'; phase = 'draw'; phaseElapsed = 0; revision++; publish();
  }
  function emit(kind: HomeMahjongGameEvent['kind'], actor: number, tile: number | null, text: string,
    metadata: { fromActorId?: number; afterKong?: boolean; robbedKong?: boolean } = {}): HomeMahjongGameEvent {
    const event = Object.freeze({ id: ++eventId, kind, actorId: players[actor].actorId,
      tile: tile === null ? null : HOME_MAHJONG_GAME_TILES[tile], text, ...metadata }); lastEvent = event; return event;
  }
  function chooseDiscard(hand: readonly number[]) {
    const counts = countsOf(hand), scores = new Map<number, number>();
    for (const tile of hand) if (!scores.has(tile)) {
      let score = counts[tile] === 1 ? 12 : counts[tile] === 2 ? -2 : -13;
      if (tile >= 27) score += counts[tile] === 1 ? 8 : -5;
      else {
        const rank = tile % 9; if (rank === 0 || rank === 8) score += 1;
        for (const offset of [-2, -1, 1, 2]) if (rank + offset >= 0 && rank + offset <= 8 && counts[tile + offset] > 0) score -= Math.abs(offset) === 1 ? 5 : 2;
      }
      scores.set(tile, score);
    }
    const maximum = Math.max(...scores.values()), candidates = [...scores].filter(([, score]) => score === maximum).map(([tile]) => tile).sort((a, b) => a - b);
    return candidates[candidates.length > 1 ? randomIndex(candidates.length) : 0];
  }
  function nextPhase(next: HomeMahjongGameSnapshot['phase']) { phase = next; phaseElapsed = 0; }
  function chowPartners(player: Player, tile: number): readonly [number, number] | null {
    if (tile >= 27 || player.melds.length >= 4) return null;
    const counts = countsOf(player.hand), rank = tile % 9;
    for (const offsets of [[-2, -1], [-1, 1], [1, 2]] as const) {
      if (offsets.every(offset => rank + offset >= 0 && rank + offset <= 8 && counts[tile + offset] > 0))
        return [tile + offsets[0], tile + offsets[1]];
    }
    return null;
  }
  function claimDiscard() {
    if (!discard) { turn = (turn + 1) % 4; nextPhase('draw'); return null; }
    const { tile, from } = discard, order = [1, 2, 3].map(distance => (from + distance) % 4);
    const winner = order.find(index => handWins(players[index], tile));
    if (winner !== undefined) {
      players[from].discards.pop(); players[winner].hand.push(tile); players[winner].hand.sort((a, b) => a - b); turn = winner; discard = null;
      status = 'won'; nextPhase('ended'); return emit('win', winner, tile, '胡', { fromActorId: players[from].actorId });
    }
    const kong = wall.length > 0 ? order.find(index => players[index].melds.length < 4 && countsOf(players[index].hand)[tile] >= 3) : undefined;
    const pung = kong === undefined ? order.find(index => players[index].melds.length < 4 && countsOf(players[index].hand)[tile] >= 2) : undefined;
    const claimant = kong ?? pung;
    if (claimant !== undefined) {
      const isKong = kong !== undefined; players[from].discards.pop(); removeTiles(players[claimant].hand, tile, isKong ? 3 : 2);
      players[claimant].melds.push({ kind: isKong ? 'kong' : 'pung', tiles: Array(isKong ? 4 : 3).fill(tile) });
      turn = claimant; discard = null; supplement = isKong; lastDrawnTile = null; lastDrawAfterKong = false; holdReason = 'pung';
      nextPhase(isKong ? 'draw' : 'hold'); return emit(isKong ? 'kong' : 'pung', claimant, tile, isKong ? '杠' : '碰', { fromActorId: players[from].actorId });
    }
    const next = (from + 1) % 4, partners = chowPartners(players[next], tile);
    if (partners) {
      players[from].discards.pop(); for (const partner of partners) removeTiles(players[next].hand, partner, 1);
      players[next].melds.push({ kind: 'chow', tiles: [...partners, tile].sort((a, b) => a - b) });
      turn = next; discard = null; supplement = lastDrawAfterKong = false; lastDrawnTile = null; holdReason = 'pung';
      nextPhase('hold'); return emit('chow', next, tile, '吃', { fromActorId: players[from].actorId });
    }
    turn = next; discard = null; lastDrawnTile = null; lastDrawAfterKong = false; nextPhase('draw'); return null;
  }
  function advance(): HomeMahjongGameEvent | null {
    const player = players[turn];
    if (phase === 'draw') {
      const afterKong = supplement, tile = afterKong ? wall.pop() : wall.shift();
      if (tile === undefined) { status = 'exhausted'; nextPhase('ended'); return emit('exhausted', turn, null, '流局'); }
      player.hand.push(tile); player.hand.sort((a, b) => a - b); lastDrawnTile = tile; lastDrawAfterKong = afterKong; supplement = false; holdReason = 'draw'; nextPhase('hold');
      return emit('draw', turn, tile, HOME_MAHJONG_GAME_TILES[tile], lastDrawAfterKong ? { afterKong: true } : {});
    }
    if (phase === 'hold') {
      if (holdReason === 'draw' && handWins(player)) { status = 'won'; nextPhase('ended');
        return emit('win', turn, lastDrawnTile, lastDrawAfterKong ? '杠上花' : '自摸', lastDrawAfterKong ? { afterKong: true } : {}); }
      const added = wall.length > 0 ? player.melds.find(meld => meld.kind === 'pung' && player.hand.includes(meld.tiles[0])) : undefined;
      if (added) {
        const tile = added.tiles[0], declarer = turn;
        const robbedBy = [1, 2, 3].map(distance => (declarer + distance) % 4).find(index => handWins(players[index], tile));
        // Robbing is one atomic transfer of the fourth tile: the original pung
        // stays intact and the wall is never touched before all winning claims.
        if (robbedBy !== undefined) {
          removeTiles(player.hand, tile, 1); players[robbedBy].hand.push(tile); players[robbedBy].hand.sort((a, b) => a - b);
          turn = robbedBy; status = 'won'; supplement = lastDrawAfterKong = false; lastDrawnTile = null; nextPhase('ended');
          return emit('win', robbedBy, tile, '抢杠胡', { fromActorId: player.actorId, robbedKong: true });
        }
        removeTiles(player.hand, tile, 1); added.kind = 'kong'; added.tiles.push(tile); supplement = true;
        lastDrawnTile = null; lastDrawAfterKong = false; nextPhase('draw'); return emit('kong', turn, tile, '杠');
      }
      const quad = wall.length > 0 && player.melds.length < 4 ? countsOf(player.hand).findIndex(count => count === 4) : -1;
      if (quad >= 0) { removeTiles(player.hand, quad, 4); player.melds.push({ kind: 'kong', concealed: true, tiles: Array(4).fill(quad) }); supplement = true;
        lastDrawnTile = null; lastDrawAfterKong = false; nextPhase('draw'); return emit('kong', turn, quad, '杠'); }
      const tile = chooseDiscard(player.hand); removeTiles(player.hand, tile, 1); player.discards.push(tile); discard = { tile, from: turn }; nextPhase('discard');
      return emit('discard', turn, tile, HOME_MAHJONG_GAME_TILES[tile]);
    }
    if (phase === 'discard') { nextPhase('claim'); return null; }
    if (phase === 'claim') return claimDiscard();
    return null;
  }
  function step(input: HomeMahjongGameStep): Readonly<{ snapshot: HomeMahjongGameSnapshot; event: HomeMahjongGameEvent | null }> {
    if (disposed) return Object.freeze({ snapshot: current, event: null });
    const actors = orderedActors(input.actors), nextScope = actors ? JSON.stringify(actors) : null;
    if (!actors) { if (scope !== null || players.length > 0) resetState(); lastElapsed = null; return Object.freeze({ snapshot: current, event: null }); }
    if (scope !== null && scope !== nextScope) { resetState(); scope = nextScope; return Object.freeze({ snapshot: current, event: null }); }
    scope = nextScope;
    if (!Number.isFinite(input.elapsed) || input.elapsed < 0 || !input.enabled || !input.moving || input.busy) {
      lastElapsed = null; return Object.freeze({ snapshot: current, event: null });
    }
    if (status === 'waiting') { begin(actors); lastElapsed = input.elapsed; return Object.freeze({ snapshot: current, event: null }); }
    if (status !== 'playing') { lastElapsed = input.elapsed; return Object.freeze({ snapshot: current, event: null }); }
    const before = lastElapsed; lastElapsed = input.elapsed;
    if (before === null || input.elapsed <= before || input.elapsed - before > .75) return Object.freeze({ snapshot: current, event: null });
    phaseElapsed += Math.min(.1, input.elapsed - before);
    let event: HomeMahjongGameEvent | null = null;
    if (phaseElapsed + 1e-9 >= PHASE_SECONDS[phase]) { event = advance(); revision++; }
    publish(); return Object.freeze({ snapshot: current, event });
  }
  return { step, getSnapshot: () => current, reset() { if (!disposed) resetState(); }, dispose() { disposed = true; lastElapsed = null; } };
}

const SICHUAN_SUITS: readonly SichuanSuit[] = ['万', '筒', '条'];
type SichuanPlayer = Player & { won: boolean; winningTile: number | null; missingSuit: SichuanSuit | null; score: number };
type SichuanPendingWin = { actor: number; tile: number | null; text: string; metadata: { fromActorId?: number; afterKong?: boolean; robbedKong?: boolean } };
function validateSichuanPreset(preset: HomeMahjongGamePreset): { hands: number[][]; wall: number[]; dealer: number; exchangeDirection?: 1 | 2 | 3 } {
  const dealer = preset?.turn ?? 0;
  if (!preset || !Array.isArray(preset.hands) || preset.hands.length !== 4 || !Array.isArray(preset.wall) || preset.wall.length !== 55
    || !Number.isInteger(dealer) || dealer < 0 || dealer > 3 || preset.exchangeDirection !== undefined && ![1, 2, 3].includes(preset.exchangeDirection)) throw new RangeError('四川预设必须为庄14、他家13、牌墙55张');
  const hands = preset.hands.map(hand => parseTiles(hand)), wall = parseTiles(preset.wall);
  if (!wall || hands.some((hand, index) => !hand || hand.length !== (index === dealer ? 14 : 13))) throw new RangeError('四川预设起手张数或牌不合法');
  const counts = Array<number>(34).fill(0); for (const tile of [...hands.flatMap(hand => hand!), ...wall]) counts[tile]++;
  if (counts.some((count, index) => count !== (index < 27 ? 4 : 0))) throw new RangeError('四川预设仅108张万筒条，每类4张');
  return { hands: hands.map(hand => [...hand!].sort((a, b) => a - b)), wall: [...wall], dealer, ...(preset.exchangeDirection === undefined ? {} : { exchangeDirection: preset.exchangeDirection }) };
}
function createSichuanHomeMahjongGame(options: HomeMahjongGameOptions) {
  if (options.random !== undefined && typeof options.random !== 'function') throw new TypeError('random必须为本地函数');
  const random = options.random ?? Math.random, preset = options.preset === undefined ? null : validateSichuanPreset(options.preset);
  let disposed = false, players: SichuanPlayer[] = [], wall: number[] = [], turn = 0, dealer = 0, revision = 0, eventId = 0;
  let status: HomeMahjongGameSnapshot['status'] = 'waiting', phase: HomeMahjongGameSnapshot['phase'] = 'ended';
  let phaseElapsed = 0, lastElapsed: number | null = null, scope: string | null = null, lastEvent: HomeMahjongGameEvent | null = null;
  let exchangeDirection: 1 | 2 | 3 = 1, anyMeld = false, discardCount = 0, holdFromDraw = false;
  let supplement = false, lastDrawAfterKong = false, lastDrawWasLastTile = false, lastDrawnTile: number | null = null;
  let discard: { tile: number; from: number; kongDiscard: boolean; lastTile: boolean; earthly: boolean } | null = null;
  let pendingWins: SichuanPendingWin[] = [], resumeFrom = 0;
  let settlement: HomeMahjongGameSnapshot['settlement'];
  const scoreTransfers: HomeMahjongScoreTransfer[] = [];
  const kongLedger: { from: number; to: number; points: number; refunded: boolean }[] = [];
  function snapshot(): HomeMahjongGameSnapshot {
    return Object.freeze({ status, rules: 'sichuan', totalTiles: 108, exchangeDirection,
      players: Object.freeze(players.map(player => Object.freeze({ actorId: player.actorId, seatId: player.seatId,
        hand: Object.freeze(player.hand.map(tile => HOME_MAHJONG_GAME_TILES[tile])),
        melds: Object.freeze(player.melds.map(meld => Object.freeze({ kind: meld.kind, ...(meld.concealed === undefined ? {} : { concealed: meld.concealed }),
          tiles: Object.freeze(meld.tiles.map(tile => HOME_MAHJONG_GAME_TILES[tile])) }))),
        discards: Object.freeze(player.discards.map(tile => HOME_MAHJONG_GAME_TILES[tile])), won: player.won,
        winningTile: player.winningTile === null ? null : HOME_MAHJONG_GAME_TILES[player.winningTile], missingSuit: player.missingSuit, score: player.score }))),
      turnActorId: status === 'waiting' ? null : players[turn]?.actorId ?? null, phase,
      phaseProgress: phase === 'ended' ? status === 'waiting' ? 0 : 1 : Math.min(1, phaseElapsed / PHASE_SECONDS[phase]),
      wallRemaining: wall.length, lastEvent, revision, scoreTransfers: Object.freeze([...scoreTransfers]),
      ...(settlement ? { settlement } : {}) });
  }
  let current = snapshot();
  const publish = () => { current = snapshot(); return current; };
  const names = (tiles: readonly number[]) => tiles.map(tile => HOME_MAHJONG_GAME_TILES[tile]);
  const publicMelds = (player: SichuanPlayer) => player.melds.map(meld => ({ ...meld, tiles: names(meld.tiles) }));
  const isMissing = (player: SichuanPlayer, tile: number) => SICHUAN_SUITS[Math.floor(tile / 9)] === player.missingSuit;
  function randomIndex(size: number) {
    const value = random(); if (!Number.isFinite(value) || value < 0 || value >= 1) throw new RangeError('random必须返回[0,1)内的有限数'); return Math.floor(value * size);
  }
  function nextActive(from: number) { for (let distance = 1; distance <= 4; distance++) { const index = (from + distance) % 4; if (!players[index].won) return index; } return null; }
  function activeOthers(from: number) { return [1, 2, 3].map(distance => (from + distance) % 4).filter(index => !players[index].won); }
  function resetState() {
    players = []; wall = []; turn = dealer = 0; status = 'waiting'; phase = 'ended'; phaseElapsed = 0; lastElapsed = null; scope = null; lastEvent = null;
    exchangeDirection = 1; anyMeld = false; discardCount = 0; holdFromDraw = false; supplement = lastDrawAfterKong = lastDrawWasLastTile = false; lastDrawnTile = null;
    discard = null; pendingWins = []; resumeFrom = 0; settlement = undefined; scoreTransfers.length = kongLedger.length = 0; revision++; publish();
  }
  function begin(actors: readonly HomeMahjongGameActor[]) {
    let hands: number[][], nextWall: number[]; const nextDealer = preset?.dealer ?? 0;
    if (preset) { hands = preset.hands.map(hand => [...hand]); nextWall = [...preset.wall]; }
    else {
      const deck = Array.from({ length: 108 }, (_, index) => Math.floor(index / 4));
      for (let i = deck.length - 1; i > 0; i--) { const j = randomIndex(i + 1); [deck[i], deck[j]] = [deck[j], deck[i]]; }
      hands = Array.from({ length: 4 }, (_, seat) => deck.slice(seat * 13, seat * 13 + 13)); hands[nextDealer].push(deck[52]);
      nextWall = deck.slice(53);
    }
    const direction = preset?.exchangeDirection ?? (randomIndex(3) + 1) as 1 | 2 | 3;
    players = actors.map((actor, index) => ({ ...actor, hand: hands[index].sort((a, b) => a - b), melds: [], discards: [], won: false, winningTile: null, missingSuit: null, score: 0 }));
    dealer = turn = nextDealer; wall = nextWall; exchangeDirection = direction; status = 'playing'; phase = 'exchange'; phaseElapsed = 0; revision++; publish();
  }
  function transfer(from: number, to: number, points: number, reason: HomeMahjongScoreTransfer['reason']) {
    if (from === to) return; if (!Number.isSafeInteger(points) || points <= 0) throw new Error('本局分数必须为正整数');
    players[from].score -= points; players[to].score += points;
    scoreTransfers.push(Object.freeze({ fromActorId: players[from].actorId, toActorId: players[to].actorId, points, reason }));
    if (reason === 'exposed-kong' || reason === 'added-kong' || reason === 'concealed-kong') kongLedger.push({ from, to, points, refunded: false });
  }
  function emit(kind: HomeMahjongGameEvent['kind'], actor: number, tile: number | null, text: string,
    metadata: { fromActorId?: number; afterKong?: boolean; robbedKong?: boolean } = {}) {
    const event = Object.freeze({ id: ++eventId, kind, actorId: players[actor].actorId, tile: tile === null ? null : HOME_MAHJONG_GAME_TILES[tile], text, ...metadata });
    lastEvent = event; return event;
  }
  function nextPhase(next: HomeMahjongGameSnapshot['phase']) { phase = next; phaseElapsed = 0; }
  function winScore(index: number, tile: number | null, flags: { selfDraw?: boolean; afterKong?: boolean; robbedKong?: boolean; kongDiscard?: boolean; lastTile?: boolean; heavenly?: boolean; earthly?: boolean } = {}) {
    const player = players[index]; if (player.won || !player.missingSuit) return null;
    return scoreSichuanHand({ hand: names(player.hand), melds: publicMelds(player), missingSuit: player.missingSuit,
      ...(tile === null ? {} : { winningTile: HOME_MAHJONG_GAME_TILES[tile] }), ...flags });
  }
  function queueWinners(winners: readonly { index: number; points: number }[], tile: number | null, from: number,
    kind: 'discard' | 'self' | 'rob', afterKong = false) {
    const selfPayers = kind === 'self' ? activeOthers(from) : [];
    for (const winner of winners) {
      if (kind === 'self') for (const payer of selfPayers) transfer(payer, winner.index, winner.points, 'win');
      else transfer(from, winner.index, winner.points, 'win');
      players[winner.index].won = true; players[winner.index].winningTile = kind === 'self' ? null : tile;
      pendingWins.push({ actor: winner.index, tile, text: kind === 'rob' ? '抢杠胡' : kind === 'self' ? afterKong ? '杠上花' : '自摸' : '胡',
        metadata: { ...(kind === 'self' ? afterKong ? { afterKong: true } : {} : { fromActorId: players[from].actorId }), ...(kind === 'rob' ? { robbedKong: true } : {}) } });
    }
    resumeFrom = from; discard = null; supplement = lastDrawAfterKong = lastDrawWasLastTile = false; lastDrawnTile = null;
    nextPhase('win'); const first = pendingWins.shift()!; turn = first.actor; return emit('win', first.actor, first.tile, first.text, first.metadata);
  }
  function settleWall() {
    if (settlement) return;
    const active = players.map((_, index) => index).filter(index => !players[index].won);
    const pigs = active.filter(index => { const player = players[index]; return player.hand.some(tile => isMissing(player, tile)) || player.melds.some(meld => meld.tiles.some(tile => isMissing(player, tile))); });
    const nonPigs = active.filter(index => !pigs.includes(index)), waits = new Map<number, ReturnType<typeof getSichuanWaits>>();
    for (const index of nonPigs) waits.set(index, getSichuanWaits(names(players[index].hand), publicMelds(players[index]), players[index].missingSuit!));
    const ready = nonPigs.filter(index => (waits.get(index)?.length ?? 0) > 0), notReady = active.filter(index => !ready.includes(index));
    for (const pig of pigs) for (const other of nonPigs) transfer(pig, other, 16, 'flower-pig');
    for (const payer of nonPigs.filter(index => !ready.includes(index))) for (const recipient of ready)
      transfer(payer, recipient, Math.max(...waits.get(recipient)!.map(wait => wait.points)), 'ready');
    for (const entry of kongLedger) if (!entry.refunded && notReady.includes(entry.to)) { transfer(entry.to, entry.from, entry.points, 'kong-refund'); entry.refunded = true; }
    settlement = Object.freeze({ reason: 'wall-exhausted', readyActorIds: Object.freeze(ready.map(index => players[index].actorId)), flowerPigActorIds: Object.freeze(pigs.map(index => players[index].actorId)) });
  }
  function performExchange() {
    const outgoing = players.map(player => {
      const counts = SICHUAN_SUITS.map((_, suit) => player.hand.filter(tile => Math.floor(tile / 9) === suit).length);
      const suit = counts.map((count, index) => ({ count, index })).filter(item => item.count >= 3).sort((a, b) => a.count - b.count || a.index - b.index)[0].index;
      return player.hand.filter(tile => Math.floor(tile / 9) === suit).slice(0, 3);
    });
    for (let index = 0; index < 4; index++) for (const tile of outgoing[index]) removeTiles(players[index].hand, tile, 1);
    for (let giver = 0; giver < 4; giver++) players[(giver + exchangeDirection) % 4].hand.push(...outgoing[giver]);
    for (const player of players) player.hand.sort((a, b) => a - b); nextPhase('dingque');
  }
  function declareMissing() {
    for (const player of players) {
      const counts = SICHUAN_SUITS.map((suit, index) => ({ suit, count: player.hand.filter(tile => Math.floor(tile / 9) === index).length, index }));
      player.missingSuit = counts.sort((a, b) => a.count - b.count || a.index - b.index)[0].suit;
    }
    turn = dealer; holdFromDraw = true; nextPhase('hold');
  }
  function chooseDiscard(player: SichuanPlayer) {
    const forced = player.hand.filter(tile => isMissing(player, tile)), hand = forced.length ? forced : player.hand, counts = countsOf(player.hand), scores = new Map<number, number>();
    for (const tile of hand) if (!scores.has(tile)) {
      const rank = tile % 9; let value = counts[tile] === 1 ? 12 : counts[tile] === 2 ? -2 : -13;
      if (rank === 0 || rank === 8) value++;
      for (const offset of [-2, -1, 1, 2]) if (rank + offset >= 0 && rank + offset <= 8 && counts[tile + offset] > 0) value -= Math.abs(offset) === 1 ? 5 : 2;
      scores.set(tile, value);
    }
    const max = Math.max(...scores.values()), choices = [...scores].filter(([, value]) => value === max).map(([tile]) => tile).sort((a, b) => a - b);
    return choices[choices.length > 1 ? randomIndex(choices.length) : 0];
  }
  function claimDiscard() {
    const pending = discard;
    if (!pending) { const next = nextActive(turn); if (next !== null) turn = next; nextPhase('draw'); return null; }
    const order = activeOthers(pending.from);
    const winners = order.flatMap(index => { const score = winScore(index, pending.tile, { kongDiscard: pending.kongDiscard, lastTile: pending.lastTile, earthly: pending.earthly }); return score ? [{ index, points: score.points }] : []; });
    if (winners.length) return queueWinners(winners, pending.tile, pending.from, 'discard');
    const kong = wall.length > 0 ? order.find(index => !isMissing(players[index], pending.tile) && players[index].melds.length < 4 && countsOf(players[index].hand)[pending.tile] >= 3) : undefined;
    const pung = kong === undefined ? order.find(index => !isMissing(players[index], pending.tile) && players[index].melds.length < 4 && countsOf(players[index].hand)[pending.tile] >= 2) : undefined;
    const claimant = kong ?? pung;
    if (claimant !== undefined) {
      const isKong = kong !== undefined; players[pending.from].discards.pop(); removeTiles(players[claimant].hand, pending.tile, isKong ? 3 : 2);
      players[claimant].melds.push({ kind: isKong ? 'kong' : 'pung', tiles: Array(isKong ? 4 : 3).fill(pending.tile) });
      anyMeld = true; turn = claimant; discard = null; supplement = isKong; holdFromDraw = false; lastDrawnTile = null; lastDrawAfterKong = lastDrawWasLastTile = false;
      if (isKong) transfer(pending.from, claimant, 2, 'exposed-kong');
      nextPhase(isKong ? 'draw' : 'hold'); return emit(isKong ? 'kong' : 'pung', claimant, pending.tile, isKong ? '杠' : '碰', { fromActorId: players[pending.from].actorId });
    }
    const next = nextActive(pending.from); if (next !== null) turn = next; discard = null; lastDrawnTile = null; lastDrawAfterKong = lastDrawWasLastTile = false; nextPhase('draw'); return null;
  }
  function advance(): HomeMahjongGameEvent | null {
    if (phase === 'exchange') { performExchange(); return null; }
    if (phase === 'dingque') { declareMissing(); return null; }
    if (phase === 'win') {
      const pending = pendingWins.shift();
      if (pending) { turn = pending.actor; nextPhase('win'); return emit('win', pending.actor, pending.tile, pending.text, pending.metadata); }
      if (players.filter(player => player.won).length >= 3) {
        status = 'won'; settlement = Object.freeze({ reason: 'three-winners', readyActorIds: Object.freeze([]), flowerPigActorIds: Object.freeze([]) }); nextPhase('ended'); return null;
      }
      const next = nextActive(resumeFrom); if (next !== null) turn = next; nextPhase('draw'); return null;
    }
    const player = players[turn];
    if (phase === 'draw') {
      const afterKong = supplement, tile = wall.shift();
      if (tile === undefined) { settleWall(); status = 'exhausted'; nextPhase('ended'); return emit('exhausted', turn, null, '流局'); }
      player.hand.push(tile); player.hand.sort((a, b) => a - b); lastDrawnTile = tile; lastDrawAfterKong = afterKong; lastDrawWasLastTile = wall.length === 0; supplement = false;
      holdFromDraw = true; nextPhase('hold'); return emit('draw', turn, tile, HOME_MAHJONG_GAME_TILES[tile], afterKong ? { afterKong: true } : {});
    }
    if (phase === 'hold') {
      const score = holdFromDraw ? winScore(turn, null, { selfDraw: true, afterKong: lastDrawAfterKong, lastTile: lastDrawWasLastTile,
        heavenly: turn === dealer && discardCount === 0 && !anyMeld }) : null;
      if (score) return queueWinners([{ index: turn, points: score.points }], lastDrawnTile, turn, 'self', lastDrawAfterKong);
      const added = holdFromDraw && wall.length > 0 ? player.melds.find(meld => meld.kind === 'pung' && !isMissing(player, meld.tiles[0]) && player.hand.includes(meld.tiles[0])) : undefined;
      if (added) {
        const tile = added.tiles[0], from = turn;
        const winners = activeOthers(from).flatMap(index => { const result = winScore(index, tile, { robbedKong: true, lastTile: lastDrawWasLastTile }); return result ? [{ index, points: result.points }] : []; });
        if (winners.length) { removeTiles(player.hand, tile, 1); player.discards.push(tile); return queueWinners(winners, tile, from, 'rob'); }
        removeTiles(player.hand, tile, 1); added.kind = 'kong'; added.tiles.push(tile); anyMeld = true;
        for (const other of activeOthers(turn)) transfer(other, turn, 1, 'added-kong');
        supplement = true; lastDrawnTile = null; lastDrawAfterKong = lastDrawWasLastTile = false; nextPhase('draw'); return emit('kong', turn, tile, '杠');
      }
      const quad = holdFromDraw && wall.length > 0 && player.melds.length < 4 ? countsOf(player.hand).findIndex((count, tile) => count === 4 && !isMissing(player, tile)) : -1;
      if (quad >= 0) {
        removeTiles(player.hand, quad, 4); player.melds.push({ kind: 'kong', concealed: true, tiles: Array(4).fill(quad) }); anyMeld = true;
        for (const other of activeOthers(turn)) transfer(other, turn, 2, 'concealed-kong');
        supplement = true; lastDrawnTile = null; lastDrawAfterKong = lastDrawWasLastTile = false; nextPhase('draw'); return emit('kong', turn, quad, '杠');
      }
      const tile = chooseDiscard(player); removeTiles(player.hand, tile, 1); player.discards.push(tile);
      discard = { tile, from: turn, kongDiscard: lastDrawAfterKong, lastTile: lastDrawWasLastTile, earthly: discardCount === 0 && turn === dealer && !anyMeld };
      discardCount++; nextPhase('discard'); return emit('discard', turn, tile, HOME_MAHJONG_GAME_TILES[tile]);
    }
    if (phase === 'discard') { nextPhase('claim'); return null; }
    if (phase === 'claim') return claimDiscard(); return null;
  }
  function step(input: HomeMahjongGameStep): Readonly<{ snapshot: HomeMahjongGameSnapshot; event: HomeMahjongGameEvent | null }> {
    if (disposed) return Object.freeze({ snapshot: current, event: null });
    const actors = orderedActors(input.actors), nextScope = actors ? JSON.stringify(actors) : null;
    if (!actors) { if (scope !== null || players.length) resetState(); lastElapsed = null; return Object.freeze({ snapshot: current, event: null }); }
    if (scope !== null && scope !== nextScope) { resetState(); scope = nextScope; return Object.freeze({ snapshot: current, event: null }); } scope = nextScope;
    if (!Number.isFinite(input.elapsed) || input.elapsed < 0 || !input.enabled || !input.moving || input.busy) { lastElapsed = null; return Object.freeze({ snapshot: current, event: null }); }
    if (status === 'waiting') { begin(actors); lastElapsed = input.elapsed; return Object.freeze({ snapshot: current, event: null }); }
    if (status !== 'playing') { lastElapsed = input.elapsed; return Object.freeze({ snapshot: current, event: null }); }
    const before = lastElapsed; lastElapsed = input.elapsed;
    if (before === null || input.elapsed <= before || input.elapsed - before > .75) return Object.freeze({ snapshot: current, event: null });
    phaseElapsed += Math.min(.1, input.elapsed - before); let event: HomeMahjongGameEvent | null = null;
    if (phaseElapsed + 1e-9 >= PHASE_SECONDS[phase]) { event = advance(); revision++; } publish(); return Object.freeze({ snapshot: current, event });
  }
  return { step, getSnapshot: () => current, reset() { if (!disposed) resetState(); }, dispose() { disposed = true; lastElapsed = null; } };
}
/** The original 136-tile table remains available; Sichuan is an explicit local profile. */
export function createHomeMahjongGame(options: HomeMahjongGameOptions = {}) {
  if (options.rules !== undefined && options.rules !== 'basic' && options.rules !== 'sichuan') throw new RangeError('不支持的本地麻将桌规');
  return options.rules === 'sichuan' ? createSichuanHomeMahjongGame(options) : createBasicHomeMahjongGame(options);
}
