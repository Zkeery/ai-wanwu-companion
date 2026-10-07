'use client';
/* eslint-disable @next/next/no-img-element */
import CompanionMotionPreview from './companion-motion-preview';
import CreationDeadline from './creation-deadline';
import { beginGenerationMeasurement, type GenerationMeasurement } from '@/lib/generation-performance';
import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { ArrowLeft, ArrowRight, Check, ImagePlus, Leaf, LogIn, Sparkles } from 'lucide-react';
import { Brand, Notice } from './common';
import AuthModal from './auth-modal';
import PersonalityEditor from './personality-editor';
import PublicationDialog from './publication-dialog';
import { ApiError, api, errorText } from '@/lib/api';
import { getToken } from '@/lib/auth';
import { imageUrl, type Character } from '@/lib/contracts';
import { MAX_CANDIDATES } from '@/lib/input-limits';
import { returnHref, type CreationOrigin } from '@/lib/creation-origin';
import { themeName } from '@/lib/themes';
import { offlineSampleFile } from '@/lib/offline-sample';
import { creationApi, DRAFT_KEY, GenerationFailedError, generateCompanion, readDraft, validatePhoto, writeDraft, type Draft, type Photo } from '@/lib/creation';

type Step = 'upload' | 'objects' | 'generating' | 'recover' | 'result';
export default function CreateCompanion({ initialTheme = null, initialOrigin = null }: { initialTheme?: string | null; initialOrigin?: CreationOrigin | null }) {
  const [origin, setOrigin] = useState<CreationOrigin | null>(initialOrigin);
  const [sharing, setSharing] = useState(false);
  const [personality, setPersonality] = useState(false);
  const [themeId, setThemeId] = useState<string | null>(initialTheme), [freeCreation, setFreeCreation] = useState(false);
  const [restoredTheme, setRestoredTheme] = useState(false);
  const validTheme = themeId === null || themeId === 'fruit';
  const [hasDraft, setHasDraft] = useState(false);
  const [authed, setAuthed] = useState<boolean | null>(null), [showAuth, setShowAuth] = useState(false);
  const [step, setStep] = useState<Step>('recover'), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const [file, setFile] = useState<File | null>(null), [preview, setPreview] = useState(''), [previewFailed, setPreviewFailed] = useState(false);
  const [photo, setPhoto] = useState<Photo | null>(null), [selected, setSelected] = useState<number | null>(null), [label, setLabel] = useState('');
  const [visualFeatures, setVisualFeatures] = useState('');
  const [character, setCharacter] = useState<Character | null>(null), [name, setName] = useState(''), [savedNotice, setSavedNotice] = useState('');
  const [stage, setStage] = useState('正在找回你的创建进度…'), [renameUncertain, setRenameUncertain] = useState(false);
  const [startedAt, setStartedAt] = useState<number | null>(null), [completedMs, setCompletedMs] = useState<number | null>(null);
  const [resultImageFailed, setResultImageFailed] = useState(false);
  const [credits, setCredits] = useState<Awaited<ReturnType<typeof api.generationCredits>> | null>(null);
  const modelPaused = credits?.model_available === false;
  const pausedMessage = credits?.unavailable_message || 'AI服务已暂停，已有伙伴和记录仍可查看，请联系维护者恢复服务。';
  const measurement = useRef<GenerationMeasurement | null>(null);
  useEffect(() => {
    const interrupt = () => measurement.current?.finish('interrupted');
    window.addEventListener('pagehide', interrupt);
    return () => { window.removeEventListener('pagehide', interrupt); interrupt(); };
  }, []);
  const draft = useRef<Draft | null>(null), lock = useRef(false), controller = useRef<AbortController | null>(null);

  useEffect(() => {
    let active = true;
    (async () => {
      if (!getToken()) { if (active) setAuthed(false); return; }
      try { await api.auth.me(); if (active) setAuthed(true); }
      catch { if (active) setAuthed(false); }
    })();
    return () => { active = false; };
  }, []);

  useEffect(() => {
    if (!authed) return;
    let active = true;
    api.generationCredits().then(value => { if (active) setCredits(value); }).catch(() => { /* Submission checks availability before uploading. */ });
    return () => { active = false; };
  }, [authed, step]);

  async function checkCredits() {
    const value = await api.generationCredits(); setCredits(value);
    if (value.model_available === false) throw new ApiError(value.unavailable_message || pausedMessage, 503, 'model_service_paused');
    if (value.enabled && value.available === 0) throw new ApiError('本次内测的生成额度已用完，已有伙伴仍可继续陪伴你', 409, 'credits_exhausted');
  }

  const saveDraft = useCallback((value: Draft) => { writeDraft(value); draft.current = value; setHasDraft(true); }, []);
  const showResult = useCallback((value: Character, preserveName = false) => { setCharacter(value); if (!preserveName) setName(value.name); setStep('result'); }, []);
  const recover = useCallback(async (record: Draft, preserveName = false) => {
    if (lock.current) return;
    measurement.current?.finish('interrupted'); measurement.current = null;
    lock.current = true; setBusy(true); setError(''); setStartedAt(null); setCompletedMs(null); setResultImageFailed(false); setStep('recover'); setStage('正在核对已保存的结果…');
    const c = new AbortController(); controller.current = c;
    try {
      setOrigin(record.origin ?? null);
      setThemeId(record.themeId ?? null); setFreeCreation(record.freeCreation ?? false); setRestoredTheme(true);
      let restored: Photo;
      if (record.photoId) restored = await creationApi.photo(record.photoId, c.signal);
      else {
        const receipt = await creationApi.receipt(record.requestId, c.signal);
        if (c.signal.aborted) return;
        if (receipt.status === 'running') { setStage('照片仍在识别中，稍后可以再次核对。'); return; }
        if (receipt.status === 'failed') { setStep('upload'); setError('上次识别未完成。请重新选择照片后再试。'); return; }
        if (!receipt.photo) throw new Error('没有找到识别结果，请稍后再核对');
        restored = receipt.photo;
        saveDraft({ ...record, photoId: restored.id });
      }
      if (c.signal.aborted) return;
      setPhoto(restored); setThemeId(restored.theme_id ?? null);
      saveDraft({ ...record, photoId: restored.id, themeId: restored.theme_id ?? null });
      if (record.objectId) {
        const value = await creationApi.byObject(record.objectId, c.signal);
        if (c.signal.aborted) return;
        setSelected(record.objectId); setLabel(record.label ?? restored.objects.find(o => o.id === record.objectId)?.label ?? '');
        setVisualFeatures(record.visualFeatures ?? restored.objects.find(o => o.id === record.objectId)?.visual_features ?? '');
        if (value?.status === 'ready') { showResult(value, preserveName); setRenameUncertain(false); setSavedNotice(preserveName ? `服务器当前保存的名字：${value.name}` : ''); return; }
        if (value?.status === 'generating') { setStage('伙伴仍在生成中，稍后可以再次核对。不会再次发起生成。'); return; }
        if (!restored.objects.slice(0, MAX_CANDIDATES).some(o => o.id === record.objectId)) {
          setSelected(null); setLabel(''); setVisualFeatures('');
          saveDraft({ origin: record.origin, requestId: record.requestId, photoId: restored.id, themeId: restored.theme_id ?? null, freeCreation: record.freeCreation });
          setError('上次选择的对象不在当前候选中，请重新选择。');
        } else if (value?.status === 'failed') setError('这次生成没有完成，已保留对象描述，可以手动重试。');
      }
      setStep('objects');
    } catch (e) {
      if (c.signal.aborted) return;
      if (e instanceof ApiError && e.status === 404) { setOrigin(initialOrigin); setThemeId(initialTheme); setFreeCreation(false); setStep('upload'); setError('没有找到可恢复的记录，请重新选择照片。'); }
      else setError(errorText(e) + '。请先核对，勿重复提交。');
    } finally { lock.current = false; if (!c.signal.aborted) setBusy(false); }
  }, [initialOrigin, initialTheme, saveDraft, showResult]);

  useEffect(() => {
    if (authed !== true) return;
    let active = true;
    Promise.resolve().then(() => {
      if (!active) return;
      try { const saved = readDraft(); draft.current = saved; setHasDraft(Boolean(saved)); if (saved) void recover(saved); else setStep('upload'); }
      catch (e) { setError(errorText(e)); setStep('upload'); }
    });
    return () => { active = false; controller.current?.abort(); };
  }, [recover, authed]);
  useEffect(() => { if (!file) return; const url = URL.createObjectURL(file); setPreview(url); return () => URL.revokeObjectURL(url); }, [file]); // eslint-disable-line react-hooks/set-state-in-effect

  function chooseFile(value: File | undefined) {
    if (lock.current || !value) return;
    setError(''); setPreview(''); setPreviewFailed(false); setFile(null);
    const issue = validatePhoto(value);
    if (issue) { setError(issue); return; }
    setFile(value); setPhoto(null); setSelected(null); setLabel(''); setVisualFeatures(''); draft.current = null; setHasDraft(false);
    try { sessionStorage.removeItem(DRAFT_KEY); } catch { /* writeDraft will block submission. */ }
  }
  async function upload(startTime: number, inputFile = file) {
    if (lock.current || !inputFile || !validTheme) return;
    measurement.current?.finish('interrupted'); measurement.current = beginGenerationMeasurement(startTime);
    lock.current = true; setBusy(true); setError(''); setStartedAt(startTime); setCompletedMs(null); setResultImageFailed(false); setStage('正在分析照片，并构思伙伴的模样与性格…');
    const c = new AbortController(); controller.current = c;
    let sent = false;
    try {
      await checkCredits();
      if (c.signal.aborted) return;
      const record = { origin, requestId: crypto.randomUUID(), themeId, freeCreation }; saveDraft(record); sent = true;
      measurement.current?.mark('upload_started');
      const result = await creationApi.upload(inputFile, record.requestId, c.signal, freeCreation ? null : themeId);
      if (c.signal.aborted) return;
      measurement.current?.mark('recognized');
      saveDraft({ ...record, photoId: result.id, themeId: result.theme_id ?? null }); setPhoto(result);
      const primary = result.objects[0];
      if (!primary) { measurement.current?.finish('needs_review'); setStep('objects'); return; }
      setSelected(primary.id); setLabel(primary.label); setVisualFeatures(primary.visual_features || '');
      await runGeneration(result, primary.id, primary.label, primary.visual_features || '', c);
    } catch (e) {
      if (!c.signal.aborted) {
        const rejected = e instanceof ApiError && ([400, 413, 422].includes(e.status) || (e.status === 502 && e.code === 'recognize_failed'));
        measurement.current?.finish(sent && !rejected ? 'interrupted' : 'failed');
        setError(sent && !rejected ? '等待识别结果的连接中断了，照片可能已经识别完成。' : errorText(e)); setStep(sent && !rejected ? 'recover' : 'upload');
        setStage('点击“核对结果”继续，不需要重新上传照片。');
      }
    } finally { lock.current = false; if (!c.signal.aborted) setBusy(false); }
  }
  async function generate() {
    if (lock.current || !selected || !photo || !photo.objects.slice(0, MAX_CANDIDATES).some(o => o.id === selected) || !label.trim() || label.trim().length > 100 || !draft.current) return;
    lock.current = true; setBusy(true); setError('');
    const c = new AbortController(); controller.current = c;
    measurement.current?.finish('needs_review'); measurement.current = null;
    setStartedAt(null); setCompletedMs(null); setResultImageFailed(false);
    try { await runGeneration(photo, selected, label.trim(), visualFeatures.trim(), c); }
    finally { lock.current = false; if (!c.signal.aborted) setBusy(false); }
  }
  async function runGeneration(source: Photo, objectId: number, objectLabel: string, features: string, c: AbortController) {
    let sent = false;
    try {
      const candidate = source.objects.find(o => o.id === objectId);
      const activeTheme = source.theme_id && !draft.current?.freeCreation;
      if (activeTheme && (candidate?.category !== 'fruit' || candidate.label !== objectLabel)) {
        measurement.current?.finish('needs_review');
        setStep('objects'); setError('还不能确认这个对象符合水果主题。可以选择识别到的水果、换张照片，或改为自由创作。'); return;
      }
      await checkCredits();
      if (c.signal.aborted) return;
      if (!draft.current) throw new Error('没有可恢复的创建记录');
      saveDraft({ ...draft.current, photoId: source.id, objectId, label: objectLabel, visualFeatures: features });
      setStep('generating'); setStage('正在为第一次见面做准备…'); sent = true;
      measurement.current?.mark('generation_started');
      const result = await generateCompanion(objectId, objectLabel, c.signal, text => { if (!c.signal.aborted) setStage(text); }, features, draft.current.freeCreation ?? false);
      if (!c.signal.aborted) { measurement.current?.mark('ready'); showResult(result); }
    } catch (e) { if (!c.signal.aborted) {
      const confirmed = e instanceof GenerationFailedError || (e instanceof ApiError && e.code === 'theme_mismatch');
      measurement.current?.finish(confirmed || !sent ? 'failed' : 'interrupted');
      setError(errorText(e) + (confirmed ? ' 对象描述和照片特征已保留，可以手动重试。' : ''));
      setStep(confirmed || !sent ? 'objects' : 'recover');
      setStage('先查看服务器已保存的状态，再决定是否重试。');
    } }
  }
  async function correctResult() {
    if (lock.current || !photo) return;
    measurement.current?.finish('needs_review'); measurement.current = null;
    lock.current = true; setBusy(true); setError(''); setStartedAt(null); setCompletedMs(null);
    const c = new AbortController(); controller.current = c;
    try {
      const record = { origin, requestId: crypto.randomUUID(), themeId: photo.theme_id ?? null, freeCreation: character?.theme_id == null };
      setFreeCreation(record.freeCreation);
      saveDraft(record);
      const corrected = await creationApi.correction(photo.id, record.requestId, c.signal);
      if (c.signal.aborted) return;
      saveDraft({ ...record, photoId: corrected.id });
      setPhoto(corrected); setSelected(null); setLabel(''); setVisualFeatures('');
      setStep('objects'); setSavedNotice(''); setRenameUncertain(false);
    } catch (e) { if (!c.signal.aborted) { setError(errorText(e)); setStep('recover'); setStage('请核对纠正草稿，原伙伴已保留在收藏。'); } }
    finally { lock.current = false; if (!c.signal.aborted) setBusy(false); }
  }
  const imageFailed = useCallback(() => setResultImageFailed(true), []);
  function imageLoaded(image: HTMLImageElement) {
    setResultImageFailed(false);
    if (startedAt === null || !image.naturalWidth || completedMs !== null) return;
    const measuredStart = startedAt, measured = measurement.current;
    requestAnimationFrame(() => requestAnimationFrame(() => {
      if (image.isConnected && measurement.current === measured) { const now = performance.now(); measured?.finish('succeeded', now); setCompletedMs(now - measuredStart); }
    }));
  }
  function editChoice(objectId: number, nextLabel: string, nextFeatures: string) {
    setSelected(objectId); setLabel(nextLabel); setVisualFeatures(nextFeatures);
    if (!draft.current || !photo) return;
    try { saveDraft({ ...draft.current, photoId: photo.id, objectId, label: nextLabel, visualFeatures: nextFeatures }); }
    catch (e) { setError(errorText(e)); }
  }
  function switchToFree() {
    if (lock.current) return;
    try {
      if (draft.current) saveDraft({ ...draft.current, freeCreation: true });
      setFreeCreation(true); setError('');
    } catch (e) { setError(errorText(e)); }
  }
  async function simulateCreation() {
    if (process.env.NEXT_PUBLIC_OFFLINE_PREVIEW !== 'true' || lock.current || !validTheme) return;
    const sample = offlineSampleFile();
    chooseFile(sample);
    await upload(performance.now(), sample);
  }
  async function rename() {
    if (lock.current || !character || renameUncertain || !name.trim() || name.trim().length > 40) return;
    lock.current = true; setBusy(true); setError(''); setSavedNotice('');
    const c = new AbortController(); controller.current = c;
    try { const result = await creationApi.rename(character.id, name.trim(), c.signal); if (!c.signal.aborted) { showResult(result); setSavedNotice('名字已保存'); } }
    catch (e) { if (!c.signal.aborted) { setError(errorText(e) + '。请核对名字是否已经保存。'); setRenameUncertain(true); } }
    finally { lock.current = false; if (!c.signal.aborted) setBusy(false); }
  }
  function startAnother() { if (lock.current) return; measurement.current?.finish('interrupted'); measurement.current = null; setRestoredTheme(false); setThemeId(origin?.theme ?? themeId); setFreeCreation(false); setStartedAt(null); setCompletedMs(null); setResultImageFailed(false); try { sessionStorage.removeItem(DRAFT_KEY); } catch { /* Replaced before next request. */ } draft.current = null; setHasDraft(false); setFile(null); setPreview(''); setPhoto(null); setSelected(null); setCharacter(null); setLabel(''); setVisualFeatures(''); setName(''); setError(''); setSavedNotice(''); setRenameUncertain(false); setStep('upload'); }
  function startFromEntry() {
    if (lock.current) return;
    startAnother(); setOrigin(initialOrigin); setThemeId(initialTheme);
  }
  const differentEntry = restoredTheme && (themeId !== initialTheme || JSON.stringify(origin) !== JSON.stringify(initialOrigin));
  const selectedObject = photo?.objects.find(item => item.id === selected);
  const themeMismatch = Boolean(photo?.theme_id && !freeCreation && selectedObject && (selectedObject.category !== 'fruit' || selectedObject.label !== label.trim()));
  const progress = step === 'recover' ? -1 : step === 'upload' ? 0 : step === 'objects' ? 1 : 2;
  if (authed === null) return <div className="shell"><header className="site-header"><Brand /></header><main className="create-page"><div className="loading"><span className="loading-leaf"><Leaf /></span>正在把小世界打开…</div></main></div>;
  if (authed === false) {
    return <div className="shell"><header className="site-header"><Brand /><Link href="/" className="back-link"><ArrowLeft size={16} />我的伙伴</Link></header>
      <main className="create-page auth-welcome"><div className="eyebrow">A NEW FRIEND, FROM YOUR EVERYDAY</div><h1>先登录，<br />再认识你的新伙伴。</h1><p className="create-intro">登录后，生成的伙伴会安全地加入你的收藏。</p><button className="button hero-cta" onClick={() => setShowAuth(true)}><LogIn size={21} />注册 / 登录，开始创造<ArrowRight size={21} /></button></main>
      {showAuth && <AuthModal onClose={() => setShowAuth(false)} onLoggedIn={() => { setShowAuth(false); setAuthed(true); }} />}
    </div>;
  }
  return <div className="shell"><header className="site-header"><Brand /><Link href="/" className="back-link"><ArrowLeft size={16} />我的伙伴</Link></header>
    <main className="create-page"><div className="eyebrow">A NEW FRIEND, FROM YOUR EVERYDAY</div><h1>{themeId === 'fruit' && !freeCreation ? <>拍下喜欢的水果，<br />遇见独特的伙伴。</> : <>让日常里的它，<br />成为你的伙伴。</>}</h1><p className="create-intro">{themeId === 'fruit' && !freeCreation ? <>一颗苹果、一只橘子，选你喜欢的就好。<br />同一个主题，也会长出不同的小生命。</> : <>一只常用的杯子，一株窗边的植物。<br />从一张照片开始，认识它的另一面。</>}</p>
      {modelPaused && <Notice>{pausedMessage}</Notice>}
      {credits?.enabled && <p className="field-hint" role="status">{modelPaused ? <>账户保留 {credits.available} 次生成额度，服务恢复后可用。</> : <>剩余 {credits.available} 次生成额度 · 每个新伙伴消耗 1 次，技术失败会返还。</>}</p>}
      {origin && <div className="creation-origin"><p>{origin.kind === 'team' ? '来自好友小队 · 完成后可回到小队预览提交' : '来自水果主题 · 完成后可回到作品墙预览分享'}</p><Link href={returnHref(origin)}>返回{origin.kind === 'team' ? '小队' : '主题作品墙'}</Link></div>}
      {step === 'result' && differentEntry && <div className="creation-origin"><p>这是上次创作的伙伴，已保存在收藏里。你也可以按当前入口开始一次新创作。</p><button className="button" disabled={busy} onClick={startFromEntry}>按当前入口开始新创作</button></div>}
      <div className="creation-theme-banner">{!validTheme ? <><Notice>这个主题暂不可用，请重新选择。</Notice><Link href="/themes">选择主题</Link><button disabled={busy} onClick={() => { setThemeId(null); setFreeCreation(true); }}>自由创作</button></> : <><span><Sparkles size={16} />{themeName(freeCreation ? null : themeId)}</span><p>{themeId && !freeCreation ? '拍一份你喜欢的水果。大家用同一个主题，每位伙伴都有自己的模样。' : '从身边的小物开始，创造属于你的独特伙伴。'}</p>{restoredTheme && <small>正在接着上次的创作；主题以已保存的记录为准。</small>}{step === 'upload' && !busy && <Link href="/themes">看看创作主题<ArrowRight size={14} /></Link>}</>}</div>
      <ol className="create-steps" aria-label="创建步骤">{['选一张照片', '自动创造', '第一次见面'].map((text, i) => <li key={text} className={i === progress ? 'current' : i < progress ? 'complete' : ''} aria-current={i === progress ? 'step' : undefined}><span>{i < progress ? <Check size={14} /> : `0${i + 1}`}</span>{text}</li>)}</ol>
      <section className="create-card" aria-busy={busy}>
        {step === 'upload' && process.env.NEXT_PUBLIC_OFFLINE_PREVIEW === 'true' && <div className="offline-creation-tools"><strong>先体验一次模拟相遇</strong><p>点下面的按钮会上传内置示意图，识别结果和伙伴形象由离线规则生成，可能与图片无关。只用于体验流程，不消耗付费模型。</p><button className="primary" disabled={busy || !validTheme} onClick={() => void simulateCreation()}><Sparkles size={16} />{busy ? '正在模拟生成…' : '模拟生成伙伴'}</button></div>}
        {error && <Notice>{error}</Notice>}
        {startedAt !== null && <CreationDeadline key={startedAt} startedAt={startedAt} completedMs={completedMs} active={(step === 'upload' && busy && !error) || step === 'generating' || step === 'result'} getRecord={() => draft.current} canQuery={hasDraft} />}
        {step === 'upload' && <div className="create-upload"><div className="upload-art">{file && preview && !previewFailed ? <img src={preview} alt="选中的照片预览" onError={() => setPreviewFailed(true)} /> : <><div className="upload-orbit"><ImagePlus size={52} strokeWidth={1} /></div><span>{file ? '这张照片暂时无法预览' : '给平凡的小物，一点想象'}</span></>}</div><div className="upload-form"><span className="create-kicker">从身边的小物开始</span><h2>今天，想认识谁？</h2><p>{themeId === 'fruit' && !freeCreation ? '选一张水果的照片，' : '选一张物品或植物的照片，'}<br />尽量让它清楚地出现在画面里。</p><label className="file-label">选择照片<input aria-label="选择照片" type="file" accept=".jpg,.jpeg,.png,.webp,.heic,.heif" disabled={busy || modelPaused} onChange={e => chooseFile(e.target.files?.[0])} /></label><p className="file-hint">JPG / PNG / WebP / HEIC · 单张不超过 10MB，长边不超过 4096px</p>{file && <p className="selected-file">已选择：{file.name}</p>}<button className="primary" disabled={!file || busy || !validTheme || modelPaused} onClick={() => void upload(performance.now())}>{busy ? '正在识别…' : '上传并生成伙伴'}<ArrowRight size={16} /></button>{busy && <WaitingClock recognizing startedAt={startedAt} />}<p className="privacy-note">上传后自动为照片主体创造伙伴，完成后可纠正。原照片不保存，特征文字用于创作。</p></div></div>}
        {step === 'objects' && photo && <div className="object-step"><span className="create-kicker">再靠近一点点</span><h2>这次想和谁交朋友？</h2><p>选一个对象。认错了也没关系，你可以帮它补充描述。</p><div className="object-options" role="group" aria-label="识别到的对象">{photo.objects.slice(0, MAX_CANDIDATES).map(o => <button key={o.id} aria-pressed={selected === o.id} onClick={() => editChoice(o.id, o.label, o.visual_features || '')} disabled={busy}><Leaf size={20} />{o.label}{selected === o.id && <Check size={16} />}</button>)}</div><label className="text-label" htmlFor="object-label">对象描述</label><textarea id="object-label" placeholder="例如：一只米白色的陶瓷杯" maxLength={100} value={label} disabled={!selected || busy} onChange={e => selected && editChoice(selected, e.target.value, visualFeatures)} /><div className="field-hint">物品或植物 · 1–100 字<span>{label.length}/100</span></div>
          <label className="text-label" htmlFor="visual-features">照片里的特征</label>
          <textarea id="visual-features" placeholder="例如：淡粉色的圆杯身，白色小圆点，弯弯的把手" maxLength={500} value={visualFeatures} disabled={!selected || busy} onChange={e => selected && editChoice(selected, label, e.target.value)} aria-describedby="features-help" />
          <div className="field-hint">可以核对、补充或清空<span>{visualFeatures.length}/500</span></div>
          <p id="features-help" className="feature-help">{selected && !photo.objects.find(o => o.id === selected)?.visual_features ? '这张照片没有保存可用的特征，你可以自行补充。' : '请确认这些特征属于你选中的对象；修改对象名称后，也请一起核对。'}伙伴形象会结合这些特征和性格创作，不是原照片的逐像素复刻。</p>
          <div className="theme-choice-help">{themeMismatch && <p id="theme-mismatch-help" role="status">这个对象还不能按水果主题生成。请选择水果对象，或点“改为自由创作”再生成。</p>}{photo.theme_id && !freeCreation && <button disabled={busy} onClick={switchToFree}>改为自由创作</button>}</div><div className="create-actions"><button onClick={startAnother} disabled={busy}>换张照片</button><button className="primary" aria-describedby={themeMismatch ? 'theme-mismatch-help' : undefined} onClick={() => void generate()} disabled={busy || !selected || !label.trim() || themeMismatch}><Sparkles size={16} />生成伙伴</button></div><p className="privacy-note">确认后重新创作并加入收藏，原伙伴仍会保留。修改描述或特征时，会先调整角色构思。</p></div>}
        {(step === 'generating' || step === 'recover') && <div className="generation-state"><div className="generation-leaf"><Leaf size={42} strokeWidth={1.2} /></div><h2>{step === 'generating' ? '一个小小的相遇，正在发生。' : '接着上次的进度。'}</h2><p role="status">{stage}</p>{step === 'generating' && <WaitingClock startedAt={startedAt} />}<p className="privacy-note">离开后可回来核对结果；状态未确认前不会自动重复生成。</p>{step === 'recover' && hasDraft && <button className="primary" disabled={busy} onClick={() => void recover(draft.current!, renameUncertain)}>核对结果</button>}</div>}
        {step === 'result' && character && <div className="creation-result"><div className="creation-motion"><span className="result-saved"><Check size={14} />已加入我的伙伴</span>{imageUrl(character.image_path) ? <CompanionMotionPreview id={character.id} src={imageUrl(character.image_path)!} name={character.name} onStaticLoad={imageLoaded} onStaticError={imageFailed} /> : <div className="result-portrait"><Leaf size={80} strokeWidth={1} /></div>}{resultImageFailed && <Notice>图片暂时未能加载，请刷新核对，伙伴已保存。</Notice>}</div><div className="result-copy"><span className="create-kicker">很高兴认识你</span><p className="theme-result-label">{themeName(character.theme_id)} · 已加入我的收藏</p>{completedMs !== null && <p className="privacy-note" role="status">本次从上传到图片显示用时 {(completedMs / 1000).toFixed(1)} 秒</p>}<h2>你好，我是{character.name}。</h2><p className="opening-quote">“{character.opening_line}”</p><div className="result-personality"><h3>我的性格</h3><p>{character.persona}</p><button disabled={busy} onClick={() => setPersonality(true)}>调整性格</button></div><label className="text-label" htmlFor="companion-name">给伙伴一个喜欢的名字</label><input id="companion-name" className="name-input" value={name} maxLength={40} disabled={busy} onChange={e => setName(e.target.value)} /><div className="field-hint">1–40 字<span>{name.length}/40</span></div><div className="rename-row"><button disabled={busy || renameUncertain || !name.trim() || name.trim() === character.name} onClick={() => void rename()}>保存名字</button>{renameUncertain && <button disabled={busy} onClick={() => draft.current && void recover(draft.current, true)}>核对名字</button>}<span role="status">{savedNotice}</span></div>{origin && <div className="creation-origin"><Link className="button primary" href={returnHref(origin, character.theme_id === origin.theme ? character.id : undefined)}>{character.theme_id === origin.theme ? origin.kind === 'team' ? '回到小队，预览提交' : '回到主题，预览分享' : origin.kind === 'team' ? '回到原小队' : '回到原主题'}</Link><p>{character.theme_id === origin.theme ? '确认后才会分享；现在只在你的私人收藏里。' : '这位伙伴属于自由创作，不能提交到水果主题，仍保留在你的收藏里。'}</p></div>}<div className="create-actions"><Link className="button primary" href={`/companions/${character.id}`}>开始聊天<ArrowRight size={16} /></Link><Link className="button" href={`/companions/${character.id}/scenes`}>选择生活场景</Link><Link className="text-button" href="/">回到收藏</Link>{character.theme_id && <button className="button" disabled={busy} onClick={() => setSharing(true)}>分享作品</button>}</div>{personality && <PersonalityEditor key={character.id} id={character.id} close={() => setPersonality(false)} onSaved={persona => setCharacter(c => c ? { ...c, persona } : c)} />}{sharing && <PublicationDialog key={character.id} characterId={character.id} close={() => setSharing(false)} />}<div className="row"><button className="text-button" onClick={() => void correctResult()} disabled={busy}>纠正对象或特征</button><button className="text-button" onClick={startAnother} disabled={busy}>再认识一个伙伴</button></div></div></div>}
      </section><div className="create-bottom-note"><Leaf size={15} />每个小物，都藏着一个等待被听见的故事。</div>
    </main></div>;
}

function WaitingClock({ recognizing = false, startedAt }: { recognizing?: boolean; startedAt?: number | null }) {
  const [mounted] = useState(() => performance.now());
  const started = startedAt ?? mounted;
  const [elapsed, setElapsed] = useState(() => Math.floor((performance.now() - started) / 1000));
  useEffect(() => { const timer = setInterval(() => setElapsed(Math.floor((performance.now() - started) / 1000)), 1000); return () => clearInterval(timer); }, [started]);
  return <div className="waiting-clock"><span>已等待 {elapsed} 秒</span><small role="status">{recognizing ? (elapsed >= 5 ? '原识别请求仍在等待结果，不用重复上传。' : '正在辨认照片里的小细节，完成后会自动显示结果。') : (elapsed >= 5 ? '原生成请求仍在等待结果，可以核对已保存状态。' : '形象、人设都准备好后，就能一起玩了。')}</small></div>;
}
