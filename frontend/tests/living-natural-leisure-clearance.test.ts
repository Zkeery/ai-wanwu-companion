import * as T from 'three';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseGathering } from '../lib/gatherings';
import { createHomeMaterials } from '../lib/living-home-materials';
import { buildForestEnvironment, buildForestItem } from '../lib/living-forest-world';
import { buildDesertEnvironment, buildDesertItem } from '../lib/living-desert-world';
import { collectNaturalLeisureSeats } from '../lib/living-natural-leisure-scene';
import { collectNaturalNavigationObstacles } from '../lib/living-natural-navigation';
import { naturalHousePlan } from '../lib/living-natural-house';
import { createLivingNavigation } from '../lib/living-navigation';
import { disposeLivingObject } from '../lib/living-world-engine';

type Scene = 'forest' | 'desert';
const roots: T.Object3D[] = [];
const keep = <O extends T.Object3D>(object: O): O => { roots.push(object); return object; };
const gathering = (scene: Scene) => parseGathering({
  id: 'synthetic-natural-clearance', title: '体型与实体座位校验', scene_type: scene,
  revision: 1, closed: false, is_manager: true, me: 'owner', members: [], companions: [],
  items: [], votes: [], events: [], stories: [], goal: null, story_enabled: false,
  season: { current_season: 'summer' },
});
const environment = (scene: Scene) => keep(scene === 'forest'
  ? buildForestEnvironment(null, { indoor: true, leisure: true })
  : buildDesertEnvironment(null, { indoor: true, leisure: true }));

beforeEach(() => { vi.spyOn(T.TextureLoader.prototype, 'load').mockImplementation(() => new T.Texture()); });
afterEach(() => { for (const root of roots.splice(0)) disposeLivingObject(root); vi.restoreAllMocks(); });

describe.each(['forest', 'desert'] as const)('%s leisure uses the requested body clearance', scene => {
  it('retains default .9m compatibility without changing seat identity or geometry', () => {
    const world = environment(scene), items = keep(new T.Group()), g = gathering(scene);
    world.updateMatrixWorld(true);
    const before = new Map<string, number[]>();
    world.traverse(object => before.set(object.uuid, object.matrixWorld.toArray()));
    const implicit = collectNaturalLeisureSeats(world, items, g);
    const explicit = collectNaturalLeisureSeats(world, items, g, undefined, .9);
    expect(explicit).toEqual(implicit);
    expect(explicit.filter(seat => seat.station === 'tea')).toHaveLength(2);
    expect(explicit.filter(seat => seat.station === 'tea').every(seat => seat.available)).toBe(true);
    world.traverse(object => expect(object.matrixWorld.toArray(), object.name).toEqual(before.get(object.uuid)));
  });

  it('rejects a wider body at the real tea-table contact instead of reusing the small seated radius', () => {
    const world = environment(scene), items = keep(new T.Group()), g = gathering(scene);
    const small = collectNaturalLeisureSeats(world, items, g, undefined, .9).filter(seat => seat.station === 'tea');
    const large = collectNaturalLeisureSeats(world, items, g, undefined, 1.3).filter(seat => seat.station === 'tea');
    expect(small).toHaveLength(2); expect(large).toHaveLength(2);
    expect(small.every(seat => seat.available)).toBe(true);
    expect(large.every(seat => seat.available === false)).toBe(true);
    const obstacles = collectNaturalNavigationObstacles(world, items);
    for (const seat of large) {
      // The requested full-size body is 1.3m and its actual seated scale is .9.
      const blocked = obstacles.filter(obstacle => !seat.support.includes(obstacle.source));
      const contact = createLivingNavigation({ bounds: naturalHousePlan(scene).bounds.outdoor, blocked, clearance: 1.3 * .9 });
      expect(contact.isSegmentClear(seat, seat), seat.id).toBe(false);
      const original = small.find(value => value.id === seat.id)!;
      expect({ ...seat, available: original.available }).toEqual(original);
    }
  });

  it('rejects a wide actor in a narrow physical saved-bench approach, while the previous body fits', () => {
    const world = keep(new T.Group()), items = keep(new T.Group()), materials = createHomeMaterials();
    world.userData.naturalScene = scene;
    const bench = scene === 'forest' ? buildForestItem('bench', null, materials) : buildDesertItem('bench', null, materials);
    bench.userData.homeItemId = 'narrow-existing-bench'; items.add(bench);
    // Real walls provide 2.1m between their inner surfaces. They are not mocked navigation boxes.
    for (const sign of [-1, 1]) {
      const wall = new T.Mesh(new T.BoxGeometry(.1, 1.8, 6), new T.MeshStandardMaterial());
      wall.name = 'existing-narrow-wall-' + sign; wall.position.set(sign * 1.1, .9, 0);
      wall.userData.naturalNavObstacle = true; world.add(wall);
    }
    items.updateMatrixWorld(true); const original = bench.matrixWorld.toArray(), g = gathering(scene);
    const small = collectNaturalLeisureSeats(world, items, g, undefined, .9);
    const large = collectNaturalLeisureSeats(world, items, g, undefined, 1.2);
    expect(small).toHaveLength(1); expect(large).toHaveLength(1);
    expect(small[0].station).toBe('bench'); expect(small[0].available).toBe(true);
    expect(large[0].available).toBe(false); expect(large[0].id).toBe(small[0].id);
    const blocked = collectNaturalNavigationObstacles(world, items).filter(obstacle => !large[0].support.includes(obstacle.source));
    const standing = createLivingNavigation({ bounds: naturalHousePlan(scene).bounds.outdoor, blocked, clearance: 1.2 });
    expect(standing.isSegmentClear(large[0].approach, large[0].approach)).toBe(false);
    expect(bench.matrixWorld.toArray()).toEqual(original);
  });
});
