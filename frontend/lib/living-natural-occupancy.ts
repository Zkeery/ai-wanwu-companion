import type { Gathering } from './gatherings';
import { naturalHousePlan } from './living-natural-house';

/** Local synthetic presentation only. Existing activities and persisted coordinates are never rewritten. */
export function naturalHouseAssignments(gathering: Gathering) {
  if (gathering.scene_type !== 'forest' && gathering.scene_type !== 'desert') return { seats: [], beds: [], blockedIds: [] as number[] };
  const plan = naturalHousePlan(gathering.scene_type);
  const companions = [...gathering.companions].sort((a,b) => a.id-b.id);
  const resting = companions.filter(c => c.activity === 'rest');
  const sleeping = companions.filter(c => c.activity === 'sleep');
  return {
    seats: resting.slice(0,plan.restSeats.length).map((c,index) => ({ ...plan.restSeats[index], characterId: c.id, index })),
    beds: sleeping.slice(0,plan.beds.length).map((c,index) => ({ ...plan.beds[index], characterId: c.id })),
    blockedIds: [...resting.slice(plan.restSeats.length), ...sleeping.slice(plan.beds.length)].map(c => c.id),
  };
}

export function naturalActivityCapacity(gathering: Gathering, actorId: number, activity: string): boolean {
  if (!gathering.companions.some(c => c.id === actorId) || !['forest','desert'].includes(gathering.scene_type)) return false;
  if (activity !== 'rest' && activity !== 'sleep') return ['walk','observe','talk'].includes(activity);
  const plan = naturalHousePlan(gathering.scene_type as 'forest'|'desert');
  const occupied = gathering.companions.filter(c => c.id !== actorId && c.activity === activity).length;
  return occupied < (activity === 'rest' ? plan.restSeats.length : plan.beds.length);
}
