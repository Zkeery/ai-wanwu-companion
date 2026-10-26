import React, { useState } from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import PrivateLivingWorld from '@/components/private-living-world';
import { parseLivingSpace, type Character, type LivingSpace } from '@/lib/contracts';
import { setToken } from '@/lib/auth';
import type { Gathering } from '@/lib/gatherings';

vi.mock('next/dynamic', () => ({ default: () => function World({ gathering, busy, onActivity }: { gathering: Gathering; busy: boolean; onActivity: (id: number, value: 'sleep') => Promise<void> }) {
  return <><p data-testid="http-world">{gathering.companions[0]?.activity}</p><button disabled={busy} onClick={() => void onActivity(1, 'sleep')}>HTTP安排睡觉</button></>;
} }));
const person: Character = { id: 1, name: '伙伴', persona: '', opening_line: '', image_path: null, status: 'ready', created_at: '' };
const initial = (): LivingSpace => ({ id: 'real-http-space', owner_id: 'http-owner', companion_id: '1', mode: 'private', scene_type: 'forest', revision: 3, observed_at: 100,
  resident_here: true,
  items: [], can_undo: false, world: { activity: 'observe', area: 'outdoor' }, avatar3d: null });
function Harness({ saved }: { saved: LivingSpace }) {
  const [space, setSpace] = useState(saved);
  return <PrivateLivingWorld space={space} companions={[person]} visible readOnly={false} onChange={setSpace} renderEditor={() => null} />;
}
afterEach(() => { vi.unstubAllGlobals(); });
it.each([false, true])('uses the real API request/parser and restores an HTTP save, lost response=%s', async lost => {
  setToken('unit-http-session'); let stored = initial();
  const calls: { path: string; method: string; body: Record<string, unknown> | null }[] = [];
  const response = (value: unknown) => new Response(JSON.stringify(value), { status: 200, headers: { 'Content-Type': 'application/json' } });
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const raw = String(input), path = raw.slice(raw.indexOf('/api/v1/') + '/api/v1'.length), method = init?.method ?? 'GET';
    const body = init?.body ? JSON.parse(String(init.body)) : null; calls.push({ path, method, body });
    if (path === '/living/spaces/real-http-space/season' && method === 'GET') return response({ settings: null, current_season: null, started_at: null, next_change_at: null, revision: 0, observed_at: 100, timezone: 'Asia/Shanghai' });
    if (path === '/living/spaces/real-http-space' && method === 'GET') return response(stored);
    if (path === '/living/spaces/real-http-space/actions' && method === 'POST') {
      expect(body).toMatchObject({ expected_revision: 3, command: { action: 'world_activity', activity: 'sleep' } }); expect(typeof body.request_id).toBe('string');
      stored = { ...stored, revision: 4, world: { activity: 'sleep', area: 'bedroom' } };
      if (lost) throw new Error('synthetic lost response'); return response(stored);
    }
    throw new Error('Unexpected network route in isolated test');
  }));
  const first = render(<Harness saved={parseLivingSpace(initial())} />); fireEvent.click(screen.getByRole('button', { name: 'HTTP安排睡觉' }));
  await waitFor(() => expect(screen.getByTestId('http-world')).toHaveTextContent('sleep'));
  expect(calls.filter(call => call.method === 'POST')).toHaveLength(1);
  expect(calls.every(call => call.path.startsWith('/living/spaces/real-http-space'))).toBe(true);
  if (lost) expect(calls.some(call => call.path === '/living/spaces/real-http-space' && call.method === 'GET')).toBe(true);
  first.unmount(); render(<Harness saved={parseLivingSpace(stored)} />);
  expect(screen.getByTestId('http-world')).toHaveTextContent('sleep'); expect(calls.filter(call => call.method === 'POST')).toHaveLength(1);
});
