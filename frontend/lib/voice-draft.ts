/** Store only text, scoped to the current tab, account session and companion. */
export async function voiceDraftKey(token: string, characterId: number): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token));
  const fingerprint = [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
  return `aiwwb-voice-text:${characterId}:${fingerprint}`;
}
