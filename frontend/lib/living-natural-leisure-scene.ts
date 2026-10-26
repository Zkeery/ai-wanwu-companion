import * as T from 'three';
import type { Gathering } from './gatherings';
import type { HomeLeisureSeat, HomeLeisureSnapshot } from './living-home-leisure';
import type { HomeMaterialLibrary, HomeMaterialRole } from './living-home-materials';
import { collectNaturalNavigationObstacles } from './living-natural-navigation';
import { naturalHousePlan } from './living-natural-house';
import { createLivingNavigation } from './living-navigation';

export type NaturalLeisureSeat = HomeLeisureSeat & Readonly<{ approach: Readonly<{ x: number; z: number }>; support: readonly string[] }>;
type RawSeat = Readonly<{ id: string; x: number; y: number; z: number; yaw: number; approach: Readonly<{ x: number; z: number }>; support: readonly string[]; cupId: string }>;

/** A new, explicitly opt-in station. Existing native props and saved item transforms stay untouched. */
export function buildNaturalLeisureScene(scene: 'forest' | 'desert', surfaces: HomeMaterialLibrary): T.Group {
  const root = new T.Group(), prefix = 'natural-' + scene;
  root.name = 'home-farmhouse-tea-table'; root.position.set(-1, 0, 2.7);
  root.userData.homeLeisure = 'tea'; root.userData.naturalLeisureScene = scene;
  const mesh = (parent: T.Object3D, name: string, geometry: T.BufferGeometry, role: HomeMaterialRole, color: string, x = 0, y = 0, z = 0) => {
    surfaces.uv(geometry, role); const value = new T.Mesh(geometry, surfaces.material(role, color, scene + '-tea-' + role));
    value.name = name; value.position.set(x, y, z); value.castShadow = value.receiveShadow = true;
    value.userData.homeMaterialOwnerId = surfaces.ownerId; value.userData.homeMaterialRole = role; parent.add(value); return value;
  };
  const wood = scene === 'forest' ? '#877252' : '#9a805d', fabric = scene === 'forest' ? '#a3aa8d' : '#b5a88d';
  const body = new T.Group(); body.name = prefix + '-tea-table-body'; body.userData.naturalNavObstacle = true; root.add(body);
  mesh(body, prefix + '-tea-table-top', new T.CylinderGeometry(.58, .58, .065, 32), 'wood', wood, 0, .6475, 0);
  for (const x of [-.32, .32]) for (const z of [-.25, .25]) mesh(body, prefix + '-tea-table-leg-' + x + '-' + z, new T.BoxGeometry(.07, .615, .07), 'wood', wood, x, .3075, z);
  const pot = new T.Group(); pot.name = prefix + '-teapot'; pot.position.set(0, .68, 0); body.add(pot);
  mesh(pot, prefix + '-teapot-body', new T.LatheGeometry([new T.Vector2(0, 0), new T.Vector2(.105, 0), new T.Vector2(.14, .09), new T.Vector2(.105, .19), new T.Vector2(.05, .20)], 20), 'plaster', '#8f9480');
  mesh(pot, prefix + '-teapot-lid', new T.CylinderGeometry(.10, .105, .018, 20), 'plaster', '#8f9480', 0, .205, 0);
  mesh(pot, prefix + '-teapot-knob', new T.SphereGeometry(.025, 10, 8), 'wood', wood, 0, .235, 0);
  const handle = mesh(pot, prefix + '-teapot-handle', new T.TorusGeometry(.085, .016, 6, 16), 'wood', wood, -.12, .11, 0); handle.scale.x = .70;
  const spout = mesh(pot, prefix + '-teapot-spout', new T.CylinderGeometry(.02, .035, .14, 12), 'plaster', '#8f9480', .12, .135, 0); spout.rotation.z = -.65;
  pot.userData.homeTeaSteamAnchor = { x: .12 + Math.sin(.65) * .07, y: .135 + Math.cos(.65) * .07 + .02, z: 0 };
  const slots: RawSeat[] = [];
  for (let index = 0; index < 2; index++) {
    const sign = index ? 1 : -1, x = sign * 1.55, stool = new T.Group(); stool.name = prefix + '-tea-stool-' + index; stool.position.set(x, 0, 0); stool.userData.naturalNavObstacle = true; root.add(stool);
    mesh(stool, stool.name + '-seat', new T.CylinderGeometry(.36, .36, .065, 24), 'wood', wood, 0, .4325, 0);
    mesh(stool, stool.name + '-cushion', new T.CylinderGeometry(.34, .34, .035, 24), 'fabric', fabric, 0, .4825, 0);
    for (const dx of [-.21, .21]) for (const dz of [-.21, .21]) mesh(stool, stool.name + '-leg-' + dx + '-' + dz, new T.BoxGeometry(.06, .4, .06), 'wood', wood, dx, .2, dz);
    const cupId = prefix + '-teacup-' + index;
    const cup = mesh(body, cupId, new T.LatheGeometry([new T.Vector2(.034, 0), new T.Vector2(.052, .083), new T.Vector2(.045, .083), new T.Vector2(.028, .016), new T.Vector2(0, .016)], 16), 'plaster', '#d5d0b9', sign * .28, .68, .12);
    cup.userData.homeTeaCup = true; cup.userData.homeTeaCupGrip = { x: 0, y: .0415, z: 0 };
    slots.push({ id: prefix + '-tea-' + index, x, y: .5, z: 0, yaw: -sign * Math.PI / 2, approach: { x: x + sign * 1.4, z: 0 }, support: [stool.name], cupId });
  }
  root.userData.homeLeisureSeats = slots; root.updateMatrixWorld(true); return root;
}

/** Resolve exact physical seats; an obstructing saved item disables the new station rather than moving that item. */
export function collectNaturalLeisureSeats(world: T.Object3D | null, items: T.Object3D | null, g: Gathering, snapshot?: HomeLeisureSnapshot, clearance = .9): NaturalLeisureSeat[] {
  if (!world || !['forest', 'desert'].includes(g.scene_type) || world.userData.naturalScene !== g.scene_type) return [];
  const scene = g.scene_type as 'forest' | 'desert', result: NaturalLeisureSeat[] = [], benches: T.Object3D[] = [];
  world.updateWorldMatrix(true, true); items?.updateWorldMatrix(true, true);
  items?.traverse(o => { if (o.userData.homeRestKind === 'bench' || o.userData.naturalItemKind === 'bench') benches.push(o); });
  for (const [index, bench] of benches.entries()) {
    const identity = String(bench.userData.homeItemId ?? index);
    bench.userData.naturalLeisureSupportId = 'natural-' + scene + '-bench-' + identity;
    bench.userData.homeLeisure = 'bench';
    bench.userData.naturalNavObstacle = true;
  }
  const obstacles = collectNaturalNavigationObstacles(world, items), bounds = naturalHousePlan(scene).bounds.outdoor;
  const nav = (support: readonly string[], clearance: number) => createLivingNavigation({ bounds, blocked: obstacles.filter(o => !support.includes(o.source)), clearance });
  const reservation = (id: string) => snapshot?.assignments.find(a => a.seatId === id)?.actorId;
  const worldYaw = (o: T.Object3D, yaw: number) => { const d = new T.Vector3(Math.sin(yaw), 0, Math.cos(yaw)).transformDirection(o.matrixWorld); return Math.atan2(d.x, d.z); };
  const safe = (seat: Pick<NaturalLeisureSeat, 'x' | 'z' | 'approach' | 'support'>) => {
    const standing = nav(seat.support, clearance), contact = nav(seat.support, clearance * .9);
    return standing.isSegmentClear(seat.approach, seat.approach) && contact.isSegmentClear(seat, seat);
  };
  world.traverse(station => {
    if (station.userData.homeLeisure !== 'tea' || station.userData.naturalLeisureScene !== scene || !Array.isArray(station.userData.homeLeisureSeats)) return;
    const table = station.getObjectByName('natural-' + scene + '-tea-table-body'), tableBox = table ? new T.Box3().setFromObject(table, true) : null;
    const obstructed = !!tableBox && (items?.children.some(item => tableBox.intersectsBox(new T.Box3().setFromObject(item, true))) ?? false);
    for (const raw of station.userData.homeLeisureSeats as RawSeat[]) {
      const p = station.localToWorld(new T.Vector3(raw.x, raw.y, raw.z)), approach = station.localToWorld(new T.Vector3(raw.approach.x, 0, raw.approach.z));
      const slot: NaturalLeisureSeat = { id: raw.id, station: 'tea', area: 'outdoor', x: p.x, y: p.y, z: p.z, yaw: worldYaw(station, raw.yaw), approach: { x: approach.x, z: approach.z }, support: [...raw.support], physicalId: raw.id, cupId: raw.cupId, ...(reservation(raw.id) ? { reservedByActorId: reservation(raw.id) } : {}) };
      const cup = world.getObjectByName(raw.cupId), held = snapshot?.assignments.some(a => a.activity === 'tea' && a.seatId === raw.id) ?? false;
      result.push({ ...slot, available: !obstructed && (!!cup || held) && safe(slot) });
    }
  });
  for (const bench of benches) {
    const id = bench.userData.naturalLeisureSupportId as string;
    const raw = (bench.userData.homeRestSeats?.[0] as { x?: number; y?: number; z?: number; yaw?: number } | undefined) ?? (scene === 'desert' ? { x: 0, y: .5075, z: 0, yaw: Math.PI } : undefined);
    if (!raw || ![raw.x, raw.y, raw.z, raw.yaw ?? 0].every(Number.isFinite)) continue;
    const rawYaw = raw.yaw ?? 0;
    const p = bench.localToWorld(new T.Vector3((raw.x ?? 0) + Math.sin(rawYaw) * .16, raw.y, (raw.z ?? 0) + Math.cos(rawYaw) * .16)), yaw = worldYaw(bench, rawYaw);
    const slot: NaturalLeisureSeat = { id, station: 'bench', area: 'outdoor', x: p.x, y: p.y, z: p.z, yaw, physicalId: id, approach: { x: p.x + Math.sin(yaw) * 1.4, z: p.z + Math.cos(yaw) * 1.4 }, support: [id], ...(reservation(id) ? { reservedByActorId: reservation(id) } : {}) };
    result.push({ ...slot, available: safe(slot) });
  }
  return result;
}
