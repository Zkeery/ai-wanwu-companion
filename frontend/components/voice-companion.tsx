'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { api, ApiError, errorText } from '@/lib/api';
import { actionNames, type Character, type Message, type Scene } from '@/lib/contracts';
import { moods, transcriptionMessages, voiceApi, receiptLabel, liveSessionLabels, type VoiceReceipt, type AudioRecord, type parseVoiceSettings } from '@/lib/voice';
import { getToken } from '@/lib/auth';
import { Brand, Loading, Modal, Notice } from './common';
import { useTeamSession } from './team-shared';
import AuthModal from './auth-modal';
import { voiceDraftKey } from '@/lib/voice-draft';
import { isVSCodeEmbeddedBrowser, startWavCapture } from '@/lib/pcm-recorder';
import VoiceRoundProgress from './voice-round-progress';

const VOICE_GUARD = '__aiwwbVoiceDraftGuard';

function microphoneError(error: unknown): Error {
  const name = error && typeof error === 'object' && 'name' in error ? error.name : '';
  if (name === 'NotAllowedError' || name === 'SecurityError') return new Error('麦克风权限未开启，请在浏览器地址栏的网站设置中允许麦克风，再重新录制。已填写的文字会保留。');
  if (name === 'NotFoundError') return new Error('没有找到麦克风，请连接麦克风后重新录制。已填写的文字会保留。');
  if (name === 'NotReadableError' || name === 'AbortError') return new Error('麦克风暂时无法使用，请检查设备连接或关闭其他占用麦克风的应用后重试。已填写的文字会保留。');
  return error instanceof Error ? error : new Error('录音未能启动，请检查麦克风后重试。');
}

function VoiceChat({ id }: { id: number }) {
  const [character, setCharacter] = useState<Character | null>(null), [messages, setMessages] = useState<Message[]>([]), [audios, setAudios] = useState<AudioRecord[]>([]);
  const [receipts, setReceipts] = useState<VoiceReceipt[]>([]), [pending, setPending] = useState<string | null>(null);
  const [activeRound, setActiveRound] = useState<string | null>(null);
  const completedRound = useRef<string | null>(null);
  const sendingRequest = useRef<{ id: string; controller: AbortController } | null>(null);
  const shownRound = activeRound || receipts.find(r => r.state === 'running' || r.state === 'text_ready')?.id;
  const [scene, setScene] = useState<Scene | null>(null), [sceneError, setSceneError] = useState('');
  const sendingUnresolved = pending !== null || receipts.some(r => r.state === 'running' || r.state === 'text_ready');
  const [settings, setSettings] = useState<ReturnType<typeof parseVoiceSettings> | null>(null);
  const [voice, setVoice] = useState(''), [mood, setMood] = useState(''), [automatic, setAutomatic] = useState(true);
  const [clip, setClip] = useState<Blob | null>(null), [text, setText] = useState(''), [recording, setRecording] = useState(false), [finalizing, setFinalizing] = useState(false), [seconds, setSeconds] = useState(0);
  const [clipPlaybackStatus, setClipPlaybackStatus] = useState(''), [clipPlayedSeconds, setClipPlayedSeconds] = useState(0);
  const [captureNotice, setCaptureNotice] = useState('');
  const [historyPlayerReady, setHistoryPlayerReady] = useState(false);
  const [draftKey, setDraftKey] = useState<string | null>(null), [draftWarning, setDraftWarning] = useState(false);
  const [leaving, setLeaving] = useState<{ kind: 'link'; href: string } | { kind: 'back' } | null>(null);
  const [transcriptionError, setTranscriptionError] = useState(''), [transcribing, setTranscribing] = useState(false);
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState(''), [deleting, setDeleting] = useState<string | null>(null);
  const recorder = useRef<MediaRecorder | null>(null), wavRecorder = useRef<Awaited<ReturnType<typeof startWavCapture>> | null>(null), input = useRef<MediaStream | null>(null), timer = useRef<ReturnType<typeof setInterval> | null>(null), discard = useRef(false), finishing = useRef(false), captureVersion = useRef(0), lock = useRef(false), requestId = useRef<string | null>(null);
  const playback = useRef<HTMLAudioElement | null>(null), url = useRef(''), mounted = useRef(true);
  const clipPlayback = useRef<HTMLAudioElement | null>(null), clipUrl = useRef(''), recordingStartedAt = useRef(0);
  const captureAttempt = useRef(0), startingCapture = useRef(false);
  const releaseTrackListeners = useRef<(() => void) | null>(null);
  const playerRef = useRef<HTMLAudioElement | null>(null);
  const bypassLeave = useRef(false);
  useEffect(() => {
    const pause = () => { playback.current?.pause(); clipPlayback.current?.pause(); };
    window.addEventListener('aiwwb-voice-playback', pause);
    return () => window.removeEventListener('aiwwb-voice-playback', pause);
  }, []);
  useEffect(() => () => sendingRequest.current?.controller.abort(), []);
  useEffect(() => {
    const token = getToken();
    if (!token) return;
    let active = true;
    voiceDraftKey(token, id).then(key => {
      if (!active || getToken() !== token) return;
      try {
        const saved = sessionStorage.getItem(key);
        if (saved) setText(current => current || saved);
        setDraftKey(key);
      } catch { setDraftWarning(true); }
    }).catch(() => { if (active) setDraftWarning(true); });
    return () => { active = false; };
  }, [id]);
  useEffect(() => {
    if (!draftKey) return;
    try {
      if (text) sessionStorage.setItem(draftKey, text);
      else sessionStorage.removeItem(draftKey);
    } catch { queueMicrotask(() => setDraftWarning(true)); }
  }, [draftKey, text]);
  useEffect(() => {
    const player = clipPlayback.current;
    return () => {
      player?.pause();
      if (clipUrl.current) { URL.revokeObjectURL(clipUrl.current); clipUrl.current = ''; }
      player?.removeAttribute('src');
    };
  }, [clip]);
  const updateClip = useCallback((value: Blob | null) => { setClip(value); setClipPlaybackStatus(''); setClipPlayedSeconds(0); }, []);
  useEffect(() => {
    if (!recording && !clip) {
      if (bypassLeave.current) return;
      if (history.state?.[VOICE_GUARD]) history.back();
      return;
    }
    if (!history.state?.[VOICE_GUARD]) history.pushState({ ...history.state, [VOICE_GUARD]: true }, '', location.href);
    const beforeUnload = (event: BeforeUnloadEvent) => {
      if (bypassLeave.current) return;
      event.preventDefault(); event.returnValue = '';
    };
    const click = (event: MouseEvent) => {
      if (bypassLeave.current || event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      const anchor = event.target instanceof Element ? event.target.closest('a[href]') as HTMLAnchorElement | null : null;
      if (!anchor || anchor.target === '_blank' || anchor.hasAttribute('download') || anchor.href === location.href) return;
      event.preventDefault(); event.stopPropagation(); setLeaving({ kind: 'link', href: anchor.href });
    };
    const back = () => {
      if (bypassLeave.current) return;
      history.pushState({ ...history.state, [VOICE_GUARD]: true }, '', location.href);
      setLeaving({ kind: 'back' });
    };
    window.addEventListener('beforeunload', beforeUnload);
    document.addEventListener('click', click, true);
    window.addEventListener('popstate', back);
    return () => {
      window.removeEventListener('beforeunload', beforeUnload);
      document.removeEventListener('click', click, true);
      window.removeEventListener('popstate', back);
    };
  }, [recording, clip]);
  function discardAndLeave() {
    if (!leaving) return;
    const destination = leaving;
    bypassLeave.current = true;
    stop(true);
    playback.current?.pause();
    if (url.current) { URL.revokeObjectURL(url.current); url.current = ''; }
    clipPlayback.current?.pause();
    if (clipUrl.current) { URL.revokeObjectURL(clipUrl.current); clipUrl.current = ''; }
    if (destination.kind === 'back') history.go(-2);
    else location.assign(destination.href);
  }
  useEffect(() => {
    mounted.current = true;
    const token = getToken();
    api.scene(id).then(value => {
      if (mounted.current && getToken() === token) { setScene(value); setSceneError(''); }
    }).catch(() => {
      if (mounted.current && getToken() === token) { setScene(null); setSceneError('暂时无法核对场景提议，请刷新记录后再试。'); }
    });
    Promise.all([api.character(id), api.messages(id), voiceApi.settings(id), voiceApi.history(id), voiceApi.receipts(id)]).then(([c, m, s, a, r]) => { if (mounted.current) { setCharacter(c); setMessages(m); setSettings(s); setVoice(s.voice); setMood(s.mood || ''); setAutomatic(s.automatic); setAudios(a); setReceipts(r); } }).catch(e => { if (mounted.current) setError(errorText(e)); });
    return () => { mounted.current = false; discard.current = true; releaseTrackListeners.current?.(); if (timer.current) clearInterval(timer.current); if (recorder.current?.state === 'recording') recorder.current.stop(); wavRecorder.current?.cancel(); input.current?.getTracks().forEach(t => t.stop()); playerRef.current?.pause(); if (url.current) URL.revokeObjectURL(url.current); if (clipUrl.current) { URL.revokeObjectURL(clipUrl.current); clipUrl.current = ''; } };
  }, [id]);
  async function work(fn: () => Promise<void>) { if (lock.current) return; lock.current = true; setBusy(true); setError(''); setNotice(''); try { await fn(); } catch (e) { if (mounted.current) setError(errorText(e)); } finally { lock.current = false; if (mounted.current) setBusy(false); } }
  async function refreshScene(signal?: AbortSignal) {
    const token = getToken();
    try {
      const value = await api.scene(id, signal);
      if (mounted.current && getToken() === token && !signal?.aborted) { setScene(value); setSceneError(''); }
    } catch {
      if (mounted.current && getToken() === token && !signal?.aborted) { setScene(null); setSceneError('暂时无法核对场景提议，请刷新记录后再试。'); }
    }
  }
  async function refresh(signal?: AbortSignal) {
    const token = getToken();
    await refreshScene(signal);
    if (signal?.aborted) return;
    const [m, a, r] = await Promise.all([api.messages(id, signal), voiceApi.history(id, signal), voiceApi.receipts(id, signal)]);
    if (mounted.current && getToken() === token && !signal?.aborted) { setMessages(m); setAudios(a); setReceipts(r); }
  }
  async function reconcile() {
    if (!pending) { await refresh(); return; }
    const token = getToken();
    try {
      const result = await voiceApi.receipt(id, pending);
      if (!mounted.current || getToken() !== token) return;
      await refresh();
      if (!mounted.current || getToken() !== token) return;
      setNotice(receiptLabel(result));
      if (result.state !== 'running' && result.state !== 'text_ready') {
        setPending(null); requestId.current = null; updateClip(null); setText('');
      }
    } catch {
      if (mounted.current && getToken() === token) setNotice('暂时未能核对发送结果，原录音和文字已保留。请稍后再次核对，不会自动重发。');
    }
  }
  async function decideScene(decision: 'confirm' | 'reject') {
    const proposal = scene?.proposal;
    if (!proposal) return;
    await work(async () => {
      const token = getToken();
      try {
        const result = await api.decide(id, proposal.id, decision);
        if (mounted.current && getToken() === token) { setScene(result); setNotice(result.feedback || '场景提议已处理。'); }
      } catch (e) {
        await refreshScene();
        throw e;
      }
    });
  }
  async function sendRecording() {
    if (!clip || sendingUnresolved) return;
    await work(async () => {
      const token = getToken();
      requestId.current ||= crypto.randomUUID();
      const sendingId = requestId.current;
      const controller = new AbortController();
      sendingRequest.current = { id: sendingId, controller };
      setPending(requestId.current);
      setActiveRound(requestId.current);
      window.dispatchEvent(new CustomEvent('aiwwb-voice-playback'));
      try {
        const result = await voiceApi.send(id, clip, text, sendingId, controller.signal);
        if (!mounted.current || getToken() !== token || controller.signal.aborted) return;
        await refresh(controller.signal);
        if (!mounted.current || getToken() !== token || controller.signal.aborted) return;
        setNotice(receiptLabel(result));
        if (result.state !== 'running' && result.state !== 'text_ready') {
          setPending(null); updateClip(null); setText(''); requestId.current = null;
          try {
            const updated = await voiceApi.settings(id);
            if (mounted.current && getToken() === token) {
              setSettings(updated);
              setMood(current => current === mood ? updated.mood || '' : current);
            }
          } catch { /* The completed send remains completed when settings cannot be refreshed. */ }
        }
      } catch (e) {
        if (!mounted.current || getToken() !== token || controller.signal.aborted) return;
        if (completedRound.current === sendingId) return;
        if (e instanceof ApiError && (e.status === 400 || e.status === 422 || ['voice_session_unavailable', 'voice_session_busy'].includes(e.code))) {
          setPending(null); setActiveRound(null); requestId.current = null; setError(errorText(e));
          if (e.code.startsWith('voice_session_')) {
            try {
              const updated = await voiceApi.settings(id);
              if (mounted.current && getToken() === token) setSettings(updated);
            } catch { /* Keep the editable recording and explicit rejection. */ }
          }
        } else setNotice('发送结果待核对，原录音和文字已保留。请核对发送结果，不会自动重发。');
      } finally {
        if (sendingRequest.current?.id === sendingId) sendingRequest.current = null;
      }
    });
  }
  const acceptRecording = useCallback((blob: Blob) => {
    if (blob.size <= (blob.type === 'audio/wav' ? 44 : 0)) {
      setError('这次录音没有生成音频，请重新录制；已填写的文字会保留。');
      setSeconds(0);
    } else updateClip(blob);
  }, [updateClip]);
  const stop = useCallback((cancel = false) => {
    releaseTrackListeners.current?.();
    if (cancel) { setTranscriptionError(''); setCaptureNotice(''); }
    discard.current = cancel;
    if (timer.current) { clearInterval(timer.current); timer.current = null; }
    if (!cancel && (recorder.current?.state === 'recording' || wavRecorder.current)) setSeconds(Math.min(60, Math.max(1, Math.round((performance.now() - recordingStartedAt.current) / 1000))));
    if (wavRecorder.current) {
      const current = wavRecorder.current; wavRecorder.current = null;
      try { if (cancel) current.cancel(); else acceptRecording(current.stop()); }
      catch { setError('录音整理失败，请重新录制；已填写的文字会保留。'); }
      input.current = null;
    } else if (recorder.current?.state === 'recording') {
      finishing.current = true; setFinalizing(true);
      recorder.current.stop();
    }
    setRecording(false);
    if (cancel) { updateClip(null); requestId.current = null; setSeconds(0); }
  }, [acceptRecording, updateClip]);
  useEffect(() => {
    const attempt = captureAttempt;
    const suspend = () => {
      playback.current?.pause(); clipPlayback.current?.pause();
      attempt.current++;
      const wasStarting = startingCapture.current;
      const wasRecording = recorder.current?.state === 'recording' || !!wavRecorder.current;
      if (wasStarting) {
        input.current?.getTracks().forEach(track => track.stop());
        input.current = null;
      } else if (wasRecording) stop();
      if (wasStarting || wasRecording) setCaptureNotice('页面已切到后台，录音已停止；返回后可试听、核对文字或重新录制，不会自动发送。');
    };
    const hidden = () => { if (document.visibilityState === 'hidden') suspend(); };
    document.addEventListener('visibilitychange', hidden);
    window.addEventListener('pagehide', suspend);
    return () => {
      attempt.current++;
      document.removeEventListener('visibilitychange', hidden);
      window.removeEventListener('pagehide', suspend);
    };
  }, [stop]);
  async function start() {
    await work(async () => {
      window.dispatchEvent(new CustomEvent('aiwwb-voice-playback'));
      if (finishing.current) return;
      setCaptureNotice('');
      const embedded = isVSCodeEmbeddedBrowser(navigator.userAgent);
      if (!navigator.mediaDevices?.getUserMedia || (!embedded && typeof MediaRecorder === 'undefined')) throw new Error('这个浏览器暂不支持录音，请回到文字聊天。');
      const attempt = ++captureAttempt.current, token = getToken();
      const current = () => mounted.current && attempt === captureAttempt.current && document.visibilityState !== 'hidden' && getToken() === token;
      startingCapture.current = true;
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        if (!current()) { stream.getTracks().forEach(t => t.stop()); return; }
        input.current = stream;
        try {
          if (embedded) {
            const capture = await startWavCapture(stream);
            if (!current()) { capture.cancel(); if (input.current === stream) input.current = null; return; }
            if (stream.getTracks().some(track => track.readyState === 'ended')) { capture.cancel(); throw new Error('麦克风已断开，请连接设备后重新录制。已填写的文字会保留。'); }
            wavRecorder.current = capture;
          }
          else {
            const version = ++captureVersion.current;
            const mime = ['audio/webm;codecs=opus', 'audio/mp4', 'audio/ogg;codecs=opus'].find(x => MediaRecorder.isTypeSupported(x));
            const r = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined), chunks: BlobPart[] = [];
            r.ondataavailable = e => { if (e.data.size) chunks.push(e.data); };
            r.onerror = () => { stream.getTracks().forEach(t => t.stop()); if (version !== captureVersion.current) return; releaseTrackListeners.current?.(); if (input.current === stream) input.current = null; captureVersion.current++; discard.current = true; if (recorder.current === r) recorder.current = null; if (timer.current) { clearInterval(timer.current); timer.current = null; } finishing.current = false; if (mounted.current) { setFinalizing(false); setRecording(false); setError('录音中断，请重新录制或使用文字。'); } };
            r.onstop = () => {
              stream.getTracks().forEach(t => t.stop());
              if (input.current === stream) input.current = null;
              if (version !== captureVersion.current) return;
              releaseTrackListeners.current?.();
              if (recorder.current === r) recorder.current = null;
              if (timer.current) { clearInterval(timer.current); timer.current = null; }
              finishing.current = false;
              if (mounted.current) { setFinalizing(false); setRecording(false); if (!discard.current) acceptRecording(new Blob(chunks, { type: r.mimeType })); }
            };
            r.start(); recorder.current = r;
          }
        } catch (e) { stream.getTracks().forEach(t => t.stop()); if (input.current === stream) input.current = null; throw e; }
        setTranscriptionError(''); input.current = stream; discard.current = false; updateClip(null); requestId.current = null; setSeconds(0);
        setRecording(true); recordingStartedAt.current = performance.now();
        const tracks = stream.getTracks();
        const ended = () => {
          if (!current() || input.current !== stream) return;
          stop();
          setCaptureNotice('麦克风连接已中断，录音已停止。请试听已录内容，或连接设备后重新录制；不会自动发送。');
        };
        tracks.forEach(track => track.addEventListener?.('ended', ended));
        releaseTrackListeners.current = () => {
          tracks.forEach(track => track.removeEventListener?.('ended', ended));
          releaseTrackListeners.current = null;
        };
        timer.current = setInterval(() => { const elapsed = Math.floor((performance.now() - recordingStartedAt.current) / 1000); setSeconds(Math.min(60, elapsed)); if (elapsed >= 60) { stop(); setCaptureNotice('已录满60秒，录音已停止。请试听并核对文字后发送。'); } }, 200);
        if (tracks.some(track => track.readyState === 'ended')) ended();
      } catch (e) { if (current()) throw microphoneError(e); }
      finally { startingCapture.current = false; }
    });
  }
  async function recognize() {
    if (sendingUnresolved || !clip || settings?.transcription_status !== 'configured') return;
    await work(async () => {
      setTranscriptionError(''); setTranscribing(true);
      const token = getToken();
      try {
        const result = await voiceApi.transcribe(id, clip);
        if (!mounted.current || getToken() !== token) return;
        setText(result); requestId.current = null;
        setNotice('识别完成，请核对文字后再发送。');
      } catch (e) {
        if (mounted.current && getToken() === token) setTranscriptionError(errorText(e));
      } finally { if (mounted.current) setTranscribing(false); }
    });
  }
  async function play(load: () => Promise<Blob>) {
    window.dispatchEvent(new CustomEvent('aiwwb-voice-playback'));
    const token = getToken(), attempt = captureAttempt.current;
    const current = () => mounted.current && getToken() === token && attempt === captureAttempt.current && document.visibilityState !== 'hidden';
    await work(async () => {
      try {
        const blob = await load();
        if (!current()) return;
        playback.current?.pause(); setHistoryPlayerReady(false);
        if (url.current) URL.revokeObjectURL(url.current);
        url.current = URL.createObjectURL(blob);
        if (playback.current) {
          playback.current.src = url.current;
          await playback.current.play();
          if (current()) setHistoryPlayerReady(true);
        }
      } catch {
        if (current()) { setHistoryPlayerReady(false); setError('音频读取或播放失败，请点“播放 / 重播”再试。'); }
      }
    });
  }
  function previewFailure(player: HTMLAudioElement, failure?: unknown): string {
    if (clip && clip.size <= (clip.type === 'audio/wav' ? 44 : 0)) return '这段录音没有生成音频，请重新录制；已填写的文字会保留。';
    if (failure instanceof DOMException && failure.name === 'NotAllowedError') return '浏览器阻止了播放，请再点一次“试听录音”。';
    if (player.error?.code === 4 || (failure instanceof DOMException && failure.name === 'NotSupportedError')) return '当前浏览器无法播放这段录音，请重新录制；已填写的文字会保留。';
    return '录音试听失败，请重新录制或改用文字。';
  }
  async function previewRecording() {
    if (!clip) return;
    window.dispatchEvent(new CustomEvent('aiwwb-voice-playback'));
    await work(async () => {
      const player = clipPlayback.current;
      if (!player) { setClipPlaybackStatus('试听暂不可用，请重新录制或改用文字。'); return; }
      player.pause();
      if (clipUrl.current) URL.revokeObjectURL(clipUrl.current);
      setClipPlayedSeconds(0);
      setClipPlaybackStatus('正在准备录音试听…');
      try {
        clipUrl.current = URL.createObjectURL(clip);
        player.src = clipUrl.current;
        await player.play();
        if (mounted.current) setClipPlaybackStatus('正在播放录音');
      } catch (failure) {
        if (mounted.current) setClipPlaybackStatus(previewFailure(player, failure));
      }
    });
  }
  async function retryAudio(audioId: string) {
    await work(async () => {
      const token = getToken();
      try {
        await voiceApi.retryAudio(id, audioId);
        if (!mounted.current || getToken() !== token) return;
        await refresh();
        if (mounted.current && getToken() === token) setNotice('回复音频已生成，请点“播放 / 重播”收听。');
      } catch (e) {
        await refresh().catch(() => {});
        if (mounted.current && getToken() === token) setNotice(e instanceof ApiError ? errorText(e) : '暂时无法确认音频重试结果，已刷新记录；请先核对状态，不会自动再次生成。');
      }
    });
  }
  return <>
    <div className="eyebrow">A VOICE BESIDE YOU</div><h1>{character ? `和${character.name}说说话` : '说话与心情'}</h1><p>录音和文字都属于同一段聊天。录音文字可以识别后纠正，也可以自己填写。</p>
    {error && <Notice retry={() => void work(refresh)}>{error}</Notice>}{notice && <p role="status">{notice}</p>}
    {!character || !settings ? <Loading /> : <>
      <p role="status">{settings.reply_origin === 'offline_fixture' ? '新发送的消息使用离线样例回复。已有记录中的模型回复仍可播放。' : settings.reply_origin === 'configured_model' ? '新发送的消息由伙伴回复，使用你选择的音色朗读。' : settings.live_session ? '当前不能发送新的语音回复，已有文字和音频仍可查看与播放。' : '语音正式回复尚未开启，可以先试听或回到文字聊天。'}</p>
      {settings.live_session && <section className="team-panel" aria-label="真实聊天额度"><h2>{liveSessionLabels[settings.live_session.state]}</h2>
        <p>已使用 {settings.live_session.used_rounds} / {settings.live_session.max_rounds} 轮{settings.live_session.state === 'active' ? `，还可聊 ${settings.live_session.remaining_rounds} 轮` : '；后续发送已停止'}。</p>
        <p>本次费用上限 ¥{(settings.live_session.budget_micro / 1_000_000).toFixed(2)}，按实际用量计费。有效至 {new Date(settings.live_session.expires_at * 1000).toLocaleString('zh-CN')}。</p>
        <p>每次由你主动录音、核对文字后发送；保留前文，伙伴会接着聊。</p>
        {settings.live_session.state === 'active' && <button className="button" disabled={busy} onClick={() => void work(async () => {
          const token = getToken();
          const updated = await voiceApi.endSession(id);
          if (mounted.current && getToken() === token) { setSettings(updated); setNotice('真实聊天已结束，未用轮数已停用。已发送的回复和历史仍可查看。'); }
        })}>结束真实聊天</button>}
      </section>}
      {draftWarning && <p role="status">浏览器暂时无法保存文字草稿，请在离开前复制需要保留的文字。</p>}
      <section className="team-panel"><h2>今天感觉怎么样？</h2><label className="field">我现在的心情<select value={mood} onChange={e => setMood(e.target.value)}><option value="">暂不选择 / 清除原判断</option>{Object.entries(moods).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></label>{settings.mood_source === 'suggested' && <p>这是根据文字提出的候选，你可以纠正。</p>}<label><input type="checkbox" checked={automatic} onChange={e => setAutomatic(e.target.checked)} />允许从当前文字提出心情候选</label><p>主动选择和纠正优先。心情只用于你的私聊。</p>
        <label className="field">伙伴的音色<select value={voice} onChange={e => setVoice(e.target.value)}>{!settings.voices.length && <option value="">暂时没有可用音色</option>}{settings.voices.map(v => <option key={v.id} value={v.id}>{v.label}</option>)}</select></label><div className="hub-actions"><button className="button" disabled={busy || !voice} onClick={() => void play(() => voiceApi.preview(id, voice))}>试听，不发送消息</button><button className="button primary" disabled={busy} onClick={() => void work(async () => { const s = await voiceApi.save(id, voice, mood || null, automatic); setSettings(s); setNotice('心情和音色已保存。已有音频保持原样。'); })}>保存设置</button></div>
      </section>
      <section className="team-panel"><h2>用声音留下这一刻</h2><p>最长 60 秒；到时自动停止，点击识别时临时上传；点击发送后才保存。已发送原音和回复音频分别保留 7 天，也可主动删除。</p><p role="status">{recording ? `正在录音 · ${seconds} / 60 秒` : finalizing ? '正在整理录音…' : clip ? `录音已停止 · 约 ${seconds} 秒，等待发送` : '麦克风尚未开启'}</p><div className="hub-actions">{!recording ? <button className="button primary" disabled={busy || sendingUnresolved || finalizing} onClick={() => void start()}>{clip ? '重新录制' : '开始录音'}</button> : <button className="button primary" onClick={() => stop()}>停止录音</button>}{(recording || clip || finalizing) && <button className="button" disabled={busy || sendingUnresolved} onClick={() => stop(true)}>取消录音</button>}{clip && <button className="button" disabled={busy || finalizing} onClick={() => void previewRecording()}>试听录音</button>}{clip && clipPlaybackStatus === '正在播放录音' && <button className="button" onClick={() => clipPlayback.current?.pause()}>暂停试听</button>}{clip && clipPlaybackStatus === '录音试听已暂停' && <button className="button" disabled={busy} onClick={() => void work(async () => { const player = clipPlayback.current; if (!player) return; try { await player.play(); if (mounted.current) setClipPlaybackStatus('正在播放录音'); } catch (failure) { if (mounted.current) setClipPlaybackStatus(previewFailure(player, failure)); } })}>继续试听</button>}</div>
        {captureNotice && <p role="status">{captureNotice}</p>}
        {clip && <><audio ref={clipPlayback} preload="none" aria-label="未发送录音试听播放器" onTimeUpdate={e => setClipPlayedSeconds(e.currentTarget.currentTime)} onEnded={() => { setClipPlayedSeconds(seconds); setClipPlaybackStatus('录音播放完毕'); }} onPause={e => { if (!e.currentTarget.ended) setClipPlaybackStatus(current => current === '正在播放录音' ? '录音试听已暂停' : current); }} onError={e => { if (clipUrl.current) setClipPlaybackStatus(previewFailure(e.currentTarget)); }} /><p role="status">{clipPlaybackStatus || '点击“试听录音”后收听这段录音。'} · 已播放 {Math.min(seconds, Math.floor(clipPlayedSeconds))} 秒 / 录音约 {seconds} 秒</p><progress aria-label="录音试听进度" max={Math.max(seconds, 1)} value={Math.min(clipPlayedSeconds, Math.max(seconds, 1))} style={{ display: 'block', width: 'min(100%, 28rem)' }} /></>}
        <p role="status">{transcriptionMessages[settings.transcription_status]}</p>
        <button className="button" disabled={busy || recording || finalizing} onClick={() => void work(async () => { const value = await voiceApi.settings(id); if (mounted.current) { setSettings(value); setNotice('识别配置状态已更新，录音和已填写文字保持不变。'); } })}>检查识别配置</button>
        <button className="button" disabled={busy || sendingUnresolved || recording || finalizing || !clip || settings.transcription_status !== 'configured'} onClick={() => void recognize()}>{transcribing ? '正在识别录音…' : '识别录音文字'}</button>
        {transcriptionError && <div role="alert"><p>{transcriptionError}</p><p>原录音和已填写文字已保留，可以重试识别或直接填写文字。</p><button className="button" disabled={busy || sendingUnresolved || recording || !clip || settings.transcription_status !== 'configured'} onClick={() => void recognize()}>重试识别</button></div>}
        <label className="field">录音文字（识别后可纠正，也可直接填写）<textarea rows={3} maxLength={2000} value={text} disabled={busy || sendingUnresolved} onChange={e => { setText(e.target.value); requestId.current = null; }} /></label><button className="button primary" disabled={busy || sendingUnresolved || recording || finalizing || !clip || !text.trim() || settings.reply_origin === 'disabled'} onClick={() => void sendRecording()}>{busy ? '正在处理…' : '发送录音与文字'}</button><Link className="button" href={`/companions/${id}?tab=chat`}>回到文字聊天</Link>
      </section>
      {shownRound && <VoiceRoundProgress key={shownRound} id={id} requestId={shownRound} autoplay={activeRound === shownRound}
        onSettled={(result, savedMessages, savedAudios) => {
          completedRound.current = result.id;
          setMessages(savedMessages); setAudios(savedAudios);
          setReceipts(current => [result, ...current.filter(r => r.id !== result.id)]);
          if (pending === result.id) {
            setPending(null); requestId.current = null; updateClip(null); setText('');
            setNotice(receiptLabel(result));
            // The persisted receipt is authoritative even if the POST response is still waiting.
            if (sendingRequest.current?.id === result.id) sendingRequest.current.controller.abort();
            const token = getToken();
            void refreshScene();
            void voiceApi.settings(id).then(updated => {
              if (mounted.current && getToken() === token && completedRound.current === result.id && requestId.current === null) {
                setSettings(updated);
                setMood(current => current === mood ? updated.mood || '' : current);
              }
            }).catch(() => { /* A settings read cannot invalidate a saved round. */ });
          }
        }} />}
      <section className="team-panel"><h2>发送状态</h2>
        {pending && <p role="status">这次发送尚待核对，核对前不会再次发送。</p>}
        <button className="button" disabled={busy} onClick={() => void work(reconcile)}>核对发送结果</button>
        {receipts.length ? receipts.map(r => <p key={r.id}>{new Date(r.created_at * 1000).toLocaleString('zh-CN')} · {receiptLabel(r)}</p>) : <p>暂无已保存的发送记录。</p>}
      </section>
      {(scene?.proposal || sceneError) && <section className="team-panel"><h2>场景提议</h2>{sceneError ? <p role="status">{sceneError}</p> : scene?.proposal && <><p>你说到{actionNames[scene.proposal.action]}。确认后才会改变{scene.scene_name}，也可以先不了。</p><div className="hub-actions"><button className="button primary" disabled={busy || sendingUnresolved} onClick={() => void decideScene('confirm')}>确认执行</button><button className="button" disabled={busy || sendingUnresolved} onClick={() => void decideScene('reject')}>先不了</button></div></>}</section>}
      <section className="team-panel"><h2>聊天与音频记录</h2><audio ref={node => { playback.current = node; playerRef.current = node; }} controls={historyPlayerReady} style={{ display: historyPlayerReady ? 'block' : 'none' }} preload="none" aria-label="录音与回复播放器" />{historyPlayerReady && <button className="button" onClick={() => playback.current?.pause()}>停止音色或历史音频</button>}<button className="button" disabled={busy} onClick={() => void work(refresh)}>刷新记录</button>{messages.length ? messages.map(m => <div className="hub-item" key={m.id}><strong>{m.role === 'user' ? '我' : character.name}</strong><p>{m.content}</p>{audios.filter(a => a.message_id === m.id).map(a => <div key={a.id}>{a.role === 'assistant' && <small>{a.origin === 'offline_fixture' ? '离线样例回复' : a.origin === 'configured_model' ? '模型回复 · 已保存音频' : '历史音频'}</small>}<p>{a.state === 'ready' ? `音频保留至 ${new Date(a.expires_at * 1000).toLocaleString('zh-CN')}` : ({ expired: '音频已到期，文字保留', deleted: '音频已删除，文字保留', unavailable: '回复音频不可用，文字保留', synthesizing: '正在准备回复音频，请稍后刷新记录' } as Record<string, string>)[a.state] || '音频暂不可用'}</p>{a.state === 'ready' && <div className="hub-actions"><button className="button" disabled={busy} onClick={() => void play(() => voiceApi.blob(id, a.id))}>播放 / 重播</button><button className="button" disabled={busy} onClick={() => setDeleting(a.id)}>删除这段音频</button></div>}{a.role === 'assistant' && a.state === 'unavailable' && <button className="button" disabled={busy} onClick={() => void retryAudio(a.id)}>恢复回复音频</button>}</div>)}</div>) : <p>还没有聊天记录。</p>}</section>
    </>}{leaving && <Modal title="离开说话页面？" close={() => setLeaving(null)}><p>这段录音还没有发送。离开后录音会丢弃，已填写的文字会留在当前浏览器标签中。</p><button className="button" onClick={() => setLeaving(null)}>继续留在这里</button><button className="button primary" onClick={discardAndLeave}>丢弃录音并离开</button></Modal>}{deleting && <Modal title="删除这段音频？" close={() => { if (!busy) setDeleting(null); }}><p>音频删除后不能恢复，对应文字会保留。</p><button className="button primary" disabled={busy} onClick={() => void work(async () => { playback.current?.pause(); setHistoryPlayerReady(false); if (url.current) { URL.revokeObjectURL(url.current); url.current = ''; } window.dispatchEvent(new CustomEvent('aiwwb-voice-playback')); await voiceApi.remove(id, deleting); setActiveRound(null); setDeleting(null); await refresh(); })}>确认删除音频</button></Modal>}
  </>;
}

export default function VoiceCompanion({ id }: { id: number }) {
  const session = useTeamSession(), [login, setLogin] = useState(false);
  return <div className="shell"><header className="site-header"><Brand /><Link className="back-link" href={`/companions/${id}`}>返回伙伴</Link></header><main className="teams-page hub-page">{session ? <VoiceChat key={session + id} id={id} /> : <section className="team-panel"><h1>说话与心情</h1><button className="button primary" onClick={() => setLogin(true)}>注册 / 登录</button></section>}</main>{login && <AuthModal onClose={() => setLogin(false)} onLoggedIn={() => setLogin(false)} />}</div>;
}
