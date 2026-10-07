import { request } from './api';
import { object, array } from './contracts';
import { text, number, boolean } from './gatherings';

export function parseDialogue(value: unknown) {
  const r = object(value);
  return {
    available: boolean(r.available),
    grants: array(r.grants, value => { const g = object(value); return { id: text(g.id), character_ids: array(g.character_ids, number), cap_micro: number(g.cap_micro), expires_at: number(g.expires_at) }; }),
    tasks: array(r.tasks, value => {
      const t = object(value), state = text(t.state);
      if (!['running', 'done', 'failed', 'unknown'].includes(state)) throw new Error('交流状态无法核对');
      return { id: text(t.id), state, created_at: number(t.created_at), dispatched: boolean(t.dispatched) };
    }),
    exchanges: array(r.exchanges, value => { const e = object(value);
      if (e.origin !== 'real_provider') throw new Error('交流来源无法核对');
      return { id: text(e.id), at: number(e.at), lines: array(e.lines, value => { const l = object(value); return { character_id: number(l.character_id), name: text(l.name), text: text(l.text) }; }) };
    }),
  };
}
export const dialogueApi = {
  read: async (id: string, signal?: AbortSignal) => parseDialogue(await request(`/gatherings/${id}/dialogue`, { signal })),
  start: async (id: string, payload: { request_id: string; expected_revision: number; character_ids: number[]; grant_id: string }, signal?: AbortSignal) =>
    parseDialogue(await request(`/gatherings/${id}/dialogue`, { method: 'POST', body: JSON.stringify(payload), signal })),
};
export type DialogueStatus = ReturnType<typeof parseDialogue>;
