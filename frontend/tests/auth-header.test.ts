import { afterEach, describe, expect, it, vi } from 'vitest';
import { authHeaders } from '../lib/auth';
import { assertProductionConfig } from '../lib/production-config';

afterEach(() => vi.unstubAllEnvs());

describe('hosting authentication transport', () => {
  it('keeps the normal API header by default', () => {
    vi.stubEnv('NEXT_PUBLIC_AUTH_HEADER', '');
    expect(authHeaders('session')).toEqual({ Authorization: 'Bearer session' });
  });
  it('uses only the app header behind a gateway and preserves the captured session', () => {
    vi.stubEnv('NEXT_PUBLIC_AUTH_HEADER', 'X-Companion-Authorization');
    expect(authHeaders('captured')).toEqual({ 'X-Companion-Authorization': 'Bearer captured' });
    expect(authHeaders(null)).toEqual({});
  });
  it('rejects an unknown production header instead of silently breaking authentication', () => {
    expect(() => assertProductionConfig({ NODE_ENV: 'production', NEXT_PUBLIC_AUTH_HEADER: 'Other' })).toThrow();
  });
});
