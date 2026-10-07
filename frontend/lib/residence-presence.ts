import type { CharacterOverview, LivingSpace, SpaceMember } from './contracts';

export function residencePresence(
  space: LivingSpace,
  members: SpaceMember[],
  overviews: CharacterOverview[],
  viewedId: number,
) {
  const allowed = new Set(space.mode === 'private'
    ? [space.companion_id]
    : members.map(member => member.companion_id));
  const occupants = overviews.filter(item => allowed.has(String(item.character.id)) &&
    item.residence?.space_id === space.id).map(item => item.character).sort((a, b) => a.id - b.id);
  const viewed = overviews.find(item => item.character.id === viewedId) ?? null;
  return { occupants, viewed };
}
