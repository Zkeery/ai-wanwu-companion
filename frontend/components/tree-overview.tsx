'use client';
import { useState } from 'react';
import type { LivingItem, LivingSpace } from '@/lib/contracts';
import { careLabel } from '@/lib/living-ui';
import styles from './tree-overview.module.css';

const states = { all: '全部小树', needs_care: '需要照料', growing: '成长中', mature: '已长成', stored: '收纳中' } as const;
type Filter = keyof typeof states;
function status(item: LivingItem): Exclude<Filter, 'all'> {
  return item.stored ? 'stored' : item.growth_status === 'mature' ? 'mature' : item.growth_status === 'growing' ? 'growing' : 'needs_care';
}
export default function TreeOverview({ space, onLocate, onRefresh, busy = false, locatingDisabled = false }: {
  space: LivingSpace; onLocate?: (id: string) => void; onRefresh?: () => void; busy?: boolean; locatingDisabled?: boolean;
}) {
  const [filter, setFilter] = useState<Filter>('all');
  const trees = space.items.filter(item => item.kind === 'tree');
  const shown = trees.filter(item => filter === 'all' || status(item) === filter);
  return <section className={styles.panel} aria-label="植物照料总览">
    <header><div><small>GROWING TOGETHER</small><h3>看看小树们</h3></div>{onRefresh && <button type="button" className="button ghost" disabled={busy} onClick={onRefresh}>更新植物状态</button>}</header>
    <p>照料过的小树慢慢长，暂时没照料也不会枯萎。</p>
    {trees.length ? <>
      <div className={styles.filters} role="group" aria-label="植物状态筛选">{Object.entries(states).map(([key, label]) => <button type="button" key={key} aria-pressed={filter === key} onClick={() => setFilter(key as Filter)}>{label} · {key === 'all' ? trees.length : trees.filter(item => status(item) === key).length}</button>)}</div>
      {shown.length ? <ul className={styles.list}>{shown.map(item => <li key={item.id}>
        <div><strong>小树 {trees.indexOf(item) + 1}</strong><span>{states[status(item)]}</span></div>
        <p>{item.stored ? '进度保留着，摆回来后再看看。' : item.growth_status === 'mature' ? '已经长成，不需要再照料。' : item.growth_status === 'growing' ? careLabel(item.care_remaining_seconds) : '点开看看，给它一点照料吧。'}</p>
        <small>累计有效成长 {Math.floor(Math.min(72 * 3600, Math.max(0, item.growth_seconds)) / 3600)} 小时 / 72 小时</small>
        {!item.stored && onLocate && <button type="button" className="button ghost" disabled={busy || locatingDisabled} aria-label={`定位小树 ${trees.indexOf(item) + 1}`} onClick={() => onLocate(item.id)}>去看看这棵树</button>}
      </li>)}</ul> : <p>这会儿没有“{states[filter]}”的小树。</p>}
    </> : <p>还没有可以照料的小树。点“布置场景”，放下一棵小树，就能陪它慢慢长大。花丛和仙人掌是装饰，不需要浇水。</p>}
    <small className={styles.stamp}>核对于 {new Date(space.observed_at * 1000).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false })}（上海时间）</small>
  </section>;
}
