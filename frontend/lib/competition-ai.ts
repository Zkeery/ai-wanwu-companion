import { request } from './api';
import { array, object } from './contracts';
import { boolean, number, text } from './gatherings';
export type Phase = 'strategy' | 'reflection';
export function parseAI(value: unknown) {
  const s = object(value);
  return { available: boolean(s.available),
    grants: array(s.grants, value => { const g = object(value); return { id: text(g.id), character_id: number(g.character_id), phase: text(g.phase), cap_micro: number(g.cap_micro) }; }),
    tasks: array(s.tasks, value => { const t = object(value); return { id: text(t.id), request_id: text(t.request_id), character_id: number(t.character_id), phase: text(t.phase), state: text(t.state) }; }),
  };
}
export type AIStatus = ReturnType<typeof parseAI>;
export const competitionAI = {
  read: async (id: string) => parseAI(await request(`/activities/${id}/ai`)),
  generate: async (id: string, characterId: number, phase: Phase, grantId: string, requestId: string) => parseAI(await request(`/activities/${id}/ai`, { method: 'POST', body: JSON.stringify({ request_id: requestId, grant_id: grantId, character_id: characterId, phase }) })),
};
