import { imageUrl, type Character, type LivingSpace } from './contracts';
import { sceneNames } from './contracts';
import type { Gathering } from './gatherings';
import type { Season } from './seasons';

export function hasPersistentLivingWorld(space: LivingSpace): boolean {
  return space.mode === 'private' && !!space.owner_id?.trim() && !!space.world && typeof space.resident_here === 'boolean' && Number.isSafeInteger(Number(space.companion_id)) && Number(space.companion_id) > 0;
}

export function privateLivingWorld(space: LivingSpace, present: readonly Character[], season: Season | null): Gathering | null {
  if (!hasPersistentLivingWorld(space)) return null;
  const owner = space.owner_id!, resident = space.resident_here === true ? present.find(c => String(c.id) === space.companion_id && c.status === 'ready') : undefined;
  const portrait = resident ? imageUrl(resident.image_path) : null;
  return {
    id: space.id, title: sceneNames[space.scene_type], scene_type: space.scene_type, revision: space.revision,
    closed: false, is_manager: true, me: owner, invitation: null, dialogue_enabled: false,
    members: [{ id: owner, name: '我', manager: true }],
    companions: resident ? [{ id: resident.id, name: resident.name, owner_id: owner, activity: space.world!.activity,
      area: space.world!.area, x: .5, y: .5, dialogue_allowed: false,
      ...(space.avatar3d ? { avatar3d: space.avatar3d } : {}),
      ...(portrait ? { portrait } : {}),
      ...(space.world!.leisure ? { leisure: { ...space.world!.leisure } } : {}),
    }] : [],
    items: space.items.filter(item => !item.stored).map(item => ({ id: item.id, kind: item.kind, x: item.x, y: item.y,
      flipped: !!item.flipped, mine: true, contributor_name: '我', growth_status: item.growth_status })),
    votes: [], events: [], story_enabled: false, stories: [], goal: null, season,
  };
}

export function sameLivingWorld(before: LivingSpace, after: LivingSpace): boolean {
  return hasPersistentLivingWorld(after) && before.id === after.id && before.owner_id === after.owner_id &&
    before.companion_id === after.companion_id && before.scene_type === after.scene_type && before.mode === after.mode;
}
