import { describe, expect, it } from 'vitest';
import { parseGathering } from '@/lib/gatherings';
import { parseInventory, parseMatch } from '@/lib/activities';
import { parseVoiceSettings, parseAudio } from '@/lib/voice';
import { isPrivateImageUrl } from '@/lib/private-images';

describe('new flow boundaries reject malformed server facts', () => {
  it.each([null, [], {}, { balance: '20', shop: {}, decorations: [] }, { balance: Infinity, shop: {}, decorations: [] }])('rejects an invalid resource wallet', value => {
    expect(() => parseInventory(value)).toThrow();
  });
  it('preserves zero resources and empty inventory as a valid state', () => {
    expect(parseInventory({ balance: 0, shop: { colorful_pot: 20 }, decorations: [] })).toEqual({ balance: 0, shop: { colorful_pot: 20 }, decorations: [] });
  });
  it('does not interpret a string as a saved consent', () => {
    expect(() => parseVoiceSettings({ voice: 'Tingting', mood: null, automatic: 'false', mood_source: 'none', voices: [] })).toThrow();
  });
  it('keeps expired audio distinct from playable audio', () => {
    const audio = parseAudio({ id: 'one', message_id: 2, role: 'user', state: 'expired', expires_at: 10, created_at: 0 });
    expect(audio.state).toBe('expired');
  });
  it('keeps archived reply provenance separate from current settings', () => {
    const audio = parseAudio({ id: 'one', message_id: 2, role: 'assistant', state: 'ready', expires_at: 10, created_at: 0, origin: 'offline_fixture' });
    expect(audio.origin).toBe('offline_fixture');
    const settings = { voice: 'Tingting', mood: null, automatic: true, mood_source: 'none', voices: [] };
    expect(parseVoiceSettings(settings).reply_origin).toBe('disabled');
    expect(parseVoiceSettings({ ...settings, reply_origin: 'configured_model' }).reply_origin).toBe('configured_model');
    expect(() => parseVoiceSettings({ ...settings, reply_origin: 'untrusted' })).toThrow();
  });
  it('rejects missing membership and match participants rather than rendering success', () => {
    expect(() => parseGathering({ id: 'one', season: {} })).toThrow();
    expect(() => parseMatch({ id: 'one', participants: null })).toThrow();
  });
  it.each(['/api/v1/gatherings/aabb-1234/companions/1/image?token=secret', 'https://example.com/image', '/api/v1/gatherings/../companions/1/image'])('never attaches auth to an untrusted shared portrait URL', url => {
    expect(isPrivateImageUrl(url)).toBe(false);
  });
  it('allows only same-origin authenticated shared portrait paths', () => {
    expect(isPrivateImageUrl('/api/v1/gatherings/aabb-1234/companions/1/image')).toBe(true);
  });
});
