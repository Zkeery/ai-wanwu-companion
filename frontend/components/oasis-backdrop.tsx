'use client';
import Image from 'next/image';
import { useState } from 'react';
import { seasonNames, type Season } from '@/lib/seasons';
import styles from './oasis-backdrop.module.css';

export const oasisBackground = (season: Season | null) =>
  !season ? '/oasis/terrain.png' : `/oasis/terrain-${season}-v2.png`;

export default function OasisBackdrop({ season }: { season: Season | null }) {
  return <Backdrop key={season ?? 'base'} season={season} />;
}

function Backdrop({ season }: { season: Season | null }) {
  const [failed, setFailed] = useState(false), [attempt, setAttempt] = useState(0);
  const source = oasisBackground(season);
  return <>
    {!failed && <div className={styles.layer} aria-hidden="true">
      <Image key={attempt} src={attempt ? `${source}?retry=${attempt}` : source} alt="" fill unoptimized sizes="100vw" onError={() => setFailed(true)} draggable={false} />
    </div>}
    {failed && <div className={styles.fallback} role="status" onClick={e => e.stopPropagation()}>
      <span>季节画面暂未加载，先保留基础景色。</span>
      <button type="button" onClick={() => { setAttempt(n => n + 1); setFailed(false); }}>重试季节画面</button>
    </div>}
  </>;
}

export function OasisSeasonPreview({ season }: { season: Season }) {
  return <figure className={styles.preview}>
    <div className={styles.canvas}><OasisBackdrop season={season} /></div>
    <figcaption>{seasonNames[season]}的绿洲 · 确认后换上这幅景色，物件仍留在原位。</figcaption>
  </figure>;
}
