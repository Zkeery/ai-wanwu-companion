import type { GatheringArea } from './gatherings';

export type HomeWorldView = 'overview' | GatheringArea;
type Point = { x: number; y: number; z: number };
type Camera = { target: [number, number, number]; position: [number, number, number]; minDistance: number; maxDistance: number };

/** One continuous house plan. Every existing furniture/character coordinate stays local. */
export const HOME_WORLD_REGIONS: Record<GatheringArea, { label: string; center: Point; radius: number }> = {
  indoor: { label: '客厅', center: { x: -5.65, y: 0, z: -4.2 }, radius: 7 },
  bedroom: { label: '卧室', center: { x: 5.65, y: 0, z: -4.2 }, radius: 7 },
  outdoor: { label: '院子', center: { x: 0, y: 0, z: 4.1 }, radius: 7 },
};

export function homeWorldPoint(area: GatheringArea, local: Point): Point {
  const center = HOME_WORLD_REGIONS[area].center;
  return { x: center.x + local.x, y: center.y + local.y, z: center.z + local.z };
}

/** Presets fit the three-dimensional floor plan; orbit/zoom belongs to the caller. */
export function homeWorldCamera(view: HomeWorldView): Camera {
  if (view === 'overview') return { target: [0, .8, -.3], position: [17, 18, 23], minDistance: 14, maxDistance: 80 };
  if (view === 'outdoor') return { target: [0, .75, 4.8], position: [9.6, 10.05, 18.96], minDistance: 7, maxDistance: 36 };
  const { x, y, z } = HOME_WORLD_REGIONS[view].center;
  return { target: [x, y + .75, z - .3], position: [x + 8, y + 8.5, z + 11.5], minDistance: 6, maxDistance: 30 };
}
