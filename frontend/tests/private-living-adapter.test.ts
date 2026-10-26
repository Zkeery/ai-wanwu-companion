import { expect, it } from 'vitest';
import { parseLivingSpace, type Character, type LivingSpace } from '@/lib/contracts';
import { hasPersistentLivingWorld, privateLivingWorld, sameLivingWorld } from '@/lib/living';

const person: Character = { id: 1, name: '旧伙伴', persona: '不得投影的私人性格', opening_line: '不得投影的开场白', image_path: '/private.png', status: 'ready', created_at: '' };
const base: LivingSpace = { id: 'actual-private-space', owner_id: 'actual-owner', companion_id: '1', mode: 'private', scene_type: 'home', revision: 5, observed_at: 100,
  resident_here: true,
  can_undo: true, world: { activity: 'rest', area: 'indoor' }, avatar3d: { version: 1, kind: 'cup', body: '#eeeeee', accent: '#aaaaaa', detail: '#333333', seed: 1, source: 'procedural_existing_features' },
  items: [{ id: 'saved-tree', kind: 'tree', x: .12345, y: .76543, stored: false, flipped: true, growth_seconds: 6, stage: 'planted', care_remaining_seconds: 0, growth_status: 'needs_care' },
    { id: 'stored-tree', kind: 'tree', x: .9, y: .1, stored: true, growth_seconds: 0, stage: 'planted', care_remaining_seconds: null, growth_status: 'stored' }] };

it.each(['home', 'forest', 'desert'] as const)('%s keeps the real identity, saved coordinates, flip and safe avatar projection', scene_type => {
  const source = { ...base, scene_type }, before = JSON.stringify(source), result = privateLivingWorld(source, [person], 'autumn')!;
  expect(result.id).toBe(source.id); expect(result.id.startsWith('synthetic-')).toBe(false); expect(result.me).toBe(source.owner_id);
  expect(result.items).toEqual([{ id: 'saved-tree', kind: 'tree', x: .12345, y: .76543, flipped: true, mine: true, contributor_name: '我', growth_status: 'needs_care' }]);
  expect(result.companions[0]).toMatchObject({ id: 1, owner_id: 'actual-owner', activity: 'rest', area: 'indoor', avatar3d: source.avatar3d, dialogue_allowed: false });
  expect(result.season).toBe('autumn'); expect(result.events).toEqual([]); expect(result.dialogue_enabled).toBe(false);
  expect(JSON.stringify(result)).not.toContain(person.persona); expect(JSON.stringify(result)).not.toContain(person.opening_line); expect(JSON.stringify(result)).not.toContain(person.image_path);
  expect(JSON.stringify(source)).toBe(before);
});
it('does not invent an occupant when the resident is away, failed, or another companion is supplied', () => {
  for (const present of [[], [{ ...person, id: 2 }], [{ ...person, status: 'failed' as const }]]) expect(privateLivingWorld(base, present, null)?.companions).toEqual([]);
});
it('uses an explicit resident_here signal and retains an empty home when the resident is away', () => {
  const away = { ...base, resident_here: false };
  expect(hasPersistentLivingWorld(away)).toBe(true); expect(privateLivingWorld(away, [person], null)?.companions).toEqual([]);
  expect(privateLivingWorld(away, [person], null)?.items).toHaveLength(1);
  expect(privateLivingWorld({ ...away, resident_here: true }, [person], null)?.companions).toHaveLength(1);
});
it('does not infer presence from owner, avatar or supplied character when resident_here is absent', () => {
  const unknown = { ...base }; delete unknown.resident_here;
  expect(hasPersistentLivingWorld(unknown)).toBe(false); expect(privateLivingWorld(unknown, [person], null)).toBeNull();
  expect(() => parseLivingSpace({ ...base, resident_here: 'true' })).toThrow();
  expect(parseLivingSpace(base).resident_here).toBe(true); expect(parseLivingSpace({ ...base, resident_here: false }).resident_here).toBe(false);
});
it('does not replace an unavailable avatar with an arbitrary generated body', () => {
  expect(privateLivingWorld({ ...base, avatar3d: null }, [person], null)?.companions[0].avatar3d).toBeUndefined();
});
it('projects a saved leisure overlay and leaves private history and layout untouched', () => {
  const leisure = { activity: 'tea' as const, seat_id: 'natural-tea-0', station_version: 1 as const };
  expect(privateLivingWorld({ ...base, world: { activity: 'observe', area: 'outdoor', leisure } }, [person], null)?.companions[0]).toMatchObject({ leisure });
});
it('retains the old editor when a trusted private world is absent', () => {
  for (const input of [{ ...base, mode: 'shared' as const }, { ...base, owner_id: undefined }, { ...base, world: undefined }, { ...base, companion_id: null }]) {
    expect(hasPersistentLivingWorld(input)).toBe(false); expect(privateLivingWorld(input, [person], null)).toBeNull();
  }
});
it('accepts only the same owner, companion and space after saving or reconciliation', () => {
  expect(sameLivingWorld(base, { ...base, revision: 6 })).toBe(true);
  for (const delta of [{ owner_id: 'another' }, { id: 'another' }, { companion_id: '2' }, { scene_type: 'forest' as const }, { world: undefined }]) expect(sameLivingWorld(base, { ...base, ...delta })).toBe(false);
});
it('parses the additive world fields while preserving a legacy space without them', () => {
  const parsed = parseLivingSpace(base); expect(parsed).toMatchObject({ owner_id: base.owner_id, world: base.world, avatar3d: base.avatar3d });
  const legacy = { ...base }; delete legacy.owner_id; delete legacy.world; delete legacy.avatar3d; delete legacy.resident_here;
  expect(parseLivingSpace(legacy)).not.toHaveProperty('world'); expect(parseLivingSpace(legacy).items[0].flipped).toBe(true);
});
it.each([{ activity: 'fly', area: 'outdoor' }, { activity: 'sleep', area: 'moon' }, { activity: 'walk', area: 'outdoor', leisure: { activity: 'tea', seat_id: '', station_version: 1 } },
  { activity: 'walk', area: 'outdoor', leisure: { activity: 'tea', seat_id: 'seat', station_version: 2 } }])('rejects a malformed persisted world instead of enabling controls', world => {
  expect(() => parseLivingSpace({ ...base, world })).toThrow();
});
it('rejects malformed avatar metadata without copying untrusted fields', () => {
  expect(() => parseLivingSpace({ ...base, avatar3d: { ...base.avatar3d, source: 'external', body: 'url()' } })).toThrow();
});
