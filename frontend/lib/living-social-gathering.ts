import type { Gathering, GatheringArea } from './gatherings';
import type { LivingNavigation, NavBounds, NavOccupied, NavPoint } from './living-navigation';

export type SocialActor = { id: number; area: GatheringArea; radius: number; from?: NavPoint };
export type SocialSlot = { id: number; area: GatheringArea; position: NavPoint; center: NavPoint; yaw: number; group: string; members: number[]; stationary?: true; sightRequired?: true };
export type SocialPlan = Map<number, SocialSlot>;

/** One shared, deterministic circle. Never scatter members into unrelated safe corners. */
export function planSocialGathering(actors: readonly SocialActor[], boundsFor: (area: GatheringArea) => NavBounds,
  graphFor: (area: GatheringArea, radius: number) => LivingNavigation, occupied: (area: GatheringArea) => readonly NavOccupied[],
  canSee?: (a: SocialActor, b: SocialActor) => boolean,
  canMeetAt?: (a: SocialActor, b: SocialActor) => boolean): SocialPlan {
  const result: SocialPlan = new Map();
  for (const area of ['outdoor', 'indoor', 'bedroom'] as const) {
    const members = actors.filter(a => a.area === area && Number.isFinite(a.radius) && a.radius > 0).sort((a, b) => a.id - b.id);
    if (members.length < 2 || members.length > 10) continue;
    const bounds = boundsFor(area), radius = Math.max(...members.map(a => a.radius));
    const circle = Math.max(1.15, (2 * radius + .3) / (2 * Math.sin(Math.PI / members.length)));
    const middle = { x: (bounds.minX + bounds.maxX) / 2, z: (bounds.minZ + bounds.maxZ) / 2 };
    const offsets = [{ x: 0, z: 0 }, ...[1.5, 3].flatMap(d => [{ x: d, z: 0 }, { x: -d, z: 0 }, { x: 0, z: d }, { x: 0, z: -d }])];
    for (const offset of offsets) {
      const center = { x: middle.x + offset.x, z: middle.z + offset.z }, used = [...occupied(area)];
      const slots: SocialSlot[] = [];
      for (const [index, actor] of members.entries()) {
        const angle = index * Math.PI * 2 / members.length;
        const ideal = { x: center.x + Math.sin(angle) * circle, z: center.z + Math.cos(angle) * circle };
        const graph = graphFor(area, actor.radius), position = graph.findSafePoint(ideal, used);
        if (!position || Math.hypot(position.x - ideal.x, position.z - ideal.z) > .35 || !graph.isSegmentClear(position, center)) break;
        // A clear circle is not enough: furniture can split the open yard into
        // separate regions. Reach every slot from this member's real safe pose.
        if (actor.from) {
          const route = graph.planTo({ from: actor.from, to: position, id: actor.id, avoid: occupied(area) });
          if (route.blocked || !route.points.length || Math.hypot(route.points[0].x - actor.from.x, route.points[0].z - actor.from.z) > 1e-7
            || Math.hypot(route.points.at(-1)!.x - position.x, route.points.at(-1)!.z - position.z) > 1e-7) break;
        }
        slots.push({ id: actor.id, area, position, center, yaw: Math.atan2(center.x - position.x, center.z - position.z),
          group: area + ':' + members.map(m => m.id).join(','), members: members.map(m => m.id) });
        used.push({ position, radius: actor.radius });
      }
      if (slots.length !== members.length) continue;
      slots.forEach(slot => result.set(slot.id, slot)); break;
    }
    // Two neighbours can already be having a conversation across a low table or
    // stool. They need safe bodies and a clear eye line, not a walk to the empty
    // centre of an ideal circle. Keep these real poses; never pull actors through
    // furniture, relax their body radius, or join distant/disconnected corners.
    if (!members.some(actor => result.has(actor.id)) && members.length === 2 && canSee) {
      const [a, b] = members;
      if (!a.from || !b.from || ![a.from.x, a.from.z, b.from.x, b.from.z].every(Number.isFinite)) continue;
      const distance = Math.hypot(a.from.x - b.from.x, a.from.z - b.from.z);
      // The preferred circle adds comfort space; neighbours already standing
      // safely may chat with the same .04 body gap used by navigation.
      const safeNeighbours = distance >= a.radius + b.radius + .04 && distance <= circle * 2 && members.every(actor => {
        const graph = graphFor(area, actor.radius), safe = graph.findSafePoint(actor.from!, occupied(area));
        return !!safe && Math.hypot(safe.x - actor.from!.x, safe.z - actor.from!.z) < 1e-7
          && graph.isSegmentClear(actor.from!, actor.from!);
      });
      if (safeNeighbours && canSee(a, b)) {
        const center = { x: (a.from.x + b.from.x) / 2, z: (a.from.z + b.from.z) / 2 };
        members.forEach(actor => result.set(actor.id, { id: actor.id, area, position: { ...actor.from! }, center,
          yaw: Math.atan2(center.x - actor.from!.x, center.z - actor.from!.z),
          group: area + ':' + members.map(m => m.id).join(','), members: members.map(m => m.id), stationary: true }));
      }
    }
    // A furnished yard may have no empty circle, while one partner can safely
    // walk beside the other. Keep the waiting body in place and prove the whole
    // route plus the final eye line; never teleport to a saved business anchor.
    if (!members.some(actor => result.has(actor.id)) && members.length === 2 && canMeetAt
      && members.every(actor => actor.from && [actor.from.x, actor.from.z].every(Number.isFinite))) {
      const candidates: Array<{ positions: NavPoint[]; length: number }> = [];
      for (const fixedIndex of [0, 1]) {
        const movingIndex = 1 - fixedIndex, fixed = members[fixedIndex], moving = members[movingIndex];
        const peers = occupied(area), fixedGraph = graphFor(area, fixed.radius), graph = graphFor(area, moving.radius);
        if (!fixedGraph.isSegmentClear(fixed.from!, fixed.from!)
          || peers.some(peer => Math.hypot(fixed.from!.x - peer.position.x, fixed.from!.z - peer.position.z) < fixed.radius + peer.radius + .04)) continue;
        const avoid = [...peers, { position: fixed.from!, radius: fixed.radius }];
        const position = graph.findSafePoint(fixed.from!, avoid, 0, moving.from!);
        if (!position) continue;
        const distance = Math.hypot(position.x - fixed.from!.x, position.z - fixed.from!.z);
        if (distance < moving.radius + fixed.radius + .04 || distance > circle * 2) continue;
        const route = graph.planTo({ from: moving.from!, to: position, id: moving.id, avoid });
        if (route.blocked || !route.points.length || Math.hypot(route.points[0].x - moving.from!.x, route.points[0].z - moving.from!.z) > 1e-7
          || Math.hypot(route.points.at(-1)!.x - position.x, route.points.at(-1)!.z - position.z) > 1e-7) continue;
        const positions = members.map((actor, index) => index === movingIndex ? position : actor.from!);
        if (!canMeetAt({ ...members[0], from: positions[0] }, { ...members[1], from: positions[1] })) continue;
        candidates.push({ positions, length: route.length });
      }
      candidates.sort((a, b) => a.length - b.length);
      const chosen = candidates[0];
      if (chosen) {
        const center = { x: (chosen.positions[0].x + chosen.positions[1].x) / 2, z: (chosen.positions[0].z + chosen.positions[1].z) / 2 };
        members.forEach((actor, index) => result.set(actor.id, { id: actor.id, area, position: chosen.positions[index], center,
          yaw: Math.atan2(center.x - chosen.positions[index].x, center.z - chosen.positions[index].z),
          group: area + ':' + members.map(m => m.id).join(','), members: members.map(m => m.id), sightRequired: true }));
      }
    }
  }
  return result;
}

export function socialGroupReady(slot: SocialSlot, plan: SocialPlan,
  actual: (id: number) => { x: number; z: number; area: string; moving: boolean; upstairs: boolean } | null): boolean {
  return slot.members.every(id => {
    const target = plan.get(id), pose = actual(id);
    return !!target && !!pose && !pose.moving && !pose.upstairs && pose.area === slot.area
      && Math.hypot(pose.x - target.position.x, pose.z - target.position.z) < .24;
  });
}

const HOME_LINES = [
  '你喜欢在这里待着吗？', '喜欢，和大家在一起很自在。',
  '今天想聊点什么？', '随便聊聊就好，不用着急。',
  '要不要听听大家的想法？', '好呀，我也想听你说说。',
  '我们下次也一起过来吧。', '好，就这样约好了。',
];
const NATURE_LINES = ['你想先看看哪边？', '先在这里和大家聊一会儿吧。', '有大家陪着，感觉挺好。', '我也是，慢慢来就好。'];
export type SocialTurn = { key: string; actorId: number; text: string; kind: 'preset' };
/** Preset social captions use only shared activity metadata, never private chat or memory. */
export function socialGatheringTurn(g: Gathering, slot: SocialSlot, now: number): SocialTurn | null {
  if (!Number.isFinite(now) || now < 0 || slot.members.length < 2) return null;
  const event = g.events.findLast(e => e.kind === 'activity' && e.activity === 'talk' && e.area === slot.area
    && e.characters.some(id => slot.members.includes(id)) && Number.isFinite(e.at));
  const elapsed = now - (event?.at ?? 0); if (elapsed < 0) return null;
  const turn = Math.floor(elapsed / 6), lines = g.scene_type === 'home' ? HOME_LINES : NATURE_LINES;
  return { key: 'preset-social:' + g.id + ':' + slot.group + ':' + (event?.at ?? 0) + ':' + turn,
    actorId: slot.members[turn % slot.members.length], text: lines[turn % lines.length], kind: 'preset' };
}
