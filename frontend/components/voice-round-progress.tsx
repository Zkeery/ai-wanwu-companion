'use client';
import { useEffect, useRef, useState } from 'react';
import { api, ApiError } from '@/lib/api';
import { getToken } from '@/lib/auth';
import { voiceApi, receiptLabel, type VoiceReceipt, type AudioRecord } from '@/lib/voice';
import type { Message } from '@/lib/contracts';

type Props = { id: number; requestId: string; autoplay: boolean;
  onSettled: (receipt: VoiceReceipt, messages: Message[], audios: AudioRecord[]) => void };

export default function VoiceRoundProgress({ id, requestId, autoplay, onSettled }: Props) {
  const [receipt, setReceipt] = useState<VoiceReceipt | null>(null), [reply, setReply] = useState('');
  const [audio, setAudio] = useState<AudioRecord | null>(null), [notice, setNotice] = useState('');
  const [playbackStatus, setPlaybackStatus] = useState(''), [reload, setReload] = useState(0);
  const [loadingAudio, setLoadingAudio] = useState(false);
  const player = useRef<HTMLAudioElement | null>(null), blobUrl = useRef('');
  const playRequest = useRef<AbortController | null>(null), playLock = useRef(false);
  const alive = useRef(true), autoAllowed = useRef(autoplay), notified = useRef(false);
  const settled = useRef(onSettled);
  useEffect(() => { settled.current = onSettled; }, [onSettled]);

  async function play(value: AudioRecord) {
    if (playLock.current || document.hidden) return;
    playLock.current = true; setLoadingAudio(true); setPlaybackStatus('正在准备播放…');
    const token = getToken(), controller = new AbortController();
    playRequest.current = controller;
    const valid = () => alive.current && !controller.signal.aborted && getToken() === token && !document.hidden;
    try {
      const blob = await voiceApi.blob(id, value.id, controller.signal);
      if (!valid()) return;
      window.dispatchEvent(new CustomEvent('aiwwb-voice-playback', { detail: requestId }));
      if (blobUrl.current) URL.revokeObjectURL(blobUrl.current);
      blobUrl.current = URL.createObjectURL(blob);
      const element = player.current;
      if (!element) return;
      element.src = blobUrl.current;
      await element.play();
      if (valid()) setPlaybackStatus('正在播放本轮回复');
      else element.pause();
    } catch {
      if (valid()) setPlaybackStatus('暂未播放，文字已保存。请点“播放本轮回复”收听。');
    } finally {
      playLock.current = false;
      if (alive.current) setLoadingAudio(false);
    }
  }
  const playRef = useRef(play);
  useEffect(() => { playRef.current = play; });
  useEffect(() => {
    alive.current = true;
    const element = player.current;
    const stop = (event: Event) => {
      if (event.type === 'visibilitychange' && !document.hidden) return;
      if (event instanceof CustomEvent && event.detail === requestId) return;
      autoAllowed.current = false; playRequest.current?.abort(); element?.pause();
      element?.removeAttribute('src');
      if (blobUrl.current) { URL.revokeObjectURL(blobUrl.current); blobUrl.current = ''; }
    };
    document.addEventListener('visibilitychange', stop);
    window.addEventListener('aiwwb-voice-playback', stop);
    return () => {
      alive.current = false; playRequest.current?.abort(); element?.pause();
      if (blobUrl.current) { URL.revokeObjectURL(blobUrl.current); blobUrl.current = ''; }
      document.removeEventListener('visibilitychange', stop);
      window.removeEventListener('aiwwb-voice-playback', stop);
    };
  }, [requestId]);

  useEffect(() => {
    let active = true, inFlight = false, finished = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let controller: AbortController | null = null;
    const token = getToken(), deadline = Date.now() + 90_000;
    const valid = () => active && getToken() === token && !document.hidden;
    const schedule = () => { if (valid() && !finished) timer = setTimeout(() => void read(), 1000); };
    async function read() {
      if (!valid() || inFlight || finished) return;
      if (Date.now() >= deadline) { setNotice('仍在等待结果。可以稍后核对，不会再次发送。'); return; }
      inFlight = true; controller = new AbortController();
      try {
        const result = await voiceApi.receipt(id, requestId, controller.signal);
        if (!valid() || controller.signal.aborted) return;
        if (result.id !== requestId) throw new Error('receipt mismatch');
        setReceipt(result); setNotice('');
        const terminal = !['running', 'text_ready'].includes(result.state);
        if (result.reply_message_id != null || terminal) {
          const [messages, audios] = await Promise.all([api.messages(id, controller.signal), voiceApi.history(id, controller.signal)]);
          if (!valid() || controller.signal.aborted) return;
          const message = messages.find(m => m.id === result.reply_message_id && m.role === 'assistant');
          const clip = audios.find(a => a.message_id === result.reply_message_id && a.role === 'assistant' && a.state === 'ready');
          setReply(message?.content || ''); setAudio(message && clip ? clip : null);
          if (terminal) {
            finished = true;
            if (!notified.current) { notified.current = true; settled.current(result, messages, audios); }
            if (result.state === 'completed' && message && clip && autoAllowed.current) {
              autoAllowed.current = false;
              void playRef.current(clip);
            }
          }
        }
      } catch (e) {
        if (valid() && !controller.signal.aborted) {
          if (e instanceof ApiError && [401, 403].includes(e.status)) {
            finished = true; setReply(''); setAudio(null); player.current?.pause();
          }
          // A new POST can still be uploading when its first receipt lookup is 404.
          if (!(e instanceof ApiError && e.status === 404)) setNotice('暂时无法更新回复，正在核对已保存的结果，不会重新发送。');
        }
      } finally { inFlight = false; schedule(); }
    }
    function wake() { clearTimeout(timer); if (document.hidden) controller?.abort(); else void read(); }
    void read(); document.addEventListener('visibilitychange', wake);
    return () => { active = false; clearTimeout(timer); controller?.abort(); document.removeEventListener('visibilitychange', wake); };
  }, [id, requestId, reload]);

  return <section className="team-panel" aria-label="本轮语音回复"><h2>本轮回复</h2>
    <p role="status">{receipt ? receiptLabel(receipt) : '正在发送并等待伙伴回复…'}</p>
    {reply && <p style={{ whiteSpace: 'pre-wrap' }}>{reply}</p>}
    {receipt && <small>{receipt.origin === 'offline_fixture' ? '离线样例回复' : '模型回复 · 本机音色'}</small>}
    {notice && <p role="status">{notice}</p>}
    <audio ref={player} controls={!!audio} style={{ display: audio ? 'block' : 'none', maxWidth: '100%' }} preload="none" aria-label="本轮回复播放器"
      onPause={() => setPlaybackStatus(current => current === '正在播放本轮回复' ? '本轮回复已暂停' : current)}
      onEnded={() => setPlaybackStatus('本轮回复播放完毕')} />
    {playbackStatus && <p role="status">{playbackStatus}</p>}
    <div className="hub-actions">{audio && <><button className="button" disabled={loadingAudio} onClick={() => { autoAllowed.current = false; void play(audio); }}>播放本轮回复</button>
      <button className="button" onClick={() => { autoAllowed.current = false; playRequest.current?.abort(); player.current?.pause(); setPlaybackStatus('本轮回复已停止'); }}>停止本轮回复</button></>}
      <button className="button" onClick={() => setReload(n => n + 1)}>更新本轮状态</button></div>
  </section>;
}
