import { beforeEach, expect, it, vi } from 'vitest';
import { clearToken, setToken } from '@/lib/auth';
import { readCollectionPosition, rememberCollectionPosition } from '@/lib/collection-position';
const key = 'companion-collection-position';
beforeEach(() => { sessionStorage.clear(); localStorage.clear(); vi.restoreAllMocks(); });
it('isolates the anchor by verified account and discards a mismatched record', () => {
  rememberCollectionPosition('a', 6, -45);
  expect(readCollectionPosition('a')).toMatchObject({ ownerId: 'a', companionId: 6, offset: -45 });
  expect(readCollectionPosition('b')).toBeNull(); expect(readCollectionPosition('a')).toBeNull();
});
it.each(['{', 'null', JSON.stringify({ ownerId: 'a', companionId: -1, offset: 0, width: 390, savedAt: Date.now() }), JSON.stringify({ ownerId: 'a', companionId: 6, offset: 0, width: 390, savedAt: 1 })])('discards corrupt or expired data safely', raw => {
  sessionStorage.setItem(key, raw); expect(readCollectionPosition('a')).toBeNull(); expect(sessionStorage.getItem(key)).toBeNull();
});
it('clears the return anchor on logout and credential replacement', () => {
  setToken('first-test-token'); rememberCollectionPosition('a', 6, 30); clearToken(); expect(readCollectionPosition('a')).toBeNull();
  setToken('first-test-token'); rememberCollectionPosition('a', 6, 30); setToken('second-test-token'); expect(readCollectionPosition('a')).toBeNull();
});
it('keeps the anchor for the same credential and tolerates unavailable storage', () => {
  setToken('first-test-token'); rememberCollectionPosition('a', 6, 30); setToken('first-test-token'); expect(readCollectionPosition('a')).not.toBeNull();
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('unavailable'); });
  expect(() => rememberCollectionPosition('a', 1, 0)).not.toThrow();
});
