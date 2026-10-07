'use client';
import { useState } from 'react';
import Link from 'next/link';
import { Brand } from '@/components/common';
import { SceneSeasonPreview, type SeasonalScene } from '@/components/scene-season-backdrop';
import { seasonNames, type Season } from '@/lib/seasons';
import styles from './preview.module.css';

export default function ScenePreviewPage() {
  const [scene, setScene] = useState<SeasonalScene>('home');
  const [season, setSeason] = useState<Season>('spring');
  return <div className="shell toy-shell">
    <header className="site-header"><Brand /><Link href="/" className="back-link">返回我的伙伴</Link></header>
    <main className={styles.main}>
      <h1>看看这里的四季</h1>
      <p>先看看庭院和森林在不同季节的样子。这里只预览画面，不会改变你的伙伴或布置。</p>
      <div className={styles.options} role="group" aria-label="选择预览场景">
        <button type="button" aria-pressed={scene === 'home'} onClick={() => setScene('home')}>家庭庭院</button>
        <button type="button" aria-pressed={scene === 'forest'} onClick={() => setScene('forest')}>森林营地</button>
      </div>
      <div className={styles.options} role="group" aria-label="选择预览季节">
        {(['spring', 'summer', 'autumn', 'winter'] as Season[]).map(s => <button key={s} type="button" aria-pressed={season === s} onClick={() => setSeason(s)}>{seasonNames[s]}</button>)}
      </div>
      <SceneSeasonPreview scene={scene} season={season} caption={`${seasonNames[season]}的${scene === 'home' ? '家庭庭院' : '森林营地'} · 画面预览`} />
      <p className={styles.note}>想给自己的小天地设置四季，可以返回伙伴，进入“生活”后选择场景，再点“设置四季”。</p>
    </main>
  </div>;
}
