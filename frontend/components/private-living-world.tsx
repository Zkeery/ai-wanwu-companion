'use client';
import dynamic from 'next/dynamic';
import { useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import { api, errorText } from '@/lib/api';
import { AUTH_CHANGED, getToken } from '@/lib/auth';
import type { Character, LivingSpace, LivingWorldActivity } from '@/lib/contracts';
import { privateLivingWorld, sameLivingWorld } from '@/lib/living';
import { operatorTools } from '@/lib/operator-tools';
import type { HomeLeisureActivity } from '@/lib/living-home-leisure';
import { seasonApi, type Season } from '@/lib/seasons';
import styles from './shared-living-world-3d.module.css';

const SharedLivingWorld3D = dynamic(() => import('./shared-living-world-3d'), { ssr: false, loading: () => <p role="status">正在打开伙伴的住处…</p> });
type EditorOptions = { visible: boolean; onBusyChange: (value: boolean) => void; onSeasonChange: (value: Season | null) => void };
type Props = { space: LivingSpace; companions: Character[]; visible: boolean; readOnly: boolean; onChange: (space: LivingSpace) => void;
  renderEditor: (options: EditorOptions) => ReactNode };
const subscribeView = (change: () => void) => {
  const media = window.matchMedia?.('(prefers-reduced-motion: reduce)');
  document.addEventListener('visibilitychange', change); media?.addEventListener('change', change);
  return () => { document.removeEventListener('visibilitychange', change); media?.removeEventListener('change', change); };
};
const motionAllowed = () => !document.hidden && !(window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? true);
const subscribeSession = (change: () => void) => {
  window.addEventListener(AUTH_CHANGED, change); window.addEventListener('storage', change);
  return () => { window.removeEventListener(AUTH_CHANGED, change); window.removeEventListener('storage', change); };
};

export default function PrivateLivingWorld({ space, companions, visible, readOnly, onChange, renderEditor }: Props) {
  const [season, setSeason] = useState<Season | null>(null), [seasonError, setSeasonError] = useState('');
  const [editing, setEditing] = useState(false), [editorBusy, setEditorBusy] = useState(false);
  const [busy, setBusy] = useState(false), [uncertain, setUncertain] = useState(false), [error, setError] = useState(''), [message, setMessage] = useState('');
  const [focusedId, setFocusedId] = useState<number | null>(null), [accountLost, setAccountLost] = useState(false);
  const active = useRef(false), locked = useRef(false), session = useRef<string | null>(null), shown = useRef(visible);
  const motion = useSyncExternalStore(subscribeView, motionAllowed, () => false);
  const token = useSyncExternalStore(subscribeSession, getToken, () => null);
  const [figures, setFigures] = useState<Record<number, 'pending' | 'ready' | 'failed'>>({});
  const figureKey = companions.filter(companion => companion.status === 'ready' && companion.image_path).map(companion => companion.id).join(',');
  const snapshot = useMemo(() => {
    const world = privateLivingWorld(space, companions, season);
    if (!world) return null;
    return { ...world, companions: world.companions.map(companion => figures[companion.id] ? { ...companion, courtyard_figure: figures[companion.id] } : companion) };
  }, [space, companions, season, figures]);
  const current = useRef({ space, readOnly, onChange, snapshot });
  useEffect(() => { current.current = { space, readOnly, onChange, snapshot }; shown.current = visible; }, [space, readOnly, onChange, snapshot, visible]);
  useEffect(() => {
    active.current = true; session.current = getToken();
    const changed = () => { if (session.current !== getToken()) { active.current = false; setAccountLost(true); setEditing(false); setFocusedId(null); } };
    window.addEventListener(AUTH_CHANGED, changed); window.addEventListener('storage', changed);
    return () => { active.current = false; window.removeEventListener(AUTH_CHANGED, changed); window.removeEventListener('storage', changed); };
  }, []);
  useEffect(() => {
    if (!visible || accountLost) return;
    const ids = figureKey ? figureKey.split(',').map(Number) : [];
    if (!ids.length) return;
    const controller = new AbortController();
    let timer = 0;
    const loadFigures = async () => {
      let waiting = false;
      for (const id of ids) {
        try {
          const status = await api.courtyardFigure(id, controller.signal);
          if (controller.signal.aborted) return;
          if (status === 'pending' || status === 'running') waiting = true;
          const shown = status === 'running' ? 'pending' : status;
          if (shown === 'pending' || shown === 'ready' || shown === 'failed') {
            setFigures(current => current[id] === shown ? current : { ...current, [id]: shown });
          }
        } catch { /* 立牌先留着，下一轮再核对。 */ }
      }
      if (waiting && !controller.signal.aborted) timer = window.setTimeout(() => void loadFigures(), 4000);
    };
    void loadFigures();
    return () => { controller.abort(); window.clearTimeout(timer); };
  }, [visible, accountLost, figureKey]);
  useEffect(() => {
    if (!visible || accountLost) return;
    const controller = new AbortController();
    const load = async () => {
      try { const next = await seasonApi.read(space.id, controller.signal); if (!controller.signal.aborted && active.current) { setSeason(next.current_season); setSeasonError(''); } }
      catch (e) { if (!controller.signal.aborted && active.current) setSeasonError(errorText(e)); }
    };
    void load();
    const focus = () => { if (!document.hidden) void load(); };
    window.addEventListener('focus', focus);
    return () => { controller.abort(); window.removeEventListener('focus', focus); };
  }, [space.id, visible, accountLost]);

  const validSession = () => active.current && !!session.current && session.current === getToken();
  async function readBack(original: LivingSpace) {
    const latest = await api.living.space(original.id);
    if (!validSession()) return false;
    if (!sameLivingWorld(original, latest)) throw new Error('住处身份已改变，请刷新页面核对。');
    current.current.onChange(latest); setUncertain(false); return true;
  }
  async function save(command: Record<string, unknown>, actorId: number) {
    const original = current.current.space, present = current.current.snapshot?.companions.some(c => c.id === actorId && c.owner_id === original.owner_id);
    if (!validSession() || !shown.current || current.current.readOnly || locked.current || editorBusy || editing || uncertain || !present || String(actorId) !== original.companion_id) return;
    locked.current = true; setBusy(true); setError(''); setMessage('');
    try {
      const result = await api.living.action(original.id, crypto.randomUUID(), original.revision, command);
      if (!validSession()) return;
      if (!sameLivingWorld(original, result)) throw new Error('返回的住处无法核对，请先刷新。');
      current.current.onChange(result); setMessage('活动已保存，刷新后会保留。');
    } catch (e) {
      if (!validSession()) return;
      setError(errorText(e));
      try { await readBack(original); } catch { if (validSession()) setUncertain(true); }
    } finally { locked.current = false; if (validSession()) setBusy(false); }
  }
  async function refresh() {
    if (locked.current || editorBusy || !validSession()) return;
    locked.current = true; setBusy(true);
    try { if (await readBack(current.current.space)) { setError(''); setMessage('已核对保存的住处和活动。'); } }
    catch (e) { if (validSession()) { setError(errorText(e)); setUncertain(true); } }
    finally { locked.current = false; if (validSession()) setBusy(false); }
  }
  const arrange = (id: number, activity: LivingWorldActivity) => save({ action: 'world_activity', activity }, id);
  const leisure = (request: { activity: HomeLeisureActivity | null; actorId: number; seatId?: string }) => save({ action: 'world_leisure', activity: request.activity,
    ...(request.activity === null ? {} : { ...(request.seatId ? { seat_id: request.seatId } : {}), station_version: 1 }) }, request.actorId);
  if (accountLost) return <p role="status">登录状态已改变，请刷新页面后继续查看自己的住处。</p>;
  if (!token) return <p role="status">请先登录，再查看自己的住处。</p>;
  if (!snapshot) return null;
  return <section className={styles.privateWorld} aria-label="伙伴的立体住处">
    <div className="scene-heading-actions">
      <button className="button" aria-pressed={editing} disabled={busy || editorBusy || uncertain || !visible} onClick={() => { setEditing(value => !value); setFocusedId(null); }}>{editing ? '回到立体生活' : readOnly ? '查看布置与照料' : '布置与照料'}</button>
      {operatorTools && <button className="button ghost" disabled={busy || editorBusy || !visible} onClick={() => void refresh()}>核对住处</button>}
    </div>
    {error && <p role="alert" className="form-error">{error}</p>}
    {uncertain && <p role="status">保存结果尚未确认，已暂停新操作。请刷新页面后再继续。</p>}
    {message && <p role="status">{message}</p>}
    {readOnly && <p>原布置仍保留，当前只能查看；伙伴回来后再安排活动。</p>}
    {editing ? renderEditor({ visible, onBusyChange: setEditorBusy, onSeasonChange: setSeason }) : visible && <SharedLivingWorld3D
      gathering={snapshot} focusedId={focusedId} onSelect={setFocusedId} animate={motion && !busy && !uncertain}
      visualStyle="realistic" persistentWorld floorKind="private" localLeisurePreview localRoomTransitions localCompanionDoors localReferenceVilla localNaturalWorld localNaturalLeisure
      emptyMessage={space.resident_here === false ? '伙伴在外面相聚，这里保留原布置。' : undefined}
      busy={busy || uncertain || readOnly || space.resident_here !== true} onActivity={readOnly || space.resident_here !== true ? undefined : arrange} onLeisureAction={readOnly || space.resident_here !== true ? undefined : leisure} />}
    {!editing && <p className={styles.help}>点伙伴安排休息、睡觉或散步；点门进入住处。布置、照料和四季设置在“布置与照料”中。</p>}
    {seasonError && <p role="status">四季暂时无法核对，先保留基础画面。可在布置与照料中重新读取。</p>}
  </section>;
}
