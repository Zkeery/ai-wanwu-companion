import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import VoiceCompanion from '@/components/voice-companion';
import { parseVoiceSettings, parseVoiceReceipt, receiptLabel, voiceApi } from '@/lib/voice';
import { api, ApiError } from '@/lib/api';
import { type Scene } from '@/lib/contracts';
import { voiceDraftKey } from '@/lib/voice-draft';
import { webcrypto } from 'node:crypto';
import { startWavCapture } from '@/lib/pcm-recorder';

vi.mock('@/components/team-shared', () => ({ useTeamSession: () => 'test-session' }));
vi.mock('@/lib/pcm-recorder', async original => ({ ...await original<typeof import('@/lib/pcm-recorder')>(), startWavCapture: vi.fn() }));
vi.mock('@/lib/api', async original => ({ ...await original<typeof import('@/lib/api')>(), api: { character: vi.fn(), messages: vi.fn(), scene: vi.fn(), decide: vi.fn() }, errorText: (e: Error) => e.message }));
vi.mock('@/lib/voice', async original => ({ ...await original<typeof import('@/lib/voice')>(), voiceApi: { settings: vi.fn(), history: vi.fn(), transcribe: vi.fn(), send: vi.fn(), receipts: vi.fn(), receipt: vi.fn(), retryAudio: vi.fn(), endSession: vi.fn(), preview: vi.fn() } }));
const base = { voice: '', mood: null, automatic: true, mood_source: 'none', voices: [], reply_origin: 'offline_fixture' };
const configured = parseVoiceSettings({ ...base, transcription_status: 'configured' });
const emptyScene: Scene = { scene_name: '家庭庭院', elements: { rain: 0, tree: 0, cloud: 0, sound: 1 }, can_undo: false, proposal: null, feedback: null };

beforeEach(() => {
  vi.resetAllMocks();
  localStorage.clear(); sessionStorage.clear();
  history.replaceState(null, '', location.href);
  vi.stubGlobal('crypto', webcrypto);
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
  HTMLDialogElement.prototype.showModal = function () { this.setAttribute('open', ''); };
  HTMLDialogElement.prototype.close = function () { this.removeAttribute('open'); };
  vi.mocked(api.character).mockResolvedValue({ id: 1, name: '小杯' } as Awaited<ReturnType<typeof api.character>>);
  vi.mocked(api.messages).mockResolvedValue([]);
  vi.mocked(api.scene).mockResolvedValue(emptyScene);
  vi.mocked(voiceApi.settings).mockResolvedValue(configured);
  vi.mocked(voiceApi.history).mockResolvedValue([]);
  vi.mocked(voiceApi.receipts).mockResolvedValue([]);
  Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: { getUserMedia: vi.fn().mockResolvedValue({ getTracks: () => [{ stop: vi.fn() }] }) } });
  class Recorder {
    static isTypeSupported() { return true; }
    state = 'inactive'; mimeType = 'audio/webm';
    ondataavailable?: (event: { data: Blob }) => void; onstop?: () => void;
    start() { this.state = 'recording'; }
    stop() { this.state = 'inactive'; this.ondataavailable?.({ data: new Blob(['synthetic audio']) }); this.onstop?.(); }
  }
  vi.stubGlobal('MediaRecorder', Recorder);
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {});
});

async function record() {
  await screen.findByText('和小杯说说话');
  fireEvent.click(screen.getByRole('button', { name: '开始录音' }));
  fireEvent.click(await screen.findByRole('button', { name: '停止录音' }));
}

it.each([
  ['NotAllowedError', '麦克风权限未开启'],
  ['NotFoundError', '没有找到麦克风'],
  ['NotReadableError', '麦克风暂时无法使用'],
  ['AbortError', '麦克风暂时无法使用'],
])('explains %s while retaining the previous recording and text', async (name, message) => {
  render(<VoiceCompanion id={1} />); await record();
  fireEvent.change(screen.getByRole('textbox'), { target: { value: '原草稿' } });
  vi.mocked(navigator.mediaDevices.getUserMedia).mockRejectedValue(new DOMException('browser error', name));
  fireEvent.click(screen.getByRole('button', { name: '重新录制' }));
  expect(await screen.findByText(new RegExp(message))).toBeInTheDocument();
  expect(screen.getByRole('button', { name: '试听录音' })).toBeEnabled();
  expect(screen.getByRole('textbox')).toHaveValue('原草稿');
  expect(voiceApi.transcribe).not.toHaveBeenCalled();
  expect(voiceApi.send).not.toHaveBeenCalled();
});

it.each(['native', 'pcm'])('stops %s capture when the device ends and ignores its later events', async mode => {
  const track = Object.assign(new EventTarget(), { stop: vi.fn(), readyState: 'live' });
  vi.mocked(navigator.mediaDevices.getUserMedia).mockResolvedValue({ getTracks: () => [track] } as unknown as MediaStream);
  const pcmStop = vi.fn(() => new Blob(['valid captured audio'], { type: 'audio/webm' }));
  if (mode === 'pcm') {
    vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue('Code/1.0 Electron/1.0');
    vi.mocked(startWavCapture).mockResolvedValue({ stop: pcmStop, cancel: vi.fn() });
  }
  render(<VoiceCompanion id={1} />);
  await screen.findByText('和小杯说说话');
  fireEvent.change(screen.getByRole('textbox'), { target: { value: '原草稿' } });
  fireEvent.click(screen.getByRole('button', { name: '开始录音' }));
  await screen.findByRole('button', { name: '停止录音' });
  act(() => track.dispatchEvent(new Event('ended')));
  expect(await screen.findByRole('button', { name: '试听录音' })).toBeEnabled();
  expect(screen.getByText(/麦克风连接已中断/)).toBeInTheDocument();
  expect(screen.getByRole('textbox')).toHaveValue('原草稿');
  if (mode === 'pcm') expect(pcmStop).toHaveBeenCalledOnce();
  else expect(track.stop).toHaveBeenCalledOnce();
  const next = Object.assign(new EventTarget(), { stop: vi.fn(), readyState: 'live' });
  vi.mocked(navigator.mediaDevices.getUserMedia).mockResolvedValue({ getTracks: () => [next] } as unknown as MediaStream);
  fireEvent.click(screen.getByRole('button', { name: '重新录制' }));
  await screen.findByRole('button', { name: '停止录音' });
  act(() => track.dispatchEvent(new Event('ended')));
  expect(screen.getByRole('button', { name: '停止录音' })).toBeEnabled();
  expect(voiceApi.transcribe).not.toHaveBeenCalled();
  expect(voiceApi.send).not.toHaveBeenCalled();
});

it('rejects a device that ends during PCM setup without replacing the previous draft', async () => {
  render(<VoiceCompanion id={1} />); await record();
  vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue('Code/1.0 Electron/1.0');
  const track = { readyState: 'live', stop: vi.fn() }, cancel = vi.fn();
  let resolve!: (capture: Awaited<ReturnType<typeof startWavCapture>>) => void;
  vi.mocked(navigator.mediaDevices.getUserMedia).mockResolvedValue({ getTracks: () => [track] } as unknown as MediaStream);
  vi.mocked(startWavCapture).mockReturnValue(new Promise(done => { resolve = done; }));
  fireEvent.click(screen.getByRole('button', { name: '重新录制' }));
  await waitFor(() => expect(startWavCapture).toHaveBeenCalledOnce());
  track.readyState = 'ended'; resolve({ cancel, stop: vi.fn() });
  expect(await screen.findByText(/麦克风已断开/)).toBeInTheDocument();
  expect(cancel).toHaveBeenCalledOnce();
  expect(screen.getByRole('button', { name: '试听录音' })).toBeEnabled();
  expect(voiceApi.send).not.toHaveBeenCalled();
});

it('stops at 60 seconds and waits for explicit sending', async () => {
  const clock = vi.spyOn(performance, 'now').mockReturnValue(0);
  render(<VoiceCompanion id={1} />);
  await screen.findByText('和小杯说说话');
  fireEvent.click(screen.getByRole('button', { name: '开始录音' }));
  await screen.findByRole('button', { name: '停止录音' });
  clock.mockReturnValue(60_000);
  expect(await screen.findByText(/已录满60秒/)).toBeInTheDocument();
  expect(screen.getByRole('button', { name: '试听录音' })).toBeEnabled();
  expect(screen.queryByRole('button', { name: '停止录音' })).not.toBeInTheDocument();
  expect(voiceApi.transcribe).not.toHaveBeenCalled();
  expect(voiceApi.send).not.toHaveBeenCalled();
  clock.mockRestore();
});

it.each(['visibilitychange', 'pagehide'])('stops capture on %s without uploading or resuming it, preserving the draft', async event => {
  const stopTrack = vi.fn();
  vi.mocked(navigator.mediaDevices.getUserMedia).mockResolvedValue({ getTracks: () => [{ stop: stopTrack }] } as unknown as MediaStream);
  render(<VoiceCompanion id={1} />);
  await screen.findByText('和小杯说说话');
  fireEvent.change(screen.getByRole('textbox'), { target: { value: '保留我的文字' } });
  fireEvent.click(screen.getByRole('button', { name: '开始录音' }));
  await screen.findByRole('button', { name: '停止录音' });
  if (event === 'visibilitychange') {
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
    fireEvent(document, new Event(event));
  } else fireEvent(window, new Event(event));
  expect(await screen.findByRole('button', { name: '试听录音' })).toBeEnabled();
  expect(stopTrack).toHaveBeenCalled();
  expect(screen.getByRole('textbox')).toHaveValue('保留我的文字');
  expect(screen.getByText(/页面已切到后台，录音已停止/)).toBeInTheDocument();
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
  fireEvent(document, new Event('visibilitychange'));
  expect(screen.queryByRole('button', { name: '停止录音' })).not.toBeInTheDocument();
  expect(navigator.mediaDevices.getUserMedia).toHaveBeenCalledTimes(1);
  expect(voiceApi.transcribe).not.toHaveBeenCalled();
  expect(voiceApi.send).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: '重新录制' }));
  await screen.findByRole('button', { name: '停止录音' });
  expect(navigator.mediaDevices.getUserMedia).toHaveBeenCalledTimes(2);
});

it('releases a late microphone permission after leaving and returning without replacing the old draft', async () => {
  render(<VoiceCompanion id={1} />); await record();
  fireEvent.change(screen.getByRole('textbox'), { target: { value: '原来的文字' } });
  let resolve!: (stream: MediaStream) => void;
  const stopTrack = vi.fn(), startRecorder = vi.spyOn(MediaRecorder.prototype, 'start');
  vi.mocked(navigator.mediaDevices.getUserMedia).mockReturnValue(new Promise(done => { resolve = done; }));
  fireEvent.click(screen.getByRole('button', { name: '重新录制' }));
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
  fireEvent(document, new Event('visibilitychange'));
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
  fireEvent(document, new Event('visibilitychange'));
  resolve({ getTracks: () => [{ stop: stopTrack }] } as unknown as MediaStream);
  await waitFor(() => expect(screen.getByRole('button', { name: '试听录音' })).toBeEnabled());
  expect(stopTrack).toHaveBeenCalledOnce();
  expect(startRecorder).not.toHaveBeenCalled();
  expect(screen.getByRole('textbox')).toHaveValue('原来的文字');
  expect(voiceApi.transcribe).not.toHaveBeenCalled();
  expect(voiceApi.send).not.toHaveBeenCalled();
});

it('cancels a late PCM setup after pagehide and retains the previous recording', async () => {
  render(<VoiceCompanion id={1} />); await record();
  vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue('Code/1.0 Electron/1.0');
  let resolve!: (capture: Awaited<ReturnType<typeof startWavCapture>>) => void;
  const cancel = vi.fn(), stop = vi.fn(), stopTrack = vi.fn();
  vi.mocked(navigator.mediaDevices.getUserMedia).mockResolvedValue({ getTracks: () => [{ stop: stopTrack }] } as unknown as MediaStream);
  vi.mocked(startWavCapture).mockReturnValue(new Promise(done => { resolve = done; }));
  fireEvent.click(screen.getByRole('button', { name: '重新录制' }));
  await waitFor(() => expect(startWavCapture).toHaveBeenCalledOnce());
  fireEvent(window, new Event('pagehide'));
  expect(stopTrack).toHaveBeenCalled();
  resolve({ cancel, stop });
  await waitFor(() => expect(screen.getByRole('button', { name: '试听录音' })).toBeEnabled());
  expect(cancel).toHaveBeenCalledOnce();
  expect(stop).not.toHaveBeenCalled();
  expect(screen.queryByRole('button', { name: '停止录音' })).not.toBeInTheDocument();
  expect(voiceApi.transcribe).not.toHaveBeenCalled();
  expect(voiceApi.send).not.toHaveBeenCalled();
});

it('treats missing status as unavailable and rejects unknown status', () => {
  expect(parseVoiceSettings(base).transcription_status).toBe('unconfigured');
  expect(() => parseVoiceSettings({ ...base, transcription_status: 'success' })).toThrow();
});

it('does not play a late voice preview after the page was hidden and returned', async () => {
  vi.mocked(voiceApi.settings).mockResolvedValue(parseVoiceSettings({ ...configured, voice: 'qwen:Cherry', voices: [{ id: 'qwen:Cherry', label: 'Cherry' }] }));
  let resolve!: (audio: Blob) => void;
  vi.mocked(voiceApi.preview).mockReturnValue(new Promise(done => { resolve = done; }));
  const play = vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined);
  render(<VoiceCompanion id={1} />);
  await screen.findByText('和小杯说说话');
  fireEvent.click(screen.getByRole('button', { name: '试听，不发送消息' }));
  await waitFor(() => expect(voiceApi.preview).toHaveBeenCalledOnce());
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
  fireEvent(document, new Event('visibilitychange'));
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
  fireEvent(document, new Event('visibilitychange'));
  resolve(new Blob(['audio']));
  await waitFor(() => expect(screen.getByRole('button', { name: '试听，不发送消息' })).toBeEnabled());
  expect(play).not.toHaveBeenCalled();
  expect(voiceApi.send).not.toHaveBeenCalled();
});

const liveSession = { state: 'active', remaining_rounds: 9, used_rounds: 1, max_rounds: 10, budget_micro: 12000000, reserved_micro: 1145600, expires_at: 1900000000 };

it('shows live allowance and explicitly ends it without losing the unsent recording', async () => {
  vi.mocked(voiceApi.settings).mockResolvedValue(parseVoiceSettings({ ...configured, reply_origin: 'configured_model', live_session: liveSession }));
  vi.mocked(voiceApi.endSession).mockResolvedValue(parseVoiceSettings({ ...configured, reply_origin: 'disabled', live_session: { ...liveSession, state: 'revoked' } }));
  render(<VoiceCompanion id={1} />); await record();
  fireEvent.change(screen.getByRole('textbox'), { target: { value: '还没有发送的下一句' } });
  expect(screen.getByText(/还可聊 9 轮/)).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: '结束真实聊天' }));
  await screen.findByRole('heading', { name: '真实聊天已结束' });
  expect(screen.getByRole('textbox')).toHaveValue('还没有发送的下一句');
  expect(screen.getByRole('button', { name: '发送录音与文字' })).toBeDisabled();
  expect(screen.getByRole('button', { name: '试听录音' })).toBeEnabled();
  expect(voiceApi.endSession).toHaveBeenCalledTimes(1);
  expect(voiceApi.send).not.toHaveBeenCalled();
});

it('keeps a budget-rejected recording editable and refreshes the exhausted session without resending', async () => {
  vi.mocked(voiceApi.settings).mockResolvedValueOnce(parseVoiceSettings({ ...configured, reply_origin: 'configured_model', live_session: liveSession }))
    .mockResolvedValue(parseVoiceSettings({ ...configured, reply_origin: 'disabled', live_session: { ...liveSession, state: 'exhausted', used_rounds: 10, remaining_rounds: 0, reserved_micro: 11456000 } }));
  vi.mocked(voiceApi.send).mockRejectedValue(new ApiError('轮数已用完，录音未发送', 409, 'voice_session_unavailable'));
  render(<VoiceCompanion id={1} />); await record();
  fireEvent.change(screen.getByRole('textbox'), { target: { value: '保留这句话' } });
  fireEvent.click(screen.getByRole('button', { name: '发送录音与文字' }));
  await screen.findByRole('heading', { name: '本次真实聊天轮数已用完' });
  expect(screen.getByRole('textbox')).toHaveValue('保留这句话');
  expect(screen.getByRole('textbox')).toBeEnabled();
  expect(screen.getByRole('button', { name: '重新录制' })).toBeEnabled();
  expect(screen.getByRole('button', { name: '发送录音与文字' })).toBeDisabled();
  expect(voiceApi.send).toHaveBeenCalledTimes(1);
});

it('rejects an unknown live allowance or inconsistent remaining rounds', () => {
  expect(parseVoiceSettings(base).live_session).toBeNull();
  for (const extra of [{ state: 'unknown' }, { remaining_rounds: 10 }, { used_rounds: -1 }, { reserved_micro: 13000000 }]) {
    expect(() => parseVoiceSettings({ ...base, live_session: { ...liveSession, ...extra } })).toThrow();
  }
});

it('does not upload when unavailable and refreshes config without clearing the draft', async () => {
  vi.mocked(voiceApi.settings).mockResolvedValueOnce(parseVoiceSettings(base)).mockResolvedValue(configured);
  render(<VoiceCompanion id={1} />); await record();
  fireEvent.change(screen.getByRole('textbox'), { target: { value: '我自己写的文字' } });
  expect(screen.getByRole('button', { name: '识别录音文字' })).toBeDisabled();
  expect(voiceApi.transcribe).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: '检查识别配置' }));
  await waitFor(() => expect(screen.getByRole('button', { name: '识别录音文字' })).toBeEnabled());
  expect(screen.getByRole('textbox')).toHaveValue('我自己写的文字');
  expect(screen.getByRole('button', { name: '试听录音' })).toBeEnabled();
  expect(voiceApi.transcribe).not.toHaveBeenCalled();
});

it('retains the clip and text after failure and retries that clip only on demand', async () => {
  vi.mocked(voiceApi.transcribe).mockRejectedValueOnce(new Error('识别超时')).mockResolvedValueOnce('今天很开心');
  render(<VoiceCompanion id={1} />); await record();
  fireEvent.change(screen.getByRole('textbox'), { target: { value: '原文字' } });
  fireEvent.click(screen.getByRole('button', { name: '识别录音文字' }));
  await screen.findByText('识别超时');
  expect(screen.getByRole('textbox')).toHaveValue('原文字');
  expect(voiceApi.transcribe).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByRole('button', { name: '重试识别' }));
  await screen.findByText('识别完成，请核对文字后再发送。');
  expect(screen.getByRole('textbox')).toHaveValue('今天很开心');
  expect(voiceApi.transcribe).toHaveBeenCalledTimes(2);
  expect(vi.mocked(voiceApi.transcribe).mock.calls[0][1]).toBe(vi.mocked(voiceApi.transcribe).mock.calls[1][1]);
  expect(voiceApi.send).not.toHaveBeenCalled();
});

it('shows no-speech feedback without sending or clearing the draft', async () => {
  vi.mocked(voiceApi.transcribe).mockRejectedValue(new ApiError('没有识别到可用文字，请重录或自己填写', 422, 'no_speech'));
  render(<VoiceCompanion id={1} />); await record();
  fireEvent.change(screen.getByRole('textbox'), { target: { value: '自己填写的文字' } });
  fireEvent.click(screen.getByRole('button', { name: '识别录音文字' }));
  await screen.findByText('没有识别到可用文字，请重录或自己填写');
  expect(screen.getByRole('textbox')).toHaveValue('自己填写的文字');
  expect(screen.getByRole('button', { name: '重新录制' })).toBeEnabled();
  expect(voiceApi.send).not.toHaveBeenCalled();
});

it('shows recording playback and completion beside the preview button, then clears it on cancel', async () => {
  let elapsed = 1000;
  const clock = vi.spyOn(performance, 'now').mockImplementation(() => elapsed);
  const play = vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue();
  const create = vi.fn(() => 'blob:voice-preview');
  const revoke = vi.fn();
  Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: create });
  Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: revoke });
  render(<VoiceCompanion id={1} />);
  await screen.findByText('和小杯说说话');
  fireEvent.click(screen.getByRole('button', { name: '开始录音' }));
  await screen.findByRole('button', { name: '停止录音' });
  elapsed = 7100;
  fireEvent.click(screen.getByRole('button', { name: '停止录音' }));
  clock.mockRestore();
  expect(screen.getByText('录音已停止 · 约 6 秒，等待发送')).toBeInTheDocument();
  const player = screen.getByLabelText('未发送录音试听播放器') as HTMLAudioElement;
  expect(screen.getByText(/已播放 0 秒 \/ 录音约 6 秒/)).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: '试听录音' }));
  await screen.findByText(/正在播放录音 · 已播放 0 秒 \/ 录音约 6 秒/);
  expect(play).toHaveBeenCalledTimes(1);
  expect(create).toHaveBeenCalledTimes(1);
  player.currentTime = 2.4;
  fireEvent.timeUpdate(player);
  expect(screen.getByText(/已播放 2 秒 \/ 录音约 6 秒/)).toBeInTheDocument();
  expect(screen.getByRole('progressbar', { name: '录音试听进度' })).toHaveAttribute('max', '6');
  fireEvent.click(screen.getByRole('button', { name: '暂停试听' }));
  fireEvent.pause(player);
  expect(screen.getByRole('button', { name: '继续试听' })).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: '继续试听' }));
  await screen.findByRole('button', { name: '暂停试听' });
  fireEvent.ended(player);
  expect(screen.getByText(/录音播放完毕 · 已播放 6 秒 \/ 录音约 6 秒/)).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: '取消录音' }));
  await waitFor(() => expect(revoke).toHaveBeenCalledWith('blob:voice-preview'));
  expect(screen.queryByLabelText('未发送录音试听播放器')).not.toBeInTheDocument();
  expect(voiceApi.send).not.toHaveBeenCalled();
  expect(voiceApi.transcribe).not.toHaveBeenCalled();
});

it('shows recording playback failure next to the clip without sending it', async () => {
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockRejectedValue(new Error('play blocked'));
  Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: vi.fn(() => 'blob:voice-preview') });
  Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: vi.fn() });
  render(<VoiceCompanion id={1} />); await record();
  fireEvent.click(screen.getByRole('button', { name: '试听录音' }));
  expect(await screen.findByText(/录音试听失败，请重新录制或改用文字。 · 已播放/)).toBeInTheDocument();
  expect(screen.getByLabelText('未发送录音试听播放器')).toBeInTheDocument();
  expect(voiceApi.send).not.toHaveBeenCalled();
});

it('waits for the final recorder data before releasing the microphone or enabling preview', async () => {
  const release = vi.fn();
  Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: { getUserMedia: vi.fn().mockResolvedValue({ getTracks: () => [{ stop: release }] }) } });
  class DeferredRecorder {
    static isTypeSupported() { return true; }
    static latest: DeferredRecorder | null = null;
    state = 'inactive'; mimeType = 'audio/webm';
    ondataavailable?: (event: { data: Blob }) => void; onstop?: () => void;
    constructor() { DeferredRecorder.latest = this; }
    start() { this.state = 'recording'; }
    stop() { this.state = 'inactive'; }
    finish(data: Blob) { this.ondataavailable?.({ data }); this.onstop?.(); }
  }
  vi.stubGlobal('MediaRecorder', DeferredRecorder);
  render(<VoiceCompanion id={1} />);
  await screen.findByText('和小杯说说话');
  fireEvent.click(screen.getByRole('button', { name: '开始录音' }));
  fireEvent.click(await screen.findByRole('button', { name: '停止录音' }));
  expect(screen.getByText('正在整理录音…')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: '开始录音' })).toBeDisabled();
  expect(release).not.toHaveBeenCalled();
  DeferredRecorder.latest!.finish(new Blob(['finished audio'], { type: 'audio/webm' }));
  expect(await screen.findByRole('button', { name: '试听录音' })).toBeEnabled();
  expect(release).toHaveBeenCalledTimes(1);
  expect(voiceApi.send).not.toHaveBeenCalled();
});

it('rejects an empty completed recording instead of offering a broken preview', async () => {
  class EmptyRecorder {
    static isTypeSupported() { return true; }
    state = 'inactive'; mimeType = 'audio/webm';
    ondataavailable?: (event: { data: Blob }) => void; onstop?: () => void;
    start() { this.state = 'recording'; }
    stop() { this.state = 'inactive'; this.ondataavailable?.({ data: new Blob([]) }); this.onstop?.(); }
  }
  vi.stubGlobal('MediaRecorder', EmptyRecorder);
  render(<VoiceCompanion id={1} />); await record();
  expect(await screen.findByText('这次录音没有生成音频，请重新录制；已填写的文字会保留。')).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: '试听录音' })).not.toBeInTheDocument();
  expect(voiceApi.send).not.toHaveBeenCalled();
});

it('stops and releases an old recording preview before re-recording', async () => {
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue();
  const pause = vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {});
  const revoke = vi.fn();
  Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: vi.fn(() => 'blob:old-recording') });
  Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: revoke });
  render(<VoiceCompanion id={1} />); await record();
  fireEvent.click(screen.getByRole('button', { name: '试听录音' }));
  await screen.findByText(/正在播放录音 · 已播放/);
  fireEvent.click(screen.getByRole('button', { name: '重新录制' }));
  await waitFor(() => expect(revoke).toHaveBeenCalledWith('blob:old-recording'));
  expect(pause).toHaveBeenCalled();
  expect(screen.queryByLabelText('未发送录音试听播放器')).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: '停止录音' })).toBeEnabled();
  fireEvent.click(screen.getByRole('button', { name: '取消录音' }));
  expect(voiceApi.send).not.toHaveBeenCalled();
});

it('retries only an unavailable assistant audio after a user click', async () => {
  const missing = { id: 'audio-1', message_id: 2, role: 'assistant', origin: 'offline_fixture' as const, state: 'unavailable', created_at: 100, expires_at: 9999999999 };
  vi.mocked(api.messages).mockResolvedValue([{ id: 2, role: 'assistant', content: '你好' }] as Awaited<ReturnType<typeof api.messages>>);
  vi.mocked(voiceApi.history).mockResolvedValueOnce([missing]).mockResolvedValue([{ ...missing, state: 'ready' }]);
  vi.mocked(voiceApi.retryAudio).mockResolvedValue({ id: 'audio-1', state: 'ready', expires_at: 9999999999 });
  render(<VoiceCompanion id={1} />);
  expect(await screen.findByRole('button', { name: '恢复回复音频' })).toBeEnabled();
  expect(voiceApi.retryAudio).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: '恢复回复音频' }));
  await screen.findByText('回复音频已生成，请点“播放 / 重播”收听。');
  expect(voiceApi.retryAudio).toHaveBeenCalledTimes(1);
  expect(voiceApi.retryAudio).toHaveBeenCalledWith(1, 'audio-1');
  expect(screen.getByRole('button', { name: '播放 / 重播' })).toBeEnabled();
  expect(voiceApi.send).not.toHaveBeenCalled();
});

it('checks an uncertain audio retry only with reads, without repeating generation', async () => {
  const missing = { id: 'audio-1', message_id: 2, role: 'assistant', origin: 'offline_fixture' as const, state: 'unavailable', created_at: 100, expires_at: 9999999999 };
  vi.mocked(api.messages).mockResolvedValue([{ id: 2, role: 'assistant', content: '你好' }] as Awaited<ReturnType<typeof api.messages>>);
  vi.mocked(voiceApi.history).mockResolvedValue([missing]);
  vi.mocked(voiceApi.retryAudio).mockRejectedValue(new Error('connection lost'));
  render(<VoiceCompanion id={1} />);
  fireEvent.click(await screen.findByRole('button', { name: '恢复回复音频' }));
  await screen.findByText(/暂时无法确认音频重试结果/);
  expect(voiceApi.retryAudio).toHaveBeenCalledTimes(1);
  expect(voiceApi.history).toHaveBeenCalledTimes(2);
  expect(voiceApi.send).not.toHaveBeenCalled();
});

it('does not offer generation for user, deleted, or expired audio', async () => {
  vi.mocked(api.messages).mockResolvedValue([{ id: 2, role: 'assistant', content: '你好' }] as Awaited<ReturnType<typeof api.messages>>);
  vi.mocked(voiceApi.history).mockResolvedValue([
    { id: 'user-1', message_id: 2, role: 'user', origin: 'offline_fixture', state: 'unavailable', created_at: 100, expires_at: 9999999999 },
    { id: 'deleted-1', message_id: 2, role: 'assistant', origin: 'offline_fixture', state: 'deleted', created_at: 100, expires_at: 9999999999 },
    { id: 'expired-1', message_id: 2, role: 'assistant', origin: 'offline_fixture', state: 'expired', created_at: 100, expires_at: 9999999999 },
  ]);
  render(<VoiceCompanion id={1} />);
  await screen.findByText('和小杯说说话');
  expect(screen.queryByRole('button', { name: '恢复回复音频' })).not.toBeInTheDocument();
});

it('shows a persisted voice scene proposal and executes it only after confirmation', async () => {
  vi.mocked(api.scene).mockResolvedValue({ ...emptyScene, proposal: { id: 'proposal-1', action: 'plant_tree' } });
  vi.mocked(api.decide).mockResolvedValue({ ...emptyScene, elements: { ...emptyScene.elements, tree: 1 }, feedback: '树已经种好。' });
  render(<VoiceCompanion id={1} />);
  await screen.findByText(/确认后才会改变家庭庭院/);
  expect(api.decide).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: '确认执行' }));
  await screen.findByText('树已经种好。');
  expect(api.decide).toHaveBeenCalledExactlyOnceWith(1, 'proposal-1', 'confirm');
  expect(screen.queryByRole('button', { name: '确认执行' })).not.toBeInTheDocument();
  expect(voiceApi.send).not.toHaveBeenCalled();
});

it('loads a new proposal after a completed voice send without executing it', async () => {
  vi.mocked(api.scene).mockResolvedValueOnce(emptyScene).mockResolvedValue({
    ...emptyScene, proposal: { id: 'proposal-after-send', action: 'plant_tree' },
  });
  vi.mocked(voiceApi.send).mockResolvedValue({ state: 'completed', error: null });
  render(<VoiceCompanion id={1} />); await record();
  fireEvent.change(screen.getByRole('textbox'), { target: { value: '种一棵树' } });
  fireEvent.click(screen.getByRole('button', { name: '发送录音与文字' }));
  await screen.findByText(/确认后才会改变家庭庭院/);
  expect(api.scene).toHaveBeenCalledTimes(2);
  expect(api.decide).not.toHaveBeenCalled();
});

it('checks scene state after an uncertain decision without posting again', async () => {
  vi.mocked(api.scene).mockResolvedValueOnce({ ...emptyScene, proposal: { id: 'proposal-2', action: 'plant_tree' } }).mockResolvedValue(emptyScene);
  vi.mocked(api.decide).mockRejectedValue(new Error('连接中断'));
  render(<VoiceCompanion id={1} />);
  fireEvent.click(await screen.findByRole('button', { name: '先不了' }));
  await screen.findByText('连接中断');
  expect(api.decide).toHaveBeenCalledExactlyOnceWith(1, 'proposal-2', 'reject');
  expect(api.scene).toHaveBeenCalledTimes(2);
  expect(screen.queryByRole('button', { name: '先不了' })).not.toBeInTheDocument();
});


it('queries an uncertain send without posting again, including after a missing receipt', async () => {
  vi.mocked(voiceApi.send).mockRejectedValue(new Error('connection lost'));
  vi.mocked(voiceApi.receipt).mockRejectedValue(new Error('not found'));
  render(<VoiceCompanion id={1} />); await record();
  fireEvent.change(screen.getByRole('textbox'), { target: { value: '原文字' } });
  fireEvent.click(screen.getByRole('button', { name: '发送录音与文字' }));
  await screen.findByText(/发送结果待核对，原录音/);
  expect(voiceApi.send).toHaveBeenCalledTimes(1);
  expect(screen.getByRole('textbox')).toBeDisabled();
  expect(screen.getByRole('button', { name: '发送录音与文字' })).toBeDisabled();
  fireEvent.click(screen.getByRole('button', { name: '核对发送结果' }));
  await screen.findByText(/暂时未能核对发送结果/);
  expect(screen.getByRole('textbox')).toHaveValue('原文字');
  expect(screen.getByRole('button', { name: '重新录制' })).toBeDisabled();
  vi.mocked(voiceApi.receipt).mockImplementation(async (_id, rid) => ({ id: rid, state: 'failed', error: 'reply_unavailable', origin: 'offline_fixture', created_at: 1, reply_message_id: null }));
  fireEvent.click(screen.getByRole('button', { name: '核对发送结果' }));
  await screen.findByText('回复失败，已接收的录音和文字保留在聊天记录中');
  expect(voiceApi.send).toHaveBeenCalledTimes(1);
  expect(voiceApi.receipt).toHaveBeenCalledTimes(3); // Initial progress lookup plus two explicit checks.
  expect(vi.mocked(voiceApi.receipt).mock.calls[0][1]).toBe(vi.mocked(voiceApi.send).mock.calls[0][3]);
  expect(screen.getByRole('button', { name: '开始录音' })).toBeEnabled();
});

it('restores a processing receipt and releases only after read-only refresh sees completion', async () => {
  const running = { id: 'old', state: 'text_ready', error: null, origin: 'offline_fixture' as const, created_at: 1, reply_message_id: null };
  vi.mocked(voiceApi.receipts).mockResolvedValueOnce([running]).mockResolvedValue([{ ...running, state: 'completed' }]);
  render(<VoiceCompanion id={1} />);
  await screen.findByText(/文字回复已保存，正在准备音频/);
  expect(screen.getByRole('button', { name: '开始录音' })).toBeDisabled();
  fireEvent.click(screen.getByRole('button', { name: '核对发送结果' }));
  await screen.findByText(/录音和回复已保存/);
  expect(screen.getByRole('button', { name: '开始录音' })).toBeEnabled();
  expect(voiceApi.send).not.toHaveBeenCalled();
});

it('releases a waiting POST after a saved receipt and permits the next recording without resending', async () => {
  let sendSignal: AbortSignal | undefined;
  vi.mocked(voiceApi.send).mockImplementation((_id, _clip, _text, _rid, signal) => {
    sendSignal = signal;
    return new Promise((_resolve, reject) => signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true }));
  });
  vi.mocked(voiceApi.receipt).mockImplementation(async (_id, rid) => ({ id: rid, state: 'completed', error: null, origin: 'offline_fixture', created_at: 1, reply_message_id: null }));
  vi.mocked(voiceApi.settings).mockResolvedValueOnce(configured).mockResolvedValue({ ...configured, mood: 'tired', mood_source: 'suggested' });
  render(<VoiceCompanion id={1} />); await record();
  fireEvent.change(screen.getByRole('textbox'), { target: { value: '第一轮' } });
  fireEvent.click(screen.getByRole('button', { name: '发送录音与文字' }));
  await waitFor(() => expect(screen.getByRole('button', { name: '开始录音' })).toBeEnabled());
  expect(sendSignal?.aborted).toBe(true);
  expect(screen.getByRole('textbox')).toHaveValue('');
  await screen.findByText('这是根据文字提出的候选，你可以纠正。');
  expect(screen.getAllByRole('combobox')[0]).toHaveValue('tired');
  await record();
  fireEvent.change(screen.getByRole('textbox'), { target: { value: '第二轮的新草稿' } });
  expect(screen.getByRole('button', { name: '发送录音与文字' })).toBeEnabled();
  expect(voiceApi.send).toHaveBeenCalledTimes(1);
  expect(screen.queryByText(/发送结果待核对/)).not.toBeInTheDocument();
  const firstId = vi.mocked(voiceApi.send).mock.calls[0][3];
  fireEvent.click(screen.getByRole('button', { name: '发送录音与文字' }));
  await waitFor(() => expect(screen.getByRole('button', { name: '开始录音' })).toBeEnabled());
  expect(voiceApi.send).toHaveBeenCalledTimes(2);
  expect(vi.mocked(voiceApi.send).mock.calls[1][3]).not.toBe(firstId);
  expect(vi.mocked(voiceApi.send).mock.calls[1][2]).toBe('第二轮的新草稿');
});

it.each(['running', 'text_ready'])('keeps an unresolved %s send locked and aborts its connection only on unmount', async state => {
  let sendSignal: AbortSignal | undefined;
  vi.mocked(voiceApi.send).mockImplementation((_id, _clip, _text, _rid, signal) => {
    sendSignal = signal;
    return new Promise((_resolve, reject) => signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true }));
  });
  vi.mocked(voiceApi.receipt).mockImplementation(async (_id, rid) => ({ id: rid, state, error: null, origin: 'offline_fixture', created_at: 1, reply_message_id: null }));
  const view = render(<VoiceCompanion id={1} />); await record();
  fireEvent.change(screen.getByRole('textbox'), { target: { value: '仍待核对' } });
  fireEvent.click(screen.getByRole('button', { name: '发送录音与文字' }));
  await screen.findByText(receiptLabel({ state, error: null }));
  expect(sendSignal?.aborted).toBe(false);
  expect(screen.getByRole('textbox')).toHaveValue('仍待核对');
  expect(screen.getByRole('textbox')).toBeDisabled();
  expect(screen.getByRole('button', { name: '重新录制' })).toBeDisabled();
  view.unmount();
  expect(sendSignal?.aborted).toBe(true);
  expect(voiceApi.send).toHaveBeenCalledTimes(1);
});

it('rejects unknown receipt states and distinguishes audio-only failure', () => {
  expect(() => parseVoiceReceipt({ id: 'r', state: 'unknown', error: null, created_at: 1 })).toThrow();
  expect(receiptLabel({ state: 'completed', error: 'audio_unavailable' })).toBe('文字回复已保存，回复音频暂不可用');
  expect(receiptLabel({ state: 'cancelled', error: 'history_cleared' })).toContain('已取消');
});

it('asks before leaving with an unsent clip and cancel keeps the draft', async () => {
  render(<VoiceCompanion id={1} />); await record();
  fireEvent.change(screen.getByRole('textbox'), { target: { value: '未发文字' } });
  fireEvent.click(screen.getByRole('link', { name: '回到文字聊天' }));
  expect(await screen.findByRole('dialog', { name: '离开说话页面？' })).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: '继续留在这里' }));
  expect(screen.queryByRole('dialog', { name: '离开说话页面？' })).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: '试听录音' })).toBeEnabled();
  expect(screen.getByRole('textbox')).toHaveValue('未发文字');
  expect(voiceApi.send).not.toHaveBeenCalled();
  expect(voiceApi.transcribe).not.toHaveBeenCalled();
});

it('guards browser back and uses the native warning for refresh', async () => {
  const go = vi.spyOn(history, 'go').mockImplementation(() => {});
  render(<VoiceCompanion id={1} />); await record();
  await waitFor(() => expect(history.state?.__aiwwbVoiceDraftGuard).toBe(true));
  const reload = new Event('beforeunload', { cancelable: true });
  window.dispatchEvent(reload);
  expect(reload.defaultPrevented).toBe(true);
  window.dispatchEvent(new PopStateEvent('popstate'));
  expect(await screen.findByRole('dialog', { name: '离开说话页面？' })).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: '丢弃录音并离开' }));
  expect(go).toHaveBeenCalledWith(-2);
  expect(voiceApi.send).not.toHaveBeenCalled();
});

it('restores only text for the same account and clears it after send', async () => {
  localStorage.setItem('aiwwb-token', 'account-one');
  const key = await voiceDraftKey('account-one', 1);
  const other = await voiceDraftKey('account-two', 1);
  const first = render(<VoiceCompanion id={1} />);
  await screen.findByText('和小杯说说话');
  fireEvent.change(screen.getByRole('textbox'), { target: { value: '仅文字草稿' } });
  await waitFor(() => expect(sessionStorage.getItem(key)).toBe('仅文字草稿'));
  expect(sessionStorage.getItem(other)).toBeNull();
  first.unmount();
  localStorage.setItem('aiwwb-token', 'account-two');
  const second = render(<VoiceCompanion id={1} />);
  await screen.findByText('和小杯说说话');
  expect(screen.getByRole('textbox')).toHaveValue('');
  second.unmount();
  localStorage.setItem('aiwwb-token', 'account-one');
  render(<VoiceCompanion id={1} />);
  await waitFor(() => expect(screen.getByRole('textbox')).toHaveValue('仅文字草稿'));
  await record();
  vi.mocked(voiceApi.send).mockResolvedValue({ state: 'completed', error: null });
  fireEvent.click(screen.getByRole('button', { name: '发送录音与文字' }));
  await screen.findByText('录音和回复已保存');
  await waitFor(() => expect(sessionStorage.getItem(key)).toBeNull());
});

it('shows a new, correctable mood suggestion after a completed voice send', async () => {
  const suggested = parseVoiceSettings({ ...base, mood: 'tired', mood_source: 'suggested', transcription_status: 'configured' });
  vi.mocked(voiceApi.settings).mockResolvedValueOnce(configured).mockResolvedValueOnce(suggested);
  vi.mocked(voiceApi.send).mockResolvedValue({ state: 'completed', error: null });
  render(<VoiceCompanion id={1} />); await record();
  fireEvent.change(screen.getByRole('textbox'), { target: { value: '我今天有点累' } });
  fireEvent.click(screen.getByRole('button', { name: '发送录音与文字' }));
  await screen.findByText('这是根据文字提出的候选，你可以纠正。');
  expect(screen.getAllByRole('combobox')[0]).toHaveValue('tired');
  expect(screen.getByText('录音和回复已保存')).toBeInTheDocument();
  expect(voiceApi.send).toHaveBeenCalledTimes(1);
});

it('keeps a completed voice send completed when refreshing the mood fails', async () => {
  vi.mocked(voiceApi.settings).mockResolvedValueOnce(configured).mockRejectedValueOnce(new Error('设置暂时不可读取'));
  vi.mocked(voiceApi.send).mockResolvedValue({ state: 'completed', error: null });
  render(<VoiceCompanion id={1} />); await record();
  fireEvent.change(screen.getByRole('textbox'), { target: { value: '我今天有点累' } });
  fireEvent.click(screen.getByRole('button', { name: '发送录音与文字' }));
  await waitFor(() => expect(voiceApi.settings).toHaveBeenCalledTimes(2));
  expect(screen.getByText('录音和回复已保存')).toBeInTheDocument();
  expect(screen.queryByText(/发送结果待核对/)).not.toBeInTheDocument();
  expect(voiceApi.send).toHaveBeenCalledTimes(1);
});


it('keeps a rejected audio draft editable without resubmitting automatically', async () => {
  vi.mocked(voiceApi.send).mockRejectedValue(new ApiError('这段录音没有可辨的声音，请重录或改用文字', 400, 'invalid_request'));
  render(<VoiceCompanion id={1} />); await record();
  fireEvent.change(screen.getByRole('textbox'), { target: { value: '草稿' } });
  fireEvent.click(screen.getByRole('button', { name: '发送录音与文字' }));
  await screen.findByText('这段录音没有可辨的声音，请重录或改用文字');
  expect(screen.getByRole('textbox')).toHaveValue('草稿');
  expect(screen.getByRole('textbox')).toBeEnabled();
  expect(screen.getByRole('button', { name: '重新录制' })).toBeEnabled();
  expect(voiceApi.send).toHaveBeenCalledTimes(1);
});
