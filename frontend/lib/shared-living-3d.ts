import { activityEvidence, companionPosition, gatheringCompanionArea, type Gathering } from './gatherings';

export type Avatar3D = {
  version: 1; kind: 'cup' | 'bouquet' | 'plant' | 'fruit' | 'garment' | 'creature' | 'unavailable';
  body: string; accent: string; detail: string; seed: number; source: 'procedural_existing_features';
};
const kinds = ['cup', 'bouquet', 'plant', 'fruit', 'garment', 'creature', 'unavailable'];
export function parseAvatar3D(value: unknown, id: number): Avatar3D {
  const empty: Avatar3D = { version: 1, kind: 'unavailable', body: '#d5d9cd', accent: '#b7cbb7', detail: '#42483e', seed: id >>> 0, source: 'procedural_existing_features' };
  if (!value || typeof value !== 'object' || Array.isArray(value)) return empty;
  const v = value as Record<string, unknown>;
  if (v.version !== 1 || typeof v.kind !== 'string' || !kinds.includes(v.kind) || v.source !== 'procedural_existing_features'
    || !['body', 'accent', 'detail'].every(k => typeof v[k] === 'string' && /^#[a-f0-9]{6}$/i.test(v[k] as string))
    || typeof v.seed !== 'number' || !Number.isInteger(v.seed) || v.seed < 0 || v.seed > 0xffffffff) return empty;
  return { version: 1, kind: v.kind as Avatar3D['kind'], body: v.body as string, accent: v.accent as string, detail: v.detail as string, seed: v.seed, source: 'procedural_existing_features' };
}
const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));
export function worldAnchor(g: Gathering, id: number): { x: number; z: number } | null {
  const p = companionPosition(g, id);
  if (!p) return null;
  return { x: clamp((parseFloat(p.left) - 49) / 9.75, -4, 4), z: clamp((parseFloat(p.top) - 38.6) / 10.5, -2.8, 2.8) };
}
export function sampleLivingPose(g: Gathering, id: number, nowSeconds: number, animate: boolean) {
  const c = g.companions.find(c => c.id === id), anchor = worldAnchor(g, id);
  if (!c || !anchor) return null;
  const seed = (id % 97) * 0.71, evidence = activityEvidence(g, id);
  const t = animate && Number.isFinite(nowSeconds) ? nowSeconds - (evidence?.at ?? 0) : 0;
  const phase = animate ? t * 2.3 + seed : 0;
  const pose = { ...anchor, y: 0, yaw: 0, lean: 0, stride: 0, arm: 0, rest: c.activity === 'rest' || c.activity === 'sleep', sleeping: c.activity === 'sleep', blink: false, talkingTo: null as number | null };
  if (c.activity === 'talk') {
    const peer = g.companions.filter(p => p.id !== id && p.activity === 'talk' && gatheringCompanionArea(g, p) === gatheringCompanionArea(g, c)).sort((a, b) => {
      const pa = worldAnchor(g, a.id)!, pb = worldAnchor(g, b.id)!;
      return Math.hypot(pa.x - anchor.x, pa.z - anchor.z) - Math.hypot(pb.x - anchor.x, pb.z - anchor.z) || a.id - b.id;
    })[0];
    if (peer) { const p = worldAnchor(g, peer.id)!; pose.yaw = Math.atan2(p.x - anchor.x, p.z - anchor.z); pose.talkingTo = peer.id; }
    if (animate) { pose.arm = Math.sin(phase) * 0.3; pose.lean = Math.sin(phase * .55) * .045; }
  } else if (c.activity === 'walk' && animate) {
    // A small gait loop visualizes the saved activity; no position is written back.
    pose.x = clamp(anchor.x + Math.cos(t * .6 + seed) * .24, -4, 4);
    pose.z = clamp(anchor.z + Math.sin(t * .6 + seed) * .18, -2.8, 2.8);
    pose.yaw = Math.atan2(-Math.sin(t * .6 + seed), Math.cos(t * .6 + seed));
    pose.y = Math.abs(Math.sin(phase * 1.7)) * .035;
    pose.stride = Math.sin(phase * 1.7) * .4; pose.arm = -pose.stride * .65;
  } else if (c.activity === 'observe' && animate) {
    pose.yaw = Math.sin(phase * .17) * .55; pose.lean = Math.sin(phase * .3) * .04;
  } else if (c.activity === 'arriving' && animate && evidence && t >= 0 && t < 1.5) {
    pose.y = Math.sin(t / 1.5 * Math.PI) * .09; pose.arm = Math.sin(t * 5) * .25;
  }
  if (animate && ['walk', 'observe', 'talk', 'arriving', 'rest', 'sleep'].includes(c.activity)) {
    pose.blink = ['rest', 'sleep'].includes(c.activity) || (t + seed) % 5.3 < .16;
  }
  return pose;
}
