import { beforeEach, expect, it, vi } from 'vitest';
import { creationHref, originFromQuery, parseOrigin, previewId, readPosition, rememberPosition, returnHref } from '@/lib/creation-origin';
import { readDraft, writeDraft } from '@/lib/creation';
import { setToken } from '@/lib/auth';
const id = '11111111-1111-4111-8111-111111111111';
beforeEach(() => { vi.restoreAllMocks(); sessionStorage.clear(); localStorage.clear(); });
it('accepts only internal theme and team targets, with strict scalar IDs', () => {
  expect(originFromQuery('fruit', id)).toEqual({ kind: 'team', theme: 'fruit', teamId: id });
  for (const team of ['//outside.example', '../../account', `${id}?preview=9`, [id], '']) expect(originFromQuery('fruit', team)).toBeNull();
  expect(originFromQuery('other', undefined)).toBeNull();
  expect(parseOrigin({ kind: 'redirect', theme: 'fruit', url: 'https://outside' })).toBeNull();
  for (const value of ['0', '-1', '1.2', '1e3', '9007199254740993', ['1'], null]) expect(previewId(value)).toBeNull();
  expect(previewId('10')).toBe(10);
});
it('persists the old request source rather than adopting a new entry after reload', () => {
  const origin = { kind: 'team' as const, theme: 'fruit' as const, teamId: id };
  writeDraft({ requestId: id, objectId: 2, origin });
  expect(readDraft()?.origin).toEqual(origin);
  expect(creationHref(origin)).toBe(`/companions/new?theme=fruit&team=${id}`);
  expect(returnHref(origin, 10)).toBe(`/teams/${id}?resume=1&preview=10`);
  expect(returnHref(origin)).not.toContain('preview=');
});
it('position storage is optional, validated and cleared on session changes', () => {
  const origin = { kind: 'theme' as const, theme: 'fruit' as const };
  vi.spyOn(window, 'scrollY', 'get').mockReturnValue(425);
  rememberPosition(origin, 24); expect(readPosition(origin)).toEqual({ y: 425, offset: 24 });
  setToken('new-synthetic-session'); expect(readPosition(origin)).toBeNull();
  sessionStorage.setItem('creation-position:/themes/fruit', '{broken'); expect(readPosition(origin)).toBeNull();
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('storage unavailable'); });
  expect(() => rememberPosition(origin)).not.toThrow();
});
