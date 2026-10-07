import { expect, it } from 'vitest';
import { residencePresence } from '@/lib/residence-presence';
import type { CharacterOverview, LivingSpace, SpaceMember } from '@/lib/contracts';

const space: LivingSpace = { id: 'shared-1', scene_type: 'home', mode: 'shared', companion_id: null, revision: 2, observed_at: 1, items: [], can_undo: false };
const members: SpaceMember[] = [{ companion_id: '1', name: '小满' }, { companion_id: '2', name: '小树' }, { companion_id: '3', name: '果果' }];
function overview(id: number, place: string | null, gathering = false): CharacterOverview {
  return { character: { id, name: ['小满', '小树', '果果'][id - 1], persona: '', opening_line: '', image_path: null, status: 'ready', created_at: '' },
    residence: place ? { space_id: place, scene_type: 'home', mode: 'shared' } : null,
    gathering: gathering ? { id: 'team-1', title: '小队庭院' } : null,
    last_interaction_at: null, recent_activity: [] };
}

it('shows only verified residents, while preserving an absent member and gathering fact', () => {
  const facts = [overview(1, space.id), overview(2, null, true), overview(3, 'other-space')];
  const result = residencePresence(space, members, facts, 2);
  expect(result.occupants.map(character => character.id)).toEqual([1]);
  expect(result.viewed?.gathering?.id).toBe('team-1');
  expect(facts[1].residence).toBeNull();
});

it('keeps two same-account roommates distinct when both really live there', () => {
  const result = residencePresence(space, members, [overview(2, space.id), overview(1, space.id)], 1);
  expect(result.occupants.map(character => character.id)).toEqual([1, 2]);
});
