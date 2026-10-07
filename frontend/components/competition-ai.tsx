'use client';
import { useEffect, useRef, useState } from 'react';
import { competitionAI, type AIStatus, type Phase } from '@/lib/competition-ai';
import { type Match } from '@/lib/activities';
import { getToken } from '@/lib/auth';
import { errorText } from '@/lib/api';
const stateNames: Record<string, string> = { running: '正在准备，请稍后核对', done: '已保存', failed: '本轮未发布，可继续按规则比赛', unknown: '结果待核对，本场不会再次调用' };
export default function CompetitionAI({ match, refresh }: { match: Match; refresh: () => Promise<void> }) {
  const [status, setStatus] = useState<AIStatus | null>(null), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const active = useRef(true), locked = useRef(false), owner = useRef(getToken());
  const pending = useRef(new Map<string, string>());
  const phase: Phase | null = match.status === 'registration' ? 'strategy' : match.status === 'completed' ? 'reflection' : null;
  const valid = () => active.current && owner.current === getToken();
  useEffect(() => {
    let alive = true; active.current = true;
    competitionAI.read(match.id).then(s => { if (alive && owner.current === getToken()) setStatus(s); }).catch(e => { if (alive) setError(errorText(e)); });
    return () => { alive = false; active.current = false; };
  }, [match.id, match.status]);
  async function check() {
    if (locked.current) return; locked.current = true; setBusy(true); setError('');
    try { const s = await competitionAI.read(match.id); if (valid()) { setStatus(s); await refresh(); } }
    catch (e) { if (valid()) setError(errorText(e)); }
    finally { locked.current = false; if (valid()) setBusy(false); }
  }
  async function generate(cid: number, grant: AIStatus['grants'][number]) {
    if (locked.current || !phase) return;
    locked.current = true; setBusy(true); setError('');
    try {
      const latest = await competitionAI.read(match.id);
      if (!valid()) return;
      setStatus(latest);
      if (latest.tasks.some(t => t.character_id === cid && t.phase === phase)) { await refresh(); return; }
      if (!latest.available || !latest.grants.some(g => g.id === grant.id)) { setError('本场额度或比赛状态已变化，请核对状态。'); return; }
      const attempt = `${cid}-${phase}-${grant.id}`;
      if (!pending.current.has(attempt)) pending.current.set(attempt, crypto.randomUUID());
      const s = await competitionAI.generate(match.id, cid, phase, grant.id, pending.current.get(attempt)!);
      if (valid()) { setStatus(s); await refresh(); }
    } catch (e) { if (valid()) setError(`${errorText(e)} 请先核对状态；不会自动重复生成。`); }
    finally { locked.current = false; if (valid()) setBusy(false); }
  }
  return <section className="team-panel" aria-label="伙伴的比赛想法"><h2>伙伴的比赛想法</h2>
    <p>报名时准备策略，完赛后说说感受。每位主人使用自己伙伴的本场额度；成绩和奖励按比赛规则结算。</p>
    <p>生成时会使用这位伙伴当前生效的性格描述和本场记录；发布的策略与感受可由同场成员查看。</p>
    {error && <p role="alert">{error}</p>}
    {!status ? <p>正在核对本场额度…</p> : <>
      {!status.available && <p>真实策略暂未开放，已有内容仍可查看。</p>}
      {match.participants.filter(p => p.owner_id === match.me && p.status !== 'withdrawn').map(p => {
        const task = status.tasks.find(t => t.character_id === p.id && t.phase === phase);
        const grant = status.grants.find(g => g.character_id === p.id && g.phase === phase);
        return <div className="hub-row" key={p.id}><span>{p.name}：{task ? stateNames[task.state] || '请核对状态' : phase ? grant ? `本次费用上限 ¥${(grant.cap_micro / 1_000_000).toFixed(4)}` : '暂无本场额度' : match.status === 'cancelled' ? '本场已取消，不再生成内容' : '比赛中，已保存的策略继续执行'}</span>
          {phase && grant && !task && status.available && <button className="button" disabled={busy} onClick={() => void generate(p.id, grant)}>为{p.name}{phase === 'strategy' ? '准备策略' : '生成赛后感受'}</button>}
        </div>;
      })}
      {status.tasks.filter(t => t.phase !== phase && t.state !== 'done').map(t => <p key={t.id}>{match.participants.find(p => p.id === t.character_id)?.name || '伙伴'} · {t.phase === 'strategy' ? '策略' : '赛后感受'}：{stateNames[t.state] || '请核对状态'}</p>)}
    </>}
    <button className="button" disabled={busy} onClick={() => void check()}>{busy ? '正在处理…' : '核对策略与额度'}</button>
  </section>;
}
