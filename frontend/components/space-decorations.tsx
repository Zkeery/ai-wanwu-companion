'use client';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { activities, decorationNames } from '@/lib/activities';
import { errorText } from '@/lib/api';
import { Notice } from './common';

export default function SpaceDecorations({ spaceId, kind }: { spaceId: string; kind: 'private' | 'gathering' }) {
  const [items, setItems] = useState<Awaited<ReturnType<typeof activities.inSpace>> | null>(null), [error, setError] = useState('');
  useEffect(() => { let active = true; activities.inSpace(spaceId, kind).then(v => { if (active) setItems(v); }).catch(e => { if (active) setError(errorText(e)); }); return () => { active = false; }; }, [spaceId, kind]);
  return <section className="space-decorations"><h3>这里的纪念装饰</h3>{error ? <Notice>{error}</Notice> : items === null ? <p>正在查看装饰…</p> : items.length ? <div className="row">{items.map(i => <span key={i.id} className="decoration-display"><span aria-hidden="true">{({ memorial_pot: '🪴', memorial_ornament: '🏵️', leaf_wreath: '🍂', colorful_pot: '🌺', warm_lights: '🏮', swing: '🎠' } as Record<string, string>)[i.kind]}</span>{decorationNames[i.kind]}{kind === 'gathering' && (i.mine ? ' · 我贡献的' : ' · 成员贡献')}</span>)}</div> : <p>参加伙伴活动，可以获得装饰和建设资源。</p>}<Link className="button" href="/activities">活动与装饰库存</Link></section>;
}
