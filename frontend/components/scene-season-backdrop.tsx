'use client';
import Image from 'next/image';
import { useState } from 'react';
import { sceneNames } from '@/lib/contracts';
import { seasonNames, type Season } from '@/lib/seasons';
import { withBasePath } from '@/lib/base-path';
import styles from './scene-season-backdrop.module.css';
export type SeasonalScene = 'home' | 'forest';
const cells: Record<Season, { left: string; top: string }> = {
  spring: { left: '0%', top: '0%' }, summer: { left: '-100%', top: '0%' },
  autumn: { left: '0%', top: '-100%' }, winter: { left: '-100%', top: '-100%' },
};
export default function SceneSeasonBackdrop({ scene, season, raining = false }: { scene: SeasonalScene; season: Season | null; raining?: boolean }) {
  return <Backdrop key={`${scene}:${season ?? 'base'}`} scene={scene} season={season} raining={raining} />;
}
function Backdrop({ scene, season, raining }: { scene: SeasonalScene; season: Season | null; raining: boolean }) {
  const [failed, setFailed] = useState(false), [attempt, setAttempt] = useState(0);
  const source = withBasePath(`/seasons/${scene}-four-seasons-v1.png`);
  return <>
    {!failed && <div className={styles.layer} aria-hidden="true" data-season-art={season ?? undefined} data-scene-art={season ?? 'base'}>
      <Image key={attempt} src={attempt ? `${source}?retry=${attempt}` : source} width={1536} height={1024}
        alt="" unoptimized className={styles.atlas} style={cells[season ?? 'summer']} draggable={false} onError={() => setFailed(true)} />
      {raining && <span className={styles.rain} />}
    </div>}
    {failed && <div className={styles.fallback} role="status" onClick={e => e.stopPropagation()}>
      <span>{season ? '季节画面暂未加载，先保留基础景色。' : '场景画面暂未加载，可以重试。'}</span>
      <button type="button" onClick={() => { setAttempt(n => n + 1); setFailed(false); }}>{season ? '重试季节画面' : '重试场景画面'}</button>
    </div>}
  </>;
}
export function SceneSeasonPreview({ scene, season, caption }: { scene: SeasonalScene; season: Season | null; caption?: string }) {
  return <figure className={styles.preview}>
    <div className={styles.canvas}><SceneSeasonBackdrop scene={scene} season={season} /></div>
    <figcaption>{caption ?? (season ? `${seasonNames[season]}的${sceneNames[scene]} · 确认后换上这幅景色，物件仍留在原位。` : `${sceneNames[scene]} · 默认画面`)}</figcaption>
  </figure>;
}
