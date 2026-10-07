'use client';
import type { ReactNode, RefObject } from 'react';
import styles from './scene-navigation.module.css';

export function focusSceneSection(node: HTMLElement | null) {
  if (!node || !node.isConnected) return;
  for (let parent: HTMLElement | null = node; parent; parent = parent.parentElement) {
    if (parent instanceof HTMLDetailsElement) parent.open = true;
  }
  node.focus({ preventScroll: true });
  node.scrollIntoView?.({ block: 'start', behavior: 'instant' });
}

export default function SceneNavigation({ onActivity, onJournal, onSeason, onPlants }: {
  onActivity?: () => void; onJournal?: () => void; onSeason?: () => void; onPlants?: () => void;
}) {
  if (!onActivity && !onJournal && !onSeason && !onPlants) return null;
  return <nav aria-label="场景快捷入口" className={styles.navigation}>
    {onActivity && <button type="button" onClick={onActivity}>活动设置</button>}
    {onJournal && <button type="button" onClick={onJournal}>生活记录</button>}
    {onPlants && <button type="button" onClick={onPlants}>植物照料</button>}
    {onSeason && <button type="button" onClick={onSeason}>四季</button>}
  </nav>;
}

export function SceneSection({ sectionRef, title, onBack, children }: {
  sectionRef: RefObject<HTMLDivElement | null>; title: string; onBack: () => void; children: ReactNode;
}) {
  return <div ref={sectionRef} tabIndex={-1} role="region" aria-label={`${title}区域`} className={styles.section}>
    <button type="button" className={styles.back} aria-label={`从${title}回到场景`} onClick={onBack}>↑ 回到场景</button>
    {children}
  </div>;
}
