import { request } from './api';
import { object, array } from './contracts';
import { text, number, boolean } from './gatherings';

const reasons = ['paused', 'failed', 'interrupted', 'authorization_closed', 'expired', 'completed', 'permission_changed', 'budget_exhausted'];
export function parseAutomatic(value: unknown) {
  const r = object(value), reason = r.stop_reason === null ? null : text(r.stop_reason);
  if (reason !== null && !reasons.includes(reason)) throw new Error('自动交流状态无法核对');
  const authorization = r.authorization === null ? null : (() => {
    const a = object(r.authorization), ids = array(a.character_ids, number);
    const max = number(a.max_rounds), used = number(a.used_rounds), cap = number(a.cap_micro);
    if (ids.length !== 2 || new Set(ids).size !== 2 || !Number.isInteger(max) || max < 1 || max > 10
      || !Number.isInteger(used) || used < 0 || used >= max || cap <= 0) throw new Error('自动交流额度无法核对');
    return { id: text(a.id), character_ids: ids, max_rounds: max, used_rounds: used, cap_micro: cap, expires_at: number(a.expires_at) };
  })();
  return { available: boolean(r.available), enabled: boolean(r.enabled), revision: number(r.revision), next_at: number(r.next_at),
    today_count: number(r.today_count), stop_reason: reason, last_task_id: r.last_task_id === null ? null : text(r.last_task_id),
    last_task_state: r.last_task_state === null ? null : text(r.last_task_state), character_ids: array(r.character_ids, number), authorization };
}
export type AutomaticDialogueStatus = ReturnType<typeof parseAutomatic>;
export const automaticDialogueApi = {
  read: async (id: string, signal?: AbortSignal) => parseAutomatic(await request(`/gatherings/${id}/dialogue/automatic`, { signal })),
  configure: async (id: string, payload: { request_id: string; expected_revision: number; enabled: boolean; session_id: string | null }, signal?: AbortSignal) =>
    parseAutomatic(await request(`/gatherings/${id}/dialogue/automatic`, { method: 'POST', body: JSON.stringify(payload), signal })),
  viewing: async (id: string, viewer_id: string, active: boolean, signal?: AbortSignal) =>
    request(`/gatherings/${id}/dialogue/viewer`, { method: 'PUT', body: JSON.stringify({ viewer_id, active }), signal, keepalive: !active }),
};
