import { authHeaders, getToken } from './auth';
import { consumeCreation } from './creation';

const storageKey = (id: number) => `companion-recreation:${id}`;
export function recreationKey(id: number): string | null {
  const value = sessionStorage.getItem(storageKey(id));
  if (value !== null && !/^[\da-f-]{36}$/i.test(value)) throw new Error('再创作记录无法读取，请保留当前记录并联系维护人员');
  return value;
}
export function saveRecreationKey(id: number, key: string | null): void {
  if (key === null) sessionStorage.removeItem(storageKey(id));
  else sessionStorage.setItem(storageKey(id), key);
}
export async function recreateCompanion(id: number, requestId: string, signal: AbortSignal, stage: (text: string) => void) {
  const combined = AbortSignal.any([signal, AbortSignal.timeout(180000)]);
  const token = getToken();
  const response = await fetch(`/api/v1/characters/${id}/recreations`, {
    method: 'POST', signal: combined, headers: { ...authHeaders(), 'Content-Type': 'application/json' },
    body: JSON.stringify({ request_id: requestId }),
  });
  return consumeCreation(response, stage, combined, token);
}
