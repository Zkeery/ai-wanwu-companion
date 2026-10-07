export type Character = { id: number; name: string; persona: string; opening_line: string; image_path: string | null; status: 'ready' | 'generating' | 'failed'; created_at: string; theme_id?: string | null };
export type Message = { id: number; role: 'user' | 'assistant'; content: string; created_at: string };
export type Memory = { id: number; content: string; created_at: string; updated_at: string };
export type Decoration = 'flower' | 'mushroom' | 'pond' | 'bench' | 'campfire' | 'fireflies';
export type SceneAction = 'light_rain' | 'quiet' | 'plant_tree' | 'plant_flower' | 'grow_mushroom' | 'add_pond' | 'place_bench' | 'light_campfire' | 'release_fireflies';
export type Proposal = { id: string; action: SceneAction };
export type Scene = { living?: LivingSpace; scene_name: string; elements: { rain: number; tree: number; cloud: number; sound: number } & Partial<Record<Decoration, number>>; available_actions?: SceneAction[]; can_undo: boolean; proposal: Proposal | null; feedback: string | null };
export const actionNames: Record<SceneAction, string> = { light_rain: '下点小雨', quiet: '安静一会', plant_tree: '种一棵树', plant_flower: '种一簇花', grow_mushroom: '添一丛蘑菇', add_pond: '添个水池', place_bench: '放张长椅', light_campfire: '点亮营火', release_fireflies: '迎来萤火虫' };

export function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('服务返回的数据格式不正确');
  return value as Record<string, unknown>;
}
function str(value: unknown): string { if (typeof value !== 'string') throw new Error('服务返回的数据格式不正确'); return value; }
function num(value: unknown): number { if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error('服务返回的数据格式不正确'); return value; }
function bool(value: unknown): boolean { if (typeof value !== 'boolean') throw new Error('服务返回的数据格式不正确'); return value; }
export function parseCharacter(value: unknown): Character {
  const v = object(value); const status = str(v.status);
  if (!['ready', 'generating', 'failed'].includes(status)) throw new Error('这个伙伴的状态暂时无法识别，请刷新');
  return { id: num(v.id), name: str(v.name), persona: str(v.persona), opening_line: str(v.opening_line), image_path: v.image_path == null ? null : str(v.image_path), status: status as Character['status'], created_at: str(v.created_at), ...(v.theme_id == null ? {} : { theme_id: str(v.theme_id) }) };
}
export type CharacterOverview = {
  character: Character;
  residence: { space_id: string; scene_type: SceneType; mode: 'private' | 'shared' } | null;
  last_interaction_at: string | null;
  recent_activity?: { revision: number; occurred_at: string; source: 'user'; text: string }[];
  gathering?: { id: string; title: string } | null;
};
export function parseCharacterOverview(value: unknown): CharacterOverview {
  const v = object(value);
  let residence: CharacterOverview['residence'] = null;
  if (v.residence !== null) {
    const r = object(v.residence);
    if (!['home', 'desert', 'forest'].includes(str(r.scene_type)) || !['private', 'shared'].includes(str(r.mode)) || !str(r.space_id).trim()) throw new Error('伙伴住处暂时无法核对');
    residence = { space_id: str(r.space_id), scene_type: r.scene_type as SceneType, mode: r.mode as 'private' | 'shared' };
  }
  const last = v.last_interaction_at === null ? null : str(v.last_interaction_at);
  if (last !== null && !Number.isFinite(Date.parse(last))) throw new Error('伙伴近况暂时无法核对');
  const recent_activity: NonNullable<CharacterOverview['recent_activity']> = [];
  if (v.recent_activity !== undefined) {
    if (!Array.isArray(v.recent_activity) || v.recent_activity.length > 3 || (v.recent_activity.length > 0 && residence?.mode !== 'private')) throw new Error('生活近况暂时无法核对');
    let previous = Infinity;
    for (const raw of v.recent_activity) {
      const item = object(raw), revision = num(item.revision), occurred_at = str(item.occurred_at), text = str(item.text);
      if (!Number.isSafeInteger(revision) || revision <= 0 || revision >= previous || item.source !== 'user' || !Number.isFinite(Date.parse(occurred_at)) || !/(Z|[+-]\d{2}:\d{2})$/.test(occurred_at) || !text.trim() || text.length > 80) throw new Error('生活近况暂时无法核对');
      recent_activity.push({ revision, occurred_at, source: 'user', text });
      previous = revision;
    }
  }
  return { character: parseCharacter(v.character), residence, last_interaction_at: last, recent_activity,
    ...(v.gathering == null ? {} : { gathering: { id: str(object(v.gathering).id), title: str(object(v.gathering).title) } }) };
}
export function parseMessage(value: unknown): Message {
  const v = object(value); if (v.role !== 'user' && v.role !== 'assistant') throw new Error('无法识别的消息');
  return { id: num(v.id), role: v.role, content: str(v.content), created_at: str(v.created_at) };
}
export function parseMemory(value: unknown): Memory { const v = object(value); return { id: num(v.id), content: str(v.content), created_at: str(v.created_at), updated_at: str(v.updated_at) }; }
export function parseProposal(value: unknown): Proposal | null {
  if (value == null) return null;
  const v = object(value); const action = str(v.action);
  if (!Object.hasOwn(actionNames, action)) throw new Error('暂不支持这个场景操作');
  return { id: str(v.id), action: action as SceneAction };
}
export function parseScene(value: unknown): Scene {
  const v = object(value), e = object(v.elements);
  const available_actions = v.action_labels == null ? undefined : Object.keys(object(v.action_labels)).filter((key): key is SceneAction => Object.hasOwn(actionNames, key));
  return { living: v.living == null ? undefined : parseLivingSpace(v.living), scene_name: str(v.scene_name), available_actions, elements: { rain: num(e.rain), tree: num(e.tree), cloud: num(e.cloud), sound: num(e.sound), ...Object.fromEntries(['flower', 'mushroom', 'pond', 'bench', 'campfire', 'fireflies'].map(key => [key, e[key] == null ? 0 : num(e[key])])) }, can_undo: bool(v.can_undo), proposal: parseProposal(v.proposal), feedback: v.feedback == null ? null : str(v.feedback) };
}
export function array<T>(value: unknown, parse: (item: unknown) => T): T[] {
  if (!Array.isArray(value)) throw new Error('服务返回的数据格式不正确'); return value.map(parse);
}
export function imageUrl(path: string | null): string | null {
  if (!path || path.includes('..') || path.startsWith('/') || path.includes('://')) return null;
  return '/uploads/' + path.split('/').map(encodeURIComponent).join('/');
}

// ---- R2 多场景与账号 ----

export type SceneType = 'home' | 'desert' | 'forest';
export type LivingItem = {
  id: string; kind: string; x: number; y: number; stored: boolean; flipped?: boolean;
  growth_seconds: number; stage: 'planted' | 'growing' | 'mature' | null;
  care_remaining_seconds: number | null;
  growth_status: 'mature' | 'stored' | 'growing' | 'needs_care' | null;
};
export type LivingSpace = {
  id: string; scene_type: SceneType; mode: 'private' | 'shared';
  companion_id: string | null; revision: number; observed_at: number;
  items: LivingItem[]; can_undo: boolean;
  atmosphere?: { rain: boolean; sound: boolean };
};
export type SpaceMember = { companion_id: string; name: string | null };
export type SpaceSummary = { id: string; scene_type: SceneType; mode: 'private' | 'shared'; companion_id: string | null; revision: number; members?: SpaceMember[] };
export type AuthUser = { id: string; phone: string };

export const sceneNames: Record<SceneType, string> = { home: '家庭庭院', desert: '沙漠绿洲', forest: '林间营地' };

export function parseAuthUser(value: unknown): AuthUser {
  const v = object(value); return { id: str(v.id), phone: str(v.phone) };
}
export function parseLivingItem(value: unknown): LivingItem {
  const v = object(value);
  const stage = v.stage == null ? null : str(v.stage);
  const growthStatus = v.growth_status == null ? null : str(v.growth_status);
  if (stage != null && !['planted', 'growing', 'mature'].includes(stage)) throw new Error('物件阶段无法识别');
  if (growthStatus != null && !['mature', 'stored', 'growing', 'needs_care'].includes(growthStatus)) throw new Error('物件状态无法识别');
  return {
    id: str(v.id), kind: str(v.kind), x: num(v.x), y: num(v.y),
    stored: bool(v.stored), flipped: v.flipped === undefined ? false : bool(v.flipped), growth_seconds: num(v.growth_seconds),
    stage: stage as LivingItem['stage'], care_remaining_seconds: v.care_remaining_seconds == null ? null : num(v.care_remaining_seconds),
    growth_status: growthStatus as LivingItem['growth_status'],
  };
}
export function parseLivingSpace(value: unknown): LivingSpace {
  const v = object(value);
  const sceneType = str(v.scene_type), mode = str(v.mode);
  if (!Object.hasOwn(sceneNames, sceneType)) throw new Error('暂不支持这个生活场景');
  if (mode !== 'private' && mode !== 'shared') throw new Error('居住方式无法识别');
  return {
    id: str(v.id), scene_type: sceneType as SceneType, mode: mode as LivingSpace['mode'],
    companion_id: v.companion_id == null ? null : str(v.companion_id), revision: num(v.revision),
    observed_at: num(v.observed_at), items: array(v.items, parseLivingItem), can_undo: bool(v.can_undo),
    atmosphere: v.atmosphere == null ? undefined : { rain: bool(object(v.atmosphere).rain), sound: bool(object(v.atmosphere).sound) },
  };
}
export function parseSpaceSummary(value: unknown): SpaceSummary {
  const v = object(value);
  const sceneType = str(v.scene_type), mode = str(v.mode);
  if (!Object.hasOwn(sceneNames, sceneType)) throw new Error('暂不支持这个生活场景');
  if (mode !== 'private' && mode !== 'shared') throw new Error('居住方式无法识别');
  const summary: SpaceSummary = {
    id: str(v.id), scene_type: sceneType as SceneType, mode: mode as SpaceSummary['mode'],
    companion_id: v.companion_id == null ? null : str(v.companion_id), revision: num(v.revision),
  };
  if (v.members != null) summary.members = array(v.members, item => { const m = object(item); return { companion_id: str(m.companion_id), name: m.name == null ? null : str(m.name) }; });
  return summary;
}
