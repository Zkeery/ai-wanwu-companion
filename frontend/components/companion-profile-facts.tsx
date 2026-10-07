'use client';
import Link from 'next/link';
import { sceneNames, type Character, type CharacterOverview, type Scene } from '@/lib/contracts';
import styles from './companion-profile-facts.module.css';

export function companionLocation(presence: CharacterOverview | null) {
  if (!presence) return '位置暂未核对';
  if (presence.gathering) return `正在“${presence.gathering.title}”相聚`;
  if (presence.residence) return `${sceneNames[presence.residence.scene_type]} · ${presence.residence.mode === 'private' ? '独自生活' : '同住'}`;
  return '还没有选择住处';
}

function firstDay(value: string) {
  // CharacterOut's legacy timestamps without an offset are UTC.
  const date = new Date(/(?:Z|[+-]\d{2}:\d{2})$/i.test(value) ? value : `${value}Z`);
  return Number.isFinite(date.getTime()) ? new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: 'long', day: 'numeric',
  }).format(date) : '还没有记录';
}

export default function CompanionProfileFacts({ character, presence, scene }: {
  character: Character; presence: CharacterOverview | null; scene: Scene;
}) {
  const location = presence?.gathering ? `/gatherings?space=${encodeURIComponent(presence.gathering.id)}`
    : presence?.residence ? `/companions/${character.id}/scenes/${presence.residence.scene_type}/${encodeURIComponent(presence.residence.space_id)}` : null;
  const saved = scene.living;
  return <div className={styles.facts} aria-label="伙伴资料卡">
    <div className={styles.date}><span>初次见面</span><strong>{firstDay(character.created_at)}</strong><small>按上海时间记录</small></div>
    <div className={styles.place}><span>现在在哪</span><strong>{companionLocation(presence)}</strong>
      {location ? <Link href={location}>{presence?.gathering ? '去相聚的地方看看' : '去现在的小天地'} →</Link>
        : presence ? <Link href={`/companions/${character.id}/scenes`}>安排一个住处 →</Link>
          : <small>点“更新资料”，再看看伙伴的去向。</small>}
    </div>
    <div className={styles.saved}><span>已保存的小天地</span><strong>{saved ? `${sceneNames[saved.scene_type]} · ${saved.mode === 'private' ? '私人布置' : '同住空间'}` : '还没有保存的小天地'}</strong>
      {saved ? <><small>布置留在这里，伙伴现在的去向看上方。</small><Link href={`/companions/${character.id}/scenes/${saved.scene_type}/${encodeURIComponent(saved.id)}`}>看看保存的布置 →</Link></>
        : <small>安排住处后，这里会留下你们的小天地。</small>}
    </div>
  </div>;
}
