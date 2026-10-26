/** Visual-only, regional navigation. No business commands, network or cross-door travel. */
export type NavPoint = Readonly<{ x: number; z: number }>;
export type NavOccupied = Readonly<{ position: NavPoint; radius: number }>;
export type NavBounds = Readonly<{ minX: number; maxX: number; minZ: number; maxZ: number }>;
export type NavClearance = number | Readonly<{ x: number; z: number }>;
export type NavigationBlocked = null | 'invalid-bounds' | 'no-safe-point' | 'no-path';
export type LivingNavigationRoute = Readonly<{
  points: readonly NavPoint[];
  cumulative: readonly number[];
  length: number;
  speed: number;
  seed: number;
  safeAnchor: NavPoint | null;
  anchorCorrected: boolean;
  blocked: NavigationBlocked;
  diagnostics: Readonly<{ nodeCount: number; componentSize: number; obstacleCount: number; step: number }>;
}>;
export type LivingNavigationSample = Readonly<{
  position: NavPoint | null;
  yaw: number;
  moving: boolean;
  blocked: NavigationBlocked;
  anchorCorrected: boolean;
}>;
export type LivingNavigationOptions = { bounds: NavBounds; blocked: readonly NavBounds[]; clearance: NavClearance; step?: number };
type Node = { point: NavPoint; links: number[]; component: number };
const EPSILON = 1e-6;
const MAX_NODES = 40_000;
const finite = (v: number) => Number.isFinite(v);
const distance = (a: NavPoint, b: NavPoint) => Math.hypot(a.x - b.x, a.z - b.z);
const same = (a: NavPoint, b: NavPoint) => distance(a, b) < EPSILON;
const point = (x: number, z: number): NavPoint => Object.freeze({ x, z });

function validBounds(b: NavBounds) {
  return !!b && [b.minX, b.maxX, b.minZ, b.maxZ].every(finite) && b.minX < b.maxX && b.minZ < b.maxZ;
}
function contains(b: NavBounds, p: NavPoint) {
  return p.x >= b.minX && p.x <= b.maxX && p.z >= b.minZ && p.z <= b.maxZ;
}
/** Inclusive slab intersection also rejects touching an expanded obstacle corner. */
function intersectsSegment(b: NavBounds, a: NavPoint, c: NavPoint) {
  let lo = 0, hi = 1;
  for (const [origin, delta, min, max] of [[a.x, c.x - a.x, b.minX, b.maxX], [a.z, c.z - a.z, b.minZ, b.maxZ]]) {
    if (Math.abs(delta) < EPSILON) { if (origin < min || origin > max) return false; }
    else {
      const v1 = (min - origin) / delta, v2 = (max - origin) / delta;
      lo = Math.max(lo, Math.min(v1, v2)); hi = Math.min(hi, Math.max(v1, v2));
      if (lo > hi) return false;
    }
  }
  return true;
}
function segmentDistance(a: NavPoint, b: NavPoint, p: NavPoint) {
  const dx = b.x - a.x, dz = b.z - a.z, squared = dx * dx + dz * dz;
  const t = squared > EPSILON * EPSILON ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.z - a.z) * dz) / squared)) : 0;
  return Math.hypot(a.x + dx * t - p.x, a.z + dz * t - p.z);
}
function disperse(index: number, seed: number) {
  let value = (index + Math.imul(seed, 0x9e3779b1)) >>> 0;
  value = Math.imul(value ^ (value >>> 16), 0x21f0aaad);
  value = Math.imul(value ^ (value >>> 15), 0x735a2d97);
  return (value ^ (value >>> 15)) >>> 0;
}
function seedFor(id: number | string) {
  const value = String(id).slice(0, 200); let hash = 2166136261;
  for (let i = 0; i < value.length; i++) { hash ^= value.charCodeAt(i); hash = Math.imul(hash, 16777619); }
  return hash >>> 0;
}

class Queue {
  private values: { id: number; score: number; cost: number }[] = [];
  get size() { return this.values.length; }
  private before(a: { id: number; score: number }, b: { id: number; score: number }) {
    return a.score < b.score || (a.score === b.score && a.id < b.id);
  }
  push(item: { id: number; score: number; cost: number }) {
    const values = this.values; values.push(item); let i = values.length - 1;
    while (i) { const parent = (i - 1) >> 1; if (!this.before(values[i], values[parent])) break; [values[i], values[parent]] = [values[parent], values[i]]; i = parent; }
  }
  pop() {
    const values = this.values, first = values[0], last = values.pop()!;
    if (values.length) {
      values[0] = last; let i = 0;
      for (;;) {
        const left = i * 2 + 1, right = left + 1; let best = i;
        if (left < values.length && this.before(values[left], values[best])) best = left;
        if (right < values.length && this.before(values[right], values[best])) best = right;
        if (best === i) break; [values[i], values[best]] = [values[best], values[i]]; i = best;
      }
    }
    return first;
  }
}

/** Build once per region/obstacle/footprint revision; sampling never rebuilds or searches. */
export function createLivingNavigation(options: LivingNavigationOptions) {
  const step = finite(options.step ?? .2) ? Math.max(.15, Math.min(.25, options.step ?? .2)) : .2;
  const clearance = typeof options.clearance === 'number' ? { x: options.clearance, z: options.clearance } : options.clearance;
  const valid = validBounds(options.bounds) && !!clearance && [clearance.x, clearance.z].every(v => finite(v) && v >= 0)
    && Array.isArray(options.blocked) && options.blocked.every(validBounds);
  const bounds: NavBounds = valid ? {
    minX: options.bounds.minX + clearance.x + EPSILON, maxX: options.bounds.maxX - clearance.x - EPSILON,
    minZ: options.bounds.minZ + clearance.z + EPSILON, maxZ: options.bounds.maxZ - clearance.z - EPSILON,
  } : { minX: 0, maxX: 0, minZ: 0, maxZ: 0 };
  const obstacles = valid ? options.blocked.map(b => ({
    minX: b.minX - clearance.x - EPSILON, maxX: b.maxX + clearance.x + EPSILON,
    minZ: b.minZ - clearance.z - EPSILON, maxZ: b.maxZ + clearance.z + EPSILON,
  })) : [];
  const safe = (p: NavPoint) => contains(bounds, p) && !obstacles.some(b => contains(b, p));
  const clear = (a: NavPoint, b: NavPoint) => safe(a) && safe(b) && !obstacles.some(o => intersectsSegment(o, a, b));
  const columns = validBounds(bounds) ? Math.ceil((bounds.maxX - bounds.minX) / step) : 0;
  const rows = validBounds(bounds) ? Math.ceil((bounds.maxZ - bounds.minZ) / step) : 0;
  const invalid = !valid || !columns || !rows || (columns + 1) * (rows + 1) > MAX_NODES;
  const nodes: Node[] = [], components: number[][] = [];
  if (!invalid) {
    const grid = new Int32Array((columns + 1) * (rows + 1)).fill(-1);
    const xStep = (bounds.maxX - bounds.minX) / columns, zStep = (bounds.maxZ - bounds.minZ) / rows;
    for (let z = 0; z <= rows; z++) for (let x = 0; x <= columns; x++) {
      const p = point(bounds.minX + x * xStep, bounds.minZ + z * zStep);
      if (safe(p)) { grid[z * (columns + 1) + x] = nodes.length; nodes.push({ point: p, links: [], component: -1 }); }
    }
    for (let z = 0; z <= rows; z++) for (let x = 0; x <= columns; x++) {
      const index = grid[z * (columns + 1) + x]; if (index < 0) continue;
      for (const [dx, dz] of [[1, 0], [0, 1], [1, 1], [-1, 1]]) {
        const nx = x + dx, nz = z + dz;
        if (nx < 0 || nx > columns || nz > rows) continue;
        const next = grid[nz * (columns + 1) + nx];
        if (next >= 0 && clear(nodes[index].point, nodes[next].point)) { nodes[index].links.push(next); nodes[next].links.push(index); }
      }
    }
    nodes.forEach((node, index) => {
      if (node.component >= 0) return;
      const component = components.length, members = [index]; node.component = component;
      for (let i = 0; i < members.length; i++) for (const next of nodes[members[i]].links) {
        if (nodes[next].component < 0) { nodes[next].component = component; members.push(next); }
      }
      components.push(members);
    });
  }
  function shortest(from: number, to: number, segmentClear = clear) {
    if (from === to) return [nodes[from].point];
    const costs = new Float64Array(nodes.length).fill(Infinity), previous = new Int32Array(nodes.length).fill(-1), queue = new Queue();
    costs[from] = 0; queue.push({ id: from, score: distance(nodes[from].point, nodes[to].point), cost: 0 });
    while (queue.size) {
      const item = queue.pop(); if (item.cost !== costs[item.id]) continue;
      if (item.id === to) {
        const path = [nodes[to].point]; let at = to;
        while (at !== from) { at = previous[at]; if (at < 0) return []; path.push(nodes[at].point); }
        return path.reverse();
      }
      for (const next of nodes[item.id].links) {
        if (!segmentClear(nodes[item.id].point, nodes[next].point)) continue;
        const cost = item.cost + distance(nodes[item.id].point, nodes[next].point);
        if (cost + EPSILON < costs[next]) { costs[next] = cost; previous[next] = item.id; queue.push({ id: next, cost, score: cost + distance(nodes[next].point, nodes[to].point) }); }
      }
    }
    return [];
  }
  // Smooth individual legs only: smoothing a closed tour as one leg would collapse it to its start.
  function smooth(path: NavPoint[], segmentClear = clear) {
    if (path.length < 3) return path;
    const result = [path[0]]; let at = 0;
    while (at < path.length - 1) {
      let next = path.length - 1; while (next > at + 1 && !segmentClear(path[at], path[next])) next--;
      result.push(path[next]); at = next;
    }
    return result;
  }
  const cache = new Map<string, LivingNavigationRoute>();
  function plan({ anchor, id, avoid }: { anchor: NavPoint; id: number | string; avoid?: readonly NavOccupied[] }): LivingNavigationRoute {
    const dynamic = !!avoid?.length;
    const peersValid = !dynamic || avoid!.every(p => !!p?.position && [p.position.x, p.position.z, p.radius].every(finite) && p.radius >= 0);
    const peers = peersValid && dynamic ? [...avoid!].sort((a, b) => a.position.x - b.position.x || a.position.z - b.position.z || a.radius - b.radius) : [];
    const radius = Math.max(clearance?.x ?? 0, clearance?.z ?? 0);
    const peerClear = (a: NavPoint, b: NavPoint) => peersValid && peers.every(p => segmentDistance(a, b, p.position) >= radius + p.radius + .035 - EPSILON);
    const segmentClear = dynamic ? (a: NavPoint, b: NavPoint) => clear(a, b) && peerClear(a, b) : clear;
    const safePoint = dynamic ? (p: NavPoint) => safe(p) && peerClear(p, p) : safe;
    const key = `${String(id)}:${anchor.x}:${anchor.z}:${dynamic ? peersValid ? JSON.stringify(peers) : 'invalid-peers' : ''}`;
    const cached = cache.get(key); if (cached) return cached;
    const seed = seedFor(id), speed = .34 + (seed % 37) / 370;
    let safeAnchor: NavPoint | null = null, anchorCorrected = false, blocked: NavigationBlocked = null, componentSize = 0;
    const points: NavPoint[] = [];
    if (invalid || ![anchor.x, anchor.z].every(finite)) blocked = 'invalid-bounds';
    else {
      const clamped = point(Math.max(bounds.minX, Math.min(bounds.maxX, anchor.x)), Math.max(bounds.minZ, Math.min(bounds.maxZ, anchor.z)));
      if (dynamic) { safeAnchor = point(anchor.x, anchor.z); if (!safePoint(anchor)) blocked = 'no-path'; }
      else if (safe(clamped)) safeAnchor = clamped;
      const ordered = nodes.map((n, index) => ({ index, d: distance(n.point, safeAnchor ?? anchor) })).filter(n => !dynamic || safePoint(nodes[n.index].point))
        .sort((a, b) => a.d - b.d || a.index - b.index);
      if (!safeAnchor && ordered.length) safeAnchor = nodes[ordered[0].index].point;
      anchorCorrected = !!safeAnchor && !same(safeAnchor, anchor);
      if (!safeAnchor) blocked = 'no-safe-point';
      else if (!blocked) {
        points.push(safeAnchor);
        const start = ordered.find(entry => segmentClear(safeAnchor!, nodes[entry.index].point))?.index;
        if (start === undefined) blocked = 'no-path';
        else {
          let members = components[nodes[start].component];
          if (dynamic) {
            members = [start]; const reached = new Set(members);
            for (let i = 0; i < members.length; i++) for (const next of nodes[members[i]].links) {
              if (!reached.has(next) && segmentClear(nodes[members[i]].point, nodes[next].point)) { reached.add(next); members.push(next); }
            }
          }
          componentSize = members.length;
          const targets: number[] = [];
          // A seeded triangular tour; A* handles concave/disconnected free space between targets.
          for (let direction = 0; direction < 3; direction++) {
            const angle = (seed / 0x100000000 + direction / 3) * Math.PI * 2;
            let target: number = start, score = -Infinity;
            for (const index of members) {
              const p = nodes[index].point, dx = p.x - safeAnchor.x, dz = p.z - safeAnchor.z;
              const value = dx * Math.cos(angle) + dz * Math.sin(angle) + Math.hypot(dx, dz) * .08;
              if (value > score) { target = index; score = value; }
            }
            if (!targets.includes(target) && target !== start) targets.push(target);
          }
          if (!same(safeAnchor, nodes[start].point)) points.push(nodes[start].point);
          let at = start;
          for (const target of [...targets, start]) {
            const leg = shortest(at, target, segmentClear);
            if (!leg.length) { blocked = 'no-path'; break; }
            for (const p of smooth(leg, segmentClear)) if (!same(points[points.length - 1], p)) points.push(p);
            at = target;
          }
          if (!blocked && !same(points[points.length - 1], safeAnchor)) points.push(safeAnchor);
          else points[points.length - 1] = safeAnchor; // Exact closure prevents a floating-point seam at each lap.
          if (points.length < 3) blocked = 'no-path';
        }
      }
    }
    const cumulative = [0]; for (let i = 1; i < points.length; i++) cumulative.push(cumulative[i - 1] + distance(points[i - 1], points[i]));
    const length = points.length ? cumulative[cumulative.length - 1] : 0;
    if (!blocked && length < EPSILON) blocked = 'no-path';
    const route: LivingNavigationRoute = Object.freeze({ points: Object.freeze(points), cumulative: Object.freeze(cumulative), length,
      speed, seed, safeAnchor, anchorCorrected, blocked,
      diagnostics: Object.freeze({ nodeCount: nodes.length, componentSize, obstacleCount: obstacles.length, step }) });
    cache.set(key, route); if (cache.size > 128) cache.delete(cache.keys().next().value!);
    return route;
  }
  /** A one-way journey preserves both supplied endpoints exactly; it never projects an unsafe endpoint. */
  function planTo({ from, to, id, avoid }: { from: NavPoint; to: NavPoint; id: number | string; avoid?: readonly NavOccupied[] }): LivingNavigationRoute {
    const validPoint = (p: NavPoint) => !!p && [p.x, p.z].every(finite);
    const peersValid = avoid === undefined || Array.isArray(avoid) && avoid.every(p => !!p?.position && [p.position.x, p.position.z, p.radius].every(finite) && p.radius >= 0);
    const peers = peersValid ? (avoid ?? []).map(p => ({ position: point(p.position.x, p.position.z), radius: p.radius }))
      .sort((a, b) => a.position.x - b.position.x || a.position.z - b.position.z || a.radius - b.radius) : [];
    const radius = Math.max(clearance?.x ?? 0, clearance?.z ?? 0);
    const segmentClear = (a: NavPoint, b: NavPoint) => peersValid && clear(a, b) && peers.every(p => segmentDistance(a, b, p.position) >= radius + p.radius + .035 - EPSILON);
    const idValid = typeof id === 'string' || typeof id === 'number' && finite(id);
    const seed = idValid ? seedFor(id) : 0, speed = .34 + (seed % 37) / 370;
    let blocked: NavigationBlocked = null, safeAnchor: NavPoint | null = null, componentSize = 0;
    let points: NavPoint[] = [];
    if (invalid || !validPoint(from) || !validPoint(to) || !peersValid || !idValid) blocked = 'invalid-bounds';
    else {
      if (segmentClear(from, from)) safeAnchor = point(from.x, from.z);
      if (!safeAnchor || !segmentClear(to, to)) blocked = 'no-safe-point';
      else if (from.x === to.x && from.z === to.z) points = [safeAnchor];
      else if (segmentClear(from, to)) points = [safeAnchor, point(to.x, to.z)];
      else {
        const starts = nodes.map((n, index) => ({ index, distance: distance(from, n.point) })).filter(n => segmentClear(from, nodes[n.index].point))
          .sort((a, b) => a.distance - b.distance || a.index - b.index);
        const goals = nodes.map((n, index) => ({ index, distance: distance(to, n.point) })).filter(n => segmentClear(nodes[n.index].point, to))
          .sort((a, b) => a.distance - b.distance || a.index - b.index);
        const visited = new Set<number>();
        for (const start of starts) {
          if (visited.has(start.index)) continue;
          // Dynamic occupied discs can split a formerly connected static grid.
          const members = [start.index]; visited.add(start.index);
          for (let i = 0; i < members.length; i++) for (const next of nodes[members[i]].links) {
            if (!visited.has(next) && segmentClear(nodes[members[i]].point, nodes[next].point)) { visited.add(next); members.push(next); }
          }
          componentSize = Math.max(componentSize, members.length);
          const component = new Set(members), goal = goals.find(g => component.has(g.index));
          if (!goal) continue;
          const leg = shortest(start.index, goal.index, segmentClear);
          if (!leg.length) continue;
          const joined = [safeAnchor, ...leg, point(to.x, to.z)].filter((p, i, all) => !i || p.x !== all[i - 1].x || p.z !== all[i - 1].z);
          points = smooth(joined, segmentClear);
          break;
        }
        if (!points.length) blocked = 'no-path';
      }
    }
    const cumulative = points.length ? [0] : [];
    for (let i = 1; i < points.length; i++) cumulative.push(cumulative[i - 1] + distance(points[i - 1], points[i]));
    return Object.freeze({ points: Object.freeze(points), cumulative: Object.freeze(cumulative), length: cumulative[cumulative.length - 1] ?? 0,
      speed, seed, safeAnchor, anchorCorrected: false, blocked,
      diagnostics: Object.freeze({ nodeCount: nodes.length, componentSize, obstacleCount: obstacles.length, step }) });
  }
  /** Only for initial/revised visual placement; saved business anchors are never changed. */
  function findSafePoint(anchor: NavPoint, occupied: readonly NavOccupied[], preferenceSeed = 0, reachableFrom?: NavPoint, preferLargestComponent = false) {
    if (invalid || ![anchor.x, anchor.z, preferenceSeed].every(finite) || !occupied.every(p => !!p?.position && [p.position.x, p.position.z, p.radius].every(finite) && p.radius >= 0)) return null;
    const radius = Math.max(clearance.x, clearance.z);
    if(reachableFrom&&(![reachableFrom.x,reachableFrom.z].every(finite)||!safe(reachableFrom)))return null;
    const largestComponent=components.reduce((best,members,index)=>members.length>(components[best]?.length??0)?index:best,0);
    const largestReachable=(p:NavPoint,component?:number)=>!preferLargestComponent||(component!==undefined?component===largestComponent:nodes.some(n=>n.component===largestComponent&&clear(p,n.point)));
    const reachable=reachableFrom?new Set(nodes.filter(n=>clear(reachableFrom,n.point)).map(n=>n.component)):null;
    const connected=(p:NavPoint,component?:number)=>!reachableFrom||!!reachable&&(component!==undefined?reachable.has(component):clear(reachableFrom,p)||nodes.some(n=>reachable.has(n.component)&&clear(p,n.point)));
    const free = (p: NavPoint,component?:number) => safe(p) && connected(p,component) && largestReachable(p,component) && occupied.every(other => distance(p, other.position) >= radius + other.radius + .04);
    if (preferenceSeed === 0 && free(anchor)) return point(anchor.x, anchor.z);
    if (preferenceSeed !== 0) {
      const ordered = nodes.map((node, i) => ({ node, rank: disperse(i, preferenceSeed) })).sort((a, b) => a.rank - b.rank);
      return ordered.find(({ node }) => free(node.point,node.component))?.node.point ?? null;
    }
    let best: NavPoint | null = null, score = Infinity;
    for (const node of nodes) { const d = distance(node.point, anchor); if (d < score && free(node.point,node.component)) { best = node.point; score = d; } }
    return best;
  }
  return Object.freeze({ plan, planTo, findSafePoint, clearanceRadius: Math.max(clearance?.x ?? 0, clearance?.z ?? 0), isSegmentClear: (a: NavPoint, b: NavPoint) => !invalid && [a.x, a.z, b.x, b.z].every(finite) && clear(a, b) });
}
export type LivingNavigation = ReturnType<typeof createLivingNavigation>;

/** Deterministic retries choose only statically safe graph nodes, never overlapping fallbacks. */
export function allocateLivingNavigationAnchors(
  actors: readonly { id: number | string; anchor: NavPoint; radius: number; graph: LivingNavigation; reachableFrom?:NavPoint; roaming?:boolean }[],
  fixedOccupied: readonly NavOccupied[] = [],
): Map<number | string, NavPoint | null> {
  const ordered = [...actors].sort((a, b) => typeof a.id === 'number' && typeof b.id === 'number' ? a.id - b.id : String(a.id).localeCompare(String(b.id), 'en'));
  let best = new Map<number | string, NavPoint | null>(), bestCount = -1;
  for (let attempt = 0; attempt < 256; attempt++) {
    const occupied = [...fixedOccupied], current = new Map<number | string, NavPoint | null>(); let count = 0;
    for (const actor of ordered) {
      const valid = finite(actor.radius) && actor.radius >= 0 && actor.graph.clearanceRadius + EPSILON >= actor.radius;
      const candidate = valid ? actor.graph.findSafePoint(actor.anchor, occupied, attempt, actor.reachableFrom, actor.roaming) : null;
      current.set(actor.id, candidate);
      if (candidate) { occupied.push({ position: candidate, radius: actor.radius }); count++; }
    }
    if (count > bestCount) { best = current; bestCount = count; }
    if (count === ordered.length) break;
  }
  return best;
}

/** Feed a frozen elapsed time while paused. Every sample stays on a previously swept-safe segment. */
export function sampleLivingNavigation(route: LivingNavigationRoute, elapsedSeconds: number, walking = true): LivingNavigationSample {
  const result = (position: NavPoint | null, yaw = 0, moving = false): LivingNavigationSample => ({
    position, yaw, moving, blocked: route.blocked, anchorCorrected: route.anchorCorrected,
  });
  if (route.blocked || route.length < EPSILON || route.points.length < 2) return result(route.safeAnchor);
  const time = Number.isFinite(elapsedSeconds) ? Math.max(0, elapsedSeconds) : 0;
  const travelled = (time * route.speed) % route.length;
  let low = 1, high = route.cumulative.length - 1;
  while (low < high) { const mid = (low + high) >> 1; if (route.cumulative[mid] < travelled) low = mid + 1; else high = mid; }
  const a = route.points[low - 1], b = route.points[low], segment = route.cumulative[low] - route.cumulative[low - 1];
  const fraction = segment > EPSILON ? (travelled - route.cumulative[low - 1]) / segment : 0;
  return result(point(a.x + (b.x - a.x) * fraction, a.z + (b.z - a.z) * fraction), Math.atan2(b.x - a.x, b.z - a.z), walking);
}

/** One-way sampling never wraps to the start when the destination is reached. */
export function sampleLivingJourney(route: LivingNavigationRoute, elapsedSeconds: number, moving = true): LivingNavigationSample {
  const result = (position: NavPoint | null, yaw = 0, walking = false): LivingNavigationSample => ({ position, yaw, moving: walking, blocked: route.blocked, anchorCorrected: route.anchorCorrected });
  if (route.blocked || !route.points.length || !finite(elapsedSeconds) || elapsedSeconds < 0 || !finite(route.speed) || route.speed <= 0) return result(route.safeAnchor);
  if (route.points.length === 1 || route.length === 0) return result(route.points[0]);
  const travelled = Math.min(route.length, elapsedSeconds * route.speed);
  let low = 1, high = route.cumulative.length - 1;
  while (low < high) { const mid = (low + high) >> 1; if (route.cumulative[mid] < travelled) low = mid + 1; else high = mid; }
  const a = route.points[low - 1], b = route.points[low], segment = route.cumulative[low] - route.cumulative[low - 1];
  const fraction = segment > 0 ? (travelled - route.cumulative[low - 1]) / segment : 0;
  const position = travelled === route.length ? route.points[route.points.length - 1] : point(a.x + (b.x - a.x) * fraction, a.z + (b.z - a.z) * fraction);
  return result(position, Math.atan2(b.x - a.x, b.z - a.z), moving && travelled < route.length);
}

/** Follow actual forward progress around route corners, including a sideways passing manoeuvre. */
export function advanceLivingNavigationPhase(route: LivingNavigationRoute, elapsed: number, position: NavPoint, horizonSeconds = .75): number {
  if (route.blocked || route.length < EPSILON || route.speed <= 0 || ![elapsed, position.x, position.z].every(finite)) return elapsed;
  const start = Math.max(0, elapsed) * route.speed, end = start + Math.max(0, horizonSeconds) * route.speed;
  const current = sampleLivingNavigation(route, elapsed).position;
  if (!current) return elapsed;
  let bestArc = start, bestDistance = distance(current, position);
  const lap = Math.floor(start / route.length);
  for (let turn = lap; turn <= lap + 1; turn++) for (let i = 1; i < route.points.length; i++) {
    const begin = turn * route.length + route.cumulative[i - 1], finish = turn * route.length + route.cumulative[i];
    if (finish <= start || begin >= end || finish - begin < EPSILON) continue;
    const a = route.points[i - 1], b = route.points[i], dx = b.x - a.x, dz = b.z - a.z;
    const projection = ((position.x - a.x) * dx + (position.z - a.z) * dz) / (dx * dx + dz * dz);
    const fraction = Math.max(Math.max(0, (start - begin) / (finish - begin)), Math.min(Math.min(1, (end - begin) / (finish - begin)), projection));
    const candidate = point(a.x + dx * fraction, a.z + dz * fraction), d = distance(candidate, position), arc = begin + fraction * (finish - begin);
    if (d < bestDistance - EPSILON || Math.abs(d - bestDistance) < EPSILON && arc < bestArc) { bestDistance = d; bestArc = arc; }
  }
  return Math.max(elapsed, bestArc / route.speed);
}
