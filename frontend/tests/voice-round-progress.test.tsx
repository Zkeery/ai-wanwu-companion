import React from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import VoiceRoundProgress from '@/components/voice-round-progress';
import { api, ApiError } from '@/lib/api';
import { voiceApi, type VoiceReceipt } from '@/lib/voice';
import { TOKEN_KEY } from '@/lib/auth';

vi.mock('@/lib/api', async load => ({ ...await load<typeof import('@/lib/api')>(), api: { messages: vi.fn() } }));
vi.mock('@/lib/voice', async load => ({ ...await load<typeof import('@/lib/voice')>(), voiceApi: { receipt: vi.fn(), history: vi.fn(), blob: vi.fn() } }));
const receipt = (state: string): VoiceReceipt => ({ id:'round',state,error:null,origin:'configured_model',created_at:1,reply_message_id:2 });
const message = { id:2,role:'assistant' as const,content:'先歇会儿吧。',created_at:'2026-09-29' };
const audio = { id:'audio',message_id:2,role:'assistant',state:'ready',origin:'configured_model' as const,created_at:1,expires_at:9999999999 };
beforeEach(() => {
  vi.resetAllMocks(); vi.useFakeTimers(); localStorage.setItem(TOKEN_KEY,'one');
  Object.defineProperty(document,'hidden',{configurable:true,value:false});
  vi.mocked(api.messages).mockResolvedValue([message]);
  vi.mocked(voiceApi.history).mockResolvedValue([audio]);
  vi.mocked(voiceApi.blob).mockResolvedValue(new Blob(['sound'],{type:'audio/wav'}));
  vi.spyOn(HTMLMediaElement.prototype,'play').mockResolvedValue();
  vi.spyOn(HTMLMediaElement.prototype,'pause').mockImplementation(()=>{});
  Object.defineProperty(URL,'createObjectURL',{configurable:true,value:vi.fn(()=> 'blob:reply')});
  Object.defineProperty(URL,'revokeObjectURL',{configurable:true,value:vi.fn()});
});
afterEach(() => { cleanup(); vi.useRealTimers(); localStorage.clear(); });
async function flush() { await act(async()=>{ await Promise.resolve(); }); }
async function tick(ms=1000) { await act(async()=>{await vi.advanceTimersByTimeAsync(ms);}); }
function mount(autoplay=true) { const settled=vi.fn();const view=render(<VoiceRoundProgress id={4} requestId="round" autoplay={autoplay} onSettled={settled}/>);return {...view,settled}; }

it('shows saved text before speech finishes, then plays the matching reply once', async()=>{
  vi.mocked(voiceApi.receipt).mockResolvedValueOnce(receipt('text_ready')).mockResolvedValue(receipt('completed'));
  vi.mocked(voiceApi.history).mockResolvedValueOnce([]).mockResolvedValue([audio]);
  const {settled}=mount();await flush();
  expect(screen.getByText(message.content)).toBeInTheDocument();
  expect(screen.getByText('文字回复已保存，正在准备音频')).toBeInTheDocument();
  expect(voiceApi.blob).not.toHaveBeenCalled();
  await tick();expect(settled).toHaveBeenCalledTimes(1);expect(HTMLMediaElement.prototype.play).toHaveBeenCalledTimes(1);
  await tick(4000);fireEvent.click(screen.getByText('更新本轮状态'));await flush();
  expect(voiceApi.blob).toHaveBeenCalledTimes(1);expect(settled).toHaveBeenCalledTimes(1);
});

it('restores old results silently and allows explicit playback', async()=>{
  vi.mocked(voiceApi.receipt).mockResolvedValue(receipt('completed'));mount(false);await flush();
  expect(screen.getByText(message.content)).toBeInTheDocument();expect(voiceApi.blob).not.toHaveBeenCalled();
  fireEvent.click(screen.getByText('播放本轮回复'));await flush();expect(voiceApi.blob).toHaveBeenCalledTimes(1);
});

it('keeps text and a manual button when autoplay is blocked without re-synthesizing', async()=>{
  vi.mocked(voiceApi.receipt).mockResolvedValue(receipt('completed'));
  vi.mocked(HTMLMediaElement.prototype.play).mockRejectedValueOnce(new DOMException('blocked','NotAllowedError'));
  mount();await flush();expect(screen.getByText(/暂未播放，文字已保存/)).toBeInTheDocument();
  expect(screen.getByText(message.content)).toBeInTheDocument();
  fireEvent.click(screen.getByText('播放本轮回复'));await flush();expect(voiceApi.blob).toHaveBeenCalledTimes(2);
});

it('pauses hidden polling and does not autoplay when returning', async()=>{
  vi.mocked(voiceApi.receipt).mockResolvedValueOnce(receipt('text_ready')).mockResolvedValue(receipt('completed'));
  mount();await flush();
  Object.defineProperty(document,'hidden',{configurable:true,value:true});fireEvent(document,new Event('visibilitychange'));
  await tick(5000);expect(voiceApi.receipt).toHaveBeenCalledTimes(1);
  Object.defineProperty(document,'hidden',{configurable:true,value:false});fireEvent(document,new Event('visibilitychange'));await flush();
  expect(screen.getByText('录音和回复已保存')).toBeInTheDocument();expect(voiceApi.blob).not.toHaveBeenCalled();
});

it('discards late results after account change or unmount', async()=>{
  let resolve!:(r:VoiceReceipt)=>void;
  vi.mocked(voiceApi.receipt).mockImplementation(()=>new Promise(r=>{resolve=r;}));
  const {unmount,settled}=mount();localStorage.setItem(TOKEN_KEY,'two');
  await act(async()=>resolve(receipt('completed')));expect(settled).not.toHaveBeenCalled();expect(voiceApi.blob).not.toHaveBeenCalled();
  unmount();await tick();expect(voiceApi.receipt).toHaveBeenCalledTimes(1);
});

it('never plays another round audio and preserves text on synthesis failure', async()=>{
  vi.mocked(voiceApi.receipt).mockResolvedValue({...receipt('completed'),error:'audio_unavailable'});
  vi.mocked(voiceApi.history).mockResolvedValue([{...audio,message_id:999}]);mount();await flush();
  expect(screen.getByText(message.content)).toBeInTheDocument();expect(screen.queryByText('播放本轮回复')).toBeNull();
  expect(voiceApi.blob).not.toHaveBeenCalled();
});

it('bounds missing-receipt polling and offers only a read-only refresh', async()=>{
  vi.mocked(voiceApi.receipt).mockRejectedValue(new ApiError('missing',404,'not_found'));
  mount();await flush();await tick(91_000);
  expect(screen.getByText('仍在等待结果。可以稍后核对，不会再次发送。')).toBeInTheDocument();
  const count=vi.mocked(voiceApi.receipt).mock.calls.length;await tick(20_000);expect(voiceApi.receipt).toHaveBeenCalledTimes(count);
});

it('stops and releases audio when the user starts another recording or playback', async()=>{
  vi.mocked(voiceApi.receipt).mockResolvedValue(receipt('completed'));mount();await flush();
  fireEvent(window,new CustomEvent('aiwwb-voice-playback'));expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:reply');
  expect(screen.getByLabelText('本轮回复播放器')).not.toHaveAttribute('src');
});
