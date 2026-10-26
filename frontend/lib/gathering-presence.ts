import { gatheringAreaNames, gatheringCompanionArea, type Gathering } from './gatherings';

export type GatheringCompanionPresence = Readonly<{ id: number; activityLabel: string; locationLabel: string }>;
export type GatheringFloorPresence = Readonly<{ id: number; phase: string; floor: number; activity: 'observe' | 'rest' | 'sleep' }>;
const activityNames: Record<string, string> = { arriving: '刚刚到达', rest: '休息', sleep: '睡觉', walk: '散步', observe: '观察', talk: '相聚', tea: '喝茶', television: '看电视', mahjong: '打麻将', bench: '长椅休息' };

export function describeCompanionPresence(gathering: Gathering, companion: Gathering['companions'][number], live: { floorVisit?: GatheringFloorPresence; activityLabel?: string; locationLabel?: string } = {}): GatheringCompanionPresence {
  const visit = live.floorVisit?.id === companion.id ? live.floorVisit : undefined;
  if (visit?.phase === 'upper') return { id: companion.id, activityLabel: { observe: '看风景', rest: '休息', sleep: '睡觉' }[visit.activity], locationLabel: '二楼' };
  if (visit && ['queued', 'approach', 'walking', 'waiting'].includes(visit.phase)) return { id: companion.id, activityLabel: visit.phase === 'queued' ? '等候楼梯' : visit.phase === 'waiting' ? '通道等候' : '上下楼途中', locationLabel: visit.phase === 'queued' ? '楼梯口' : '楼梯' };
  return { id: companion.id, activityLabel: live.activityLabel ?? activityNames[companion.leisure?.activity ?? companion.activity] ?? '在场', locationLabel: live.locationLabel ?? gatheringAreaNames[gatheringCompanionArea(gathering, companion)] };
}
