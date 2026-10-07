import { request, checkResponse } from './api';
import { authHeaders, getToken } from './auth';
import { array, object } from './contracts';
import { text, number, boolean } from './gatherings';

export const moods: Record<string, string> = { happy: '开心', calm: '平静', sad: '低落', tired: '疲惫', anxious: '紧张', unsure: '说不清' };
export function parseVoiceSettings(value: unknown) { const v = object(value); return { voice: text(v.voice), mood: v.mood == null ? null : text(v.mood), automatic: boolean(v.automatic), mood_source: text(v.mood_source), reply_origin: parseReplyOrigin(v.reply_origin), live_session: parseLiveSession(v.live_session), transcription_status: parseTranscriptionStatus(v.transcription_status), voices: array(v.voices, x => { const v = object(x); return { id: text(v.id), label: text(v.label) }; }) }; }
export const liveSessionLabels: Record<string, string> = { active: '真实连续聊天已开启', exhausted: '本次真实聊天轮数已用完', expired: '本次真实聊天已到期', revoked: '真实聊天已结束', failed: '本次真实聊天遇到问题，已停止后续调用' };
function parseLiveSession(value: unknown) {
  if (value == null) return null;
  const v = object(value), state = text(v.state);
  const remaining = number(v.remaining_rounds), used = number(v.used_rounds), max = number(v.max_rounds);
  const budget = number(v.budget_micro), reserved = number(v.reserved_micro), expires = number(v.expires_at);
  if (!Object.hasOwn(liveSessionLabels, state) || ![remaining, used, max, budget, reserved, expires].every(Number.isSafeInteger)
      || max < 1 || max > 10 || used < 0 || remaining < 0 || used + remaining !== max || budget <= 0 || reserved < 0 || reserved > budget || expires <= 0) throw new Error('真实聊天额度无法核对');
  return { state, remaining_rounds: remaining, used_rounds: used, max_rounds: max, budget_micro: budget, reserved_micro: reserved, expires_at: expires };
}
export const transcriptionMessages = {
  unconfigured: '本地识别尚未配置，可以先填写录音文字。',
  model_missing: '本地识别模型尚未准备好，可以先填写录音文字。',
  dependency_missing: '本地识别组件尚未准备好，可以先填写录音文字。',
  configured: '本地识别已配置，可以尝试识别；识别后请核对文字。',
};
function parseTranscriptionStatus(value: unknown): keyof typeof transcriptionMessages {
  if (value === undefined) return 'unconfigured';
  if (value === 'unconfigured' || value === 'model_missing' || value === 'dependency_missing' || value === 'configured') return value;
  throw new Error('语音识别配置状态无效');
}
function parseReplyOrigin(value: unknown): 'offline_fixture' | 'configured_model' | 'disabled' { if (value === undefined) return 'disabled'; if (value === 'offline_fixture' || value === 'configured_model' || value === 'disabled') return value; throw new Error('语音回复来源无效'); }
export function parseAudio(value: unknown) { const a = object(value); return { id: text(a.id), message_id: a.message_id == null ? null : number(a.message_id), role: text(a.role), origin: parseReplyOrigin(a.origin), state: text(a.state), expires_at: number(a.expires_at), created_at: number(a.created_at) }; }
export type AudioRecord = ReturnType<typeof parseAudio>;
export function parseVoiceReceipt(value: unknown) {
  const v = object(value), state = text(v.state);
  if (!['running', 'text_ready', 'completed', 'failed', 'cancelled'].includes(state)) throw new Error('语音发送状态无效');
  return { id: text(v.id), state, error: v.error == null ? null : text(v.error), origin: parseReplyOrigin(v.origin), created_at: number(v.created_at), reply_message_id: v.reply_message_id == null ? null : number(v.reply_message_id) };
}
export type VoiceReceipt = ReturnType<typeof parseVoiceReceipt>;
export function receiptLabel(receipt: Pick<VoiceReceipt, 'state' | 'error'>) {
  if (receipt.state === 'running') return '录音已接收，回复处理中';
  if (receipt.state === 'text_ready') return '文字回复已保存，正在准备音频';
  if (receipt.state === 'failed') return '回复失败，已接收的录音和文字保留在聊天记录中';
  if (receipt.state === 'cancelled') return '这次发送已取消，聊天记录已清空';
  return receipt.error ? '文字回复已保存，回复音频暂不可用' : '录音和回复已保存';
}
export const voiceApi = {
  receipts: async (id: number, signal?: AbortSignal) => array(await request(`/characters/${id}/voice/rounds`, { signal }), parseVoiceReceipt),
  receipt: async (id: number, requestId: string, signal?: AbortSignal) => parseVoiceReceipt(await request(`/characters/${id}/voice/rounds/${encodeURIComponent(requestId)}`, { signal })),
  transcribe: async (id: number, clip: Blob) => {
    const body = new FormData(); body.append('recording', clip, 'recording.audio');
    const token = getToken(), r = await fetch(`/api/v1/characters/${id}/voice/transcribe`, { method: 'POST', headers: authHeaders(), body, signal: AbortSignal.timeout(70000), redirect: 'error' });
    await checkResponse(r, token); return text(object(await r.json()).text);
  },
  settings: async (id: number) => parseVoiceSettings(await request(`/characters/${id}/voice/settings`)),
  endSession: async (id: number) => parseVoiceSettings(await request(`/characters/${id}/voice/session/end`, { method: 'POST' })),
  save: async (id: number, voice: string, mood: string | null, automatic: boolean) => parseVoiceSettings(await request(`/characters/${id}/voice/settings`, { method: 'PUT', body: JSON.stringify({ voice, mood, automatic }) })),
  history: async (id: number, signal?: AbortSignal) => array(await request(`/characters/${id}/voice/audio`, { signal }), parseAudio),
  remove: async (id: number, audioId: string) => request(`/characters/${id}/voice/audio/${audioId}`, { method: 'DELETE' }),
  retryAudio: async (id: number, audioId: string) => {
    const token = getToken(), r = await fetch(`/api/v1/characters/${id}/voice/audio/${audioId}/retry`, {
      method: 'POST', headers: authHeaders(), cache: 'no-store', redirect: 'error', signal: AbortSignal.timeout(40000),
    });
    await checkResponse(r, token);
    const v = object(await r.json());
    const state = text(v.state);
    if (state !== 'ready') throw new Error('回复音频状态无效');
    return { id: text(v.id), state, expires_at: number(v.expires_at) };
  },
  send: async (id: number, clip: Blob, transcript: string, requestId: string, signal?: AbortSignal) => {
    const body = new FormData(); body.append('recording', clip, 'recording.audio'); body.append('transcript', transcript); body.append('request_id', requestId);
    const token = getToken();
    const r = await fetch(`/api/v1/characters/${id}/voice/send`, { method: 'POST', headers: authHeaders(), body, signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(65000)]) : AbortSignal.timeout(65000), redirect: 'error' });
    await checkResponse(r, token); const v = object(await r.json()), state = text(v.state);
    if (!['running', 'text_ready', 'completed', 'failed', 'cancelled'].includes(state)) throw new Error('语音发送状态无效');
    return { state, error: v.error == null ? null : text(v.error) };
  },
  blob: async (id: number, audioId: string, signal?: AbortSignal) => {
    const token = getToken(), r = await fetch(`/api/v1/characters/${id}/voice/audio/${audioId}`, { headers: authHeaders(), cache: 'no-store', redirect: 'error', signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(15000)]) : AbortSignal.timeout(15000) });
    await checkResponse(r, token); return r.blob();
  },
  preview: async (id: number, voice: string) => {
    const token = getToken(), r = await fetch(`/api/v1/characters/${id}/voice/preview`, { method: 'POST', headers: { ...authHeaders(), 'Content-Type': 'application/json' }, body: JSON.stringify({ voice }), redirect: 'error', signal: AbortSignal.timeout(35000) });
    await checkResponse(r, token); return r.blob();
  },
};
