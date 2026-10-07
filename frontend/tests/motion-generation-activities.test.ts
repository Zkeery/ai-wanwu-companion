import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { motionGenerationActivities, parseActivityGenerations } from '@/lib/motion-generation';
import { clearToken, setToken } from '@/lib/auth';

const value = () => ({ character_id: 18, activities: (['rest', 'walk', 'observe'] as const)
  .map((activity, i) => ({ activity, state: 'waiting_authorization', request_id: `${i}`.repeat(36) })) });
beforeEach(() => setToken('owner'));
afterEach(() => { clearToken(); vi.unstubAllGlobals(); });

it('validates all three distinct activity requests', () => {
  expect(parseActivityGenerations(value(), 18)).toEqual(value());
});

it.each(['missing', 'duplicate', 'reordered', 'shared-id', 'other-character', 'extra-field', 'unknown-state'])
('rejects an incomplete or cross-linked response: %s', kind => {
  const raw = value();
  if (kind === 'missing') raw.activities.pop();
  if (kind === 'duplicate') raw.activities[2] = { ...raw.activities[0] };
  if (kind === 'reordered') raw.activities.reverse();
  if (kind === 'shared-id') raw.activities[1].request_id = raw.activities[0].request_id;
  if (kind === 'other-character') raw.character_id = 19;
  if (kind === 'extra-field') Object.assign(raw.activities[0], { approval_ref: 'not-public' });
  if (kind === 'unknown-state') raw.activities[0].state = 'guess';
  expect(() => parseActivityGenerations(raw, 18)).toThrow();
});

it('registers only bookkeeping at the three-activity endpoint', async () => {
  const fetcher = vi.fn(async () => new Response(JSON.stringify(value()), { status: 200 }));
  vi.stubGlobal('fetch', fetcher);
  await motionGenerationActivities(18, 'owner', new AbortController().signal, true);
  expect(fetcher).toHaveBeenCalledWith('/api/v1/characters/18/motion-generation/activities',
    expect.objectContaining({ method: 'POST', body: '{}', cache: 'no-store' }));
});

it('does not deliver a response after the account changes', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => { setToken('other'); return new Response(JSON.stringify(value())); }));
  await expect(motionGenerationActivities(18, 'owner', new AbortController().signal)).rejects.toThrow('登录状态已变化');
});
