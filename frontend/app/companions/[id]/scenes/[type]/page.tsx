'use client';
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { ArrowLeft } from 'lucide-react';
import { api, ApiError, errorText } from '@/lib/api';
import { type CharacterOverview, type LivingSpace, type SceneType, type SpaceMember } from '@/lib/contracts';
import { residencePresence } from '@/lib/residence-presence';
import { sceneMeta } from '@/lib/living-ui';
import { Brand, Loading, Notice } from '@/components/common';
import LivingScene from '@/components/living-scene';

export default function ScenePage() {
  const params = useParams();
  const characterId = Number(params.id);
  const type = String(params.type) as SceneType;
  const explicitSpaceId = params.spaceId == null ? null : String(params.spaceId);
  return <SceneContent key={`${characterId}:${type}:${explicitSpaceId ?? ''}`} characterId={characterId} type={type} explicitSpaceId={explicitSpaceId} />;
}

function SceneContent({ characterId, type, explicitSpaceId }: { characterId: number; type: SceneType; explicitSpaceId: string | null }) {
  const valid = Object.hasOwn(sceneMeta, type);
  const [overviews, setOverviews] = useState<CharacterOverview[]>([]);
  const [members, setMembers] = useState<SpaceMember[]>([]);
  const [space, setSpace] = useState<LivingSpace | null>(null);
  const [error, setError] = useState('');
  const [unavailable, setUnavailable] = useState(false);
  const [revision, setRevision] = useState(0);

  useEffect(() => {
    if (!valid || !Number.isInteger(characterId) || characterId < 1) return;
    let active = true;
    (async () => {
      try {
        const [spaces, location, overview] = await Promise.all([api.living.spaces(), api.living.location(characterId), api.characterOverview()]);
        if (!active) return;
        const target = explicitSpaceId
          ? spaces.find(s => s.id === explicitSpaceId && s.scene_type === type)
          : spaces.find(s => s.id === location && s.scene_type === type) ?? spaces.find(s => s.scene_type === type && s.mode === 'private' && s.companion_id === String(characterId));
        if (explicitSpaceId && !target) throw new Error('找不到这个生活空间，请返回重新选择。');
        if (target?.mode === 'private' && target.companion_id !== String(characterId)) throw new Error('这是其他伙伴的独居空间，请返回重新选择。');
        const targetMembers = target?.mode === 'shared' ? target.members ?? await api.living.members(target.id) : [];
        if (target?.mode === 'shared' && !targetMembers.some(m => m.companion_id === String(characterId))) throw new Error('这个伙伴还不是同住成员，请返回选择场景后加入。');
        let snapshot: LivingSpace;
        if (target) snapshot = await api.living.space(target.id);
        else {
          try { snapshot = await api.living.create(type, 'private', characterId); }
          catch (e) {
            if (!(e instanceof ApiError) || e.status !== 409) throw e;
            // Another tab may have created the same private space in the meantime.
            const latest = await api.living.spaces();
            const existing = latest.find(s => s.scene_type === type && s.mode === 'private' && s.companion_id === String(characterId));
            if (!existing) throw e;
            snapshot = await api.living.space(existing.id);
          }
        }
        if (!active) return;
        if (active) { setSpace(snapshot); setOverviews(overview); setMembers(targetMembers); }
      } catch (e) { if (active) { setUnavailable(e instanceof ApiError && e.status === 404); setError(errorText(e)); } }
    })();
    return () => { active = false; };
  }, [characterId, type, valid, explicitSpaceId, revision]);

  const presence = space ? residencePresence(space, members, overviews, characterId) : null;
  const viewed = presence?.viewed;
  const readOnly = !!space && space.mode === 'private' && (!viewed || !!viewed.gathering);
  return <div className="shell toy-shell">
    <header className="site-header"><Brand /><Link className="back-link" href={`/companions/${characterId}/scenes`}><ArrowLeft size={16} />选择场景</Link></header>
    <main className="collection scene-page">
      {!valid || !Number.isInteger(characterId) || characterId < 1 ? <Notice>{'这个场景还没有开放。'}</Notice> : error ? unavailable ? <Notice><div><p>当前账号无法打开这个伙伴或场景。可以回到自己的伙伴，或先看看四季画面。</p><Link className="text-button" href="/">返回我的伙伴</Link>{' · '}<Link className="text-button" href="/scene-preview">看四季画面</Link></div></Notice> : <Notice retry={() => { setError(''); setUnavailable(false); setSpace(null); setRevision(n => n + 1); }}>{error}</Notice> : space === null ? <Loading /> : <><div className="residence-summary"><span>{space.mode === 'shared' ? '一起生活 · 共用同一份布置' : '独自生活 · 私人布置'}</span>{space.mode === 'shared' && <><p>{members.map(m => { const item = overviews.find(o => String(o.character.id) === m.companion_id); return `${m.name ?? '未命名伙伴'} #${m.companion_id} · ${!item ? '位置待核对' : item.residence?.space_id === space.id ? '在这里' : item.gathering ? '去小队相聚了' : '还没来到这里'}`; }).join('、')}</p><Link className="text-button" href={`/companions/${characterId}/scenes`}>管理同住伙伴 / 搬回独居</Link></>}{viewed?.residence?.space_id !== space.id && <p role="status">{!viewed ? '伙伴当前位置暂时无法核对；原布置仍保留。' : viewed.gathering ? <>{viewed.character.name}去“{viewed.gathering.title}”相聚了。<Link href={`/gatherings?space=${encodeURIComponent(viewed.gathering.id)}`}>去共同空间看看</Link></> : `${viewed.character.name}当前不在这里；原布置仍保留。`}</p>}{readOnly && <p role="status">原住处现在只能看看；伙伴回来后才能继续布置和照料。</p>}</div><LivingScene key={`${space.id}:${readOnly}`} space={space} companions={presence?.occupants ?? []} readOnly={readOnly} onChange={setSpace} /></>}
    </main>
    <footer><strong>万物有趣，陪伴有形。</strong><span>MADE FOR YOUR EVERYDAY MAGIC ✳</span></footer>
  </div>;
}
