'use client';
import { HandHeart, Leaf, RefreshCw } from 'lucide-react';
import type { LivingItem } from '@/lib/contracts';
import { careLabel } from '@/lib/living-ui';
import styles from './tree-growth.module.css';

const MATURITY = 72 * 3600;
function duration(seconds: number) {
  const minutes = Math.ceil(seconds / 60), hours = Math.floor(minutes / 60);
  return hours ? `${hours} 小时${minutes % 60 ? ` ${minutes % 60} 分钟` : ''}` : `${minutes} 分钟`;
}

export default function TreeGrowthCard({ item, observedAt, disabled = false, refreshing = false, onCare, onRefresh }: {
  item: LivingItem; observedAt: number; disabled?: boolean; refreshing?: boolean;
  onCare?: () => void; onRefresh?: () => void;
}) {
  if (item.kind !== 'tree') return null;
  const growth = Math.min(MATURITY, Math.max(0, item.growth_seconds));
  const mature = item.stage === 'mature' && growth === MATURITY;
  const percent = Math.floor(growth / MATURITY * 100);
  const state = mature ? '已经长成' : item.stored ? '收纳中，成长暂停' : item.growth_status === 'needs_care' ? '等你来照料' : '正在慢慢长大';
  const stamp = new Date(observedAt * 1000).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false });
  return <section className={styles.card} aria-label="小树成长详情">
    <div className={styles.heading}><Leaf size={22} aria-hidden="true" /><div><h3>小树的成长</h3><p>{state}</p></div><strong>{percent}%</strong></div>
    <progress className={styles.progress} aria-label="小树累计有效成长" value={growth} max={MATURITY} />
    <p>{mature ? '小树已经长成啦，不用再浇水，也会好好待在这里。' : `还需 ${duration(MATURITY - growth)}有效成长。`}</p>
    <p className={styles.explanation}>{mature ? item.stored ? '目前在收纳箱里，摆回来时仍是长成的样子。' : '这是你们慢慢照顾出来的小小风景。' : item.stored ? '之前的进度都在。摆回场景后，再看看要不要照料。' : item.growth_status === 'needs_care' ? '这会儿先歇一歇，照料后会继续长，不会枯萎。' : careLabel(item.care_remaining_seconds)}</p>
    {!mature && <p className={styles.note}>一次照料覆盖 24 小时，累计约 72 小时有效成长后长成；多点几次不会加速。</p>}
    <div className={styles.actions}>
      {onCare && !item.stored && <button type="button" className="button" disabled={disabled || mature || item.growth_status !== 'needs_care'} onClick={onCare}><HandHeart size={17} />照料</button>}
      {onRefresh && <button type="button" className="button ghost" disabled={refreshing} onClick={onRefresh}><RefreshCw size={16} />更新成长状态</button>}
    </div>
    <small className={styles.note}>核对于 {stamp}（上海时间）；进度以这次读取为准。</small>
  </section>;
}
