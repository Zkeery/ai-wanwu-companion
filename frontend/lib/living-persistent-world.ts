import type { Gathering } from './gatherings';
import type { HomeLeisureActivity, HomeLeisureSeat } from './living-home-leisure';

export type LivingLeisureRequest = { activity: HomeLeisureActivity | null; actorId: number; seatId?: string };

/** A rendering opt-in, never a model or service authorization. Writes still use owner-checked APIs. */
export function persistentLivingScope(g: Gathering, enabled?: boolean): boolean {
  return enabled === true && !g.closed && !!g.id && !!g.me && ['home', 'forest', 'desert'].includes(g.scene_type)
    && g.members.some(member => member.id === g.me)
    && g.companions.every(c => Number.isSafeInteger(c.id) && c.id > 0 && g.members.some(member => member.id === c.owner_id));
}

export function planLivingLeisure(g: Gathering, seats: readonly HomeLeisureSeat[], activity: HomeLeisureActivity | null,
  actorId?: number): LivingLeisureRequest | null {
  const actor = actorId === undefined ? g.companions.find(c => c.owner_id === g.me && (activity !== null || c.leisure))
    : g.companions.find(c => c.id === actorId);
  if (!actor || actor.owner_id !== g.me || g.closed) return null;
  if (activity === null) return actor.leisure ? { activity: null, actorId: actor.id } : null;
  if (g.scene_type !== 'home' && activity !== 'tea' && activity !== 'bench') return null;
  const used = new Set(g.companions.filter(c => c.id !== actor.id && c.leisure).map(c => {
    const seat = seats.find(s => s.id === c.leisure!.seat_id); return seat?.physicalId ?? c.leisure!.seat_id;
  }));
  const candidates = seats.filter(s => s.station === activity && s.available !== false
    && (s.reservedByActorId === undefined || s.reservedByActorId === actor.id) && !used.has(s.physicalId ?? s.id)
    && !g.companions.some(c => c.id !== actor.id && c.leisure && seats.some(occupied => occupied.id === c.leisure!.seat_id
      && Math.hypot(occupied.x - s.x, occupied.z - s.z) < 1.25)));
  const seat = candidates.find(s => actor.leisure?.seat_id === s.id) ?? [...candidates].sort((a, b) => a.id.localeCompare(b.id, 'en'))[0];
  return seat ? { activity, actorId: actor.id, seatId: seat.id } : null;
}
