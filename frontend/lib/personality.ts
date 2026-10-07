import { request } from './api';
import { object } from './contracts';

export type PersonalityDraft = { mode: 'original' | 'custom'; tags: string[]; custom_text: string; priority: 'presets' | 'custom' | null };
export type Personality = PersonalityDraft & { character_id: number; original_persona: string; effective_persona: string; revision: number };
export type PersonalityCatalog = { options: { id: string; label: string; group: string }[]; conflicts: string[][]; max_custom_length: number; catalog_version: number };
export type PersonalityEdit = PersonalityDraft & { expected_revision: number };
const invalid = () => new Error('性格设置暂时无法核对，请重试');
const strings = (v: unknown): v is string[] => Array.isArray(v) && v.every(x => typeof x === 'string');
export function parsePersonality(value: unknown): Personality {
  const r = object(value);
  if (!Number.isInteger(r.character_id) || Number(r.character_id) < 1 || !Number.isInteger(r.revision) || Number(r.revision) < 0 ||
      typeof r.original_persona !== 'string' || typeof r.effective_persona !== 'string' || typeof r.custom_text !== 'string' ||
      !strings(r.tags) || !['original', 'custom'].includes(String(r.mode)) || ![null, 'presets', 'custom'].some(p => p === r.priority)) throw invalid();
  return r as Personality;
}
export function parseCatalog(value: unknown): PersonalityCatalog {
  const r = object(value);
  if (r.catalog_version !== 1 || r.max_custom_length !== 300 || !Array.isArray(r.options) || !r.options.length || !Array.isArray(r.conflicts)) throw invalid();
  const options = r.options.map(v => { const o = object(v); if (['id', 'label', 'group'].some(k => typeof o[k] !== 'string' || !o[k])) throw invalid(); return o as PersonalityCatalog['options'][number]; });
  const ids = new Set(options.map(o => o.id));
  if (ids.size !== options.length || r.conflicts.some(v => !strings(v) || v.length !== 2 || v.some(id => !ids.has(id)))) throw invalid();
  return { options, conflicts: r.conflicts as string[][], max_custom_length: 300, catalog_version: 1 };
}
export function personalityDraft(p: PersonalityDraft): PersonalityDraft { return { mode: p.mode, tags: [...p.tags], custom_text: p.custom_text, priority: p.priority }; }
export const originalDraft = (): PersonalityDraft => ({ mode: 'original', tags: [], custom_text: '', priority: null });
export function normalizeDraft(d: PersonalityDraft): PersonalityDraft {
  if (d.mode === 'original') return originalDraft();
  const tags = [...new Set(d.tags)].filter(t => t !== 'quiet' || !d.tags.includes('introverted'));
  return { mode: d.mode, tags, custom_text: d.custom_text, priority: tags.length && d.custom_text.trim() ? d.priority : null };
}
export function sameDraft(a: PersonalityDraft, b: PersonalityDraft) { return JSON.stringify(normalizeDraft(a)) === JSON.stringify(normalizeDraft(b)); }
export function personalityIssue(d: PersonalityDraft, c: PersonalityCatalog): string {
  if (d.mode === 'original') return '';
  if (Array.from(d.custom_text).length > c.max_custom_length) return `自定义性格最多${c.max_custom_length}字，请调整后保存`;
  if (!d.tags.length && !d.custom_text.trim()) return '请选择性格或填写自定义描述';
  const labels = new Map(c.options.map(o => [o.id, o.label]));
  if (d.tags.some(t => !labels.has(t))) return '性格选项已更新，请重新选择';
  const conflict = c.conflicts.find(pair => pair.every(t => d.tags.includes(t)));
  if (conflict) return `「${labels.get(conflict[0])}」与「${labels.get(conflict[1])}」方向不同，请保留一个；情境反差可在自定义中说明`;
  if (d.tags.length && d.custom_text.trim() && !d.priority) return '请选择预设为主或自定义为主';
  return '';
}
export function personalityPreview(d: PersonalityDraft, c: PersonalityCatalog, original: string): string {
  if (d.mode === 'original') return original;
  const labels = d.tags.map(t => c.options.find(o => o.id === t)?.label ?? t).join(' + ');
  if (labels && d.custom_text.trim()) return `以${d.priority === 'custom' ? '自定义' : '预设'}为主；另一项作为不冲突的补充。\n预设：${labels}\n自定义：${d.custom_text}`;
  return d.custom_text.trim() ? d.custom_text : labels;
}
const personalitySignal = (signal?: AbortSignal) => {
  const timeout = AbortSignal.timeout(3000);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
};
export const personalityApi = {
  catalog: async (signal?: AbortSignal) => parseCatalog(await request('/personality-options', { signal: personalitySignal(signal) })),
  read: async (id: number, signal?: AbortSignal) => {
    const p = parsePersonality(await request(`/characters/${id}/personality`, { signal: personalitySignal(signal) }));
    if (p.character_id !== id) throw invalid(); return p;
  },
  save: async (id: number, edit: PersonalityEdit) => {
    const p = parsePersonality(await request(`/characters/${id}/personality`, { method: 'PUT', body: JSON.stringify(edit), signal: personalitySignal() }));
    if (p.character_id !== id || p.revision !== edit.expected_revision + 1) throw invalid(); return p;
  },
};
