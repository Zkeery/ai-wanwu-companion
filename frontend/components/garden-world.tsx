'use client';
import { useId } from 'react';
import type { Scene } from '@/lib/contracts';
import { TREE_LIMIT } from '@/lib/input-limits';

export default function GardenWorld({ elements: e }: { elements: Scene['elements'] }) {
  const id = useId().replace(/:/g, '');
  const decorations = [e.flower && `${e.flower}簇花`, e.mushroom && `${e.mushroom}丛蘑菇`, e.pond && '水池', e.bench && '长椅', e.campfire && '营火', e.fireflies && '萤火虫'].filter(Boolean);
  return <div className={`toy-world ${e.rain ? 'is-raining' : ''}`}>
    <svg viewBox="0 0 600 360" role="img" aria-label={`小花园：${e.rain ? '下着小雨' : '晴天'}，${e.tree}棵树${e.tree > TREE_LIMIT ? `（画面展示${TREE_LIMIT}棵）` : ''}${decorations.length ? '，' + decorations.join('、') : ''}`}>
      <defs>
        <linearGradient id={`${id}-sky`} x2="0" y2="1"><stop stopColor={e.rain ? '#adcbdf' : '#b6eff0'} /><stop offset="1" stopColor="#fff4c6" /></linearGradient>
        <linearGradient id={`${id}-island`} x2="0" y2="1"><stop stopColor="#a6dc80" /><stop offset="1" stopColor="#58ba99" /></linearGradient>
        <radialGradient id={`${id}-glow`}><stop stopColor="#ffe895" stopOpacity=".8" /><stop offset="1" stopColor="#ffe895" stopOpacity="0" /></radialGradient>
      </defs>
      <rect width="600" height="360" rx="26" fill={`url(#${id}-sky)`} />
      <circle cx="493" cy="66" r="31" fill="#ffd868" className="world-sun" />
      <g fill="#fffdf3" opacity=".9" className="world-cloud"><ellipse cx="100" cy="69" rx="47" ry="14" /><circle cx="84" cy="56" r="17" /><circle cx="113" cy="53" r="24" /></g>
      <g fill="#fffdf3" opacity=".7"><ellipse cx="367" cy="43" rx="37" ry="10" /><circle cx="356" cy="34" r="15" /><circle cx="377" cy="34" r="17" /></g>
      <ellipse cx="300" cy="317" rx="215" ry="17" fill="#377f77" opacity=".12" />
      <path d="M62 215 Q62 165 300 165 Q538 165 538 215 L517 273 Q494 316 300 320 Q108 316 83 273Z" fill="#6aac87" />
      <ellipse cx="300" cy="215" rx="238" ry="76" fill={`url(#${id}-island)`} />
      <path d="M276 153 Q230 190 305 224 Q333 252 309 290" fill="none" stroke="#fff2bd" strokeWidth="28" strokeLinecap="round" />
      <g stroke="#63a57b" strokeWidth="3" strokeLinecap="round" fill="none"><path d="M116 223l-6-10m6 10l6-13M460 231l-6-10m6 10l6-13M355 163l-4-8m4 8l5-9M177 258l-4-7m4 7l5-8" /></g>
      {Array.from({ length: Math.min(e.tree, TREE_LIMIT) }, (_, i) => <g key={`tree-${i}`} transform={`translate(${120 + i * 57} ${170 + (i % 2) * 13}) scale(${.75 + (i % 3) * .08})`} className="world-object"><ellipse cy="8" rx="24" ry="8" fill="#41876b" opacity=".18" /><path d="M0 0v-46" stroke="#956848" strokeWidth="10" strokeLinecap="round" /><g fill={i % 2 ? '#43b699' : '#64c87d'} stroke="#399d78" strokeWidth="2"><circle cy="-67" r="28" /><circle cx="-17" cy="-47" r="21" /><circle cx="17" cy="-48" r="22" /></g><path d="M-9-76q6-10 18-7" stroke="#b6ef97" fill="none" strokeWidth="6" strokeLinecap="round" /></g>)}
      {!!e.pond && <g className="world-object"><ellipse cx="180" cy="241" rx="57" ry="29" fill="#ecf6ba" /><ellipse cx="180" cy="238" rx="51" ry="24" fill="#56c8d2" /><ellipse cx="180" cy="237" rx="33" ry="12" fill="none" stroke="#bdf7ed" strokeWidth="3" className="water-ripple" /><ellipse cx="159" cy="230" rx="12" ry="6" fill="#a3dc76" /><circle cx="166" cy="228" r="4" fill="#ff8ba5" /><path d="M210 253q10-9 20-5" fill="none" stroke="#79b783" strokeWidth="5" /></g>}
      {!!e.bench && <g transform="translate(371 215)" className="world-object"><ellipse cx="30" cy="32" rx="48" ry="10" fill="#397861" opacity=".15" /><path d="M-7 5v24m77-24v24" stroke="#59687b" strokeWidth="6" strokeLinecap="round" /><rect x="-13" y="-20" width="91" height="13" rx="5" fill="#ffbf79" /><rect x="-13" y="-4" width="91" height="12" rx="5" fill="#eb985e" /><path d="M-13 12h91" stroke="#ffd398" strokeWidth="10" strokeLinecap="round" /><path d="M-6-13v30m78-30v30" stroke="#59687b" strokeWidth="4" /></g>}
      {Array.from({ length: Math.min(e.flower ?? 0, 6) }, (_, i) => <g key={`flower-${i}`} transform={`translate(${100 + i * 32} ${215 + (i % 2) * 62})`} className="world-flower"><path d="M0 0v-17m0 12q-13-2-12-10m12 7q11-4 12-11" fill="none" stroke="#368d6e" strokeWidth="3" /><g transform="translate(0 -24)" fill={['#ff729e', '#ffb34b', '#be9bea'][i % 3]}>{[0, 60, 120, 180, 240, 300].map(a => <ellipse key={a} cy="-7" rx="4" ry="7" transform={`rotate(${a})`} />)}<circle r="4" fill="#fff5ab" /></g></g>)}
      {Array.from({ length: Math.min(e.mushroom ?? 0, 4) }, (_, i) => <g key={`mushroom-${i}`} transform={`translate(${370 + i * 26} ${270 + (i % 2) * 10})`} className="world-object"><rect x="-4" y="-6" width="8" height="15" rx="4" fill="#fff6df" /><path d="M-14-4Q-13-29 0-26Q13-29 14-4Z" fill={i % 2 ? '#ffb64e' : '#ee7d8e'} /><g fill="#fff9e6"><circle cx="-6" cy="-12" r="2" /><circle cx="3" cy="-20" r="2.5" /><circle cx="8" cy="-9" r="2" /></g></g>)}
      {!!e.campfire && <g transform="translate(315 248)" className="world-object"><circle r="53" fill={`url(#${id}-glow)`} /><path d="M-17 11l35-8m-35 0l35 8" stroke="#865a46" strokeWidth="7" strokeLinecap="round" /><path d="M-15 0Q-21-14-3-31Q-5-18 4-21Q8-30 7-34Q30-4 12 7Q-3 17-15 0" fill="#ff8b43" className="world-flame" /><path d="M-5 4Q-13-4 1-16Q2-7 8-4Q13 8 1 10Z" fill="#ffdd78" /></g>}
      {!!e.fireflies && <g className="world-fireflies">{[[93, 120], [234, 108], [337, 81], [455, 137], [507, 203], [287, 169], [157, 291], [404, 300]].map(([x, y], i) => <g key={i} style={{ animationDelay: `${i * -.43}s` }}><circle cx={x} cy={y} r="16" fill={`url(#${id}-glow)`} /><circle cx={x} cy={y} r="3" fill="#fff7ac" stroke="#d7b957" /></g>)}</g>}
      {!!e.rain && <g className="world-rain" stroke="#fff" strokeWidth="2.5" strokeLinecap="round" opacity=".65">{Array.from({ length: 25 }, (_, i) => <path key={i} d={`M${50 + i * 21} ${38 + i % 5 * 24}l-7 17`} />)}</g>}
    </svg>
    <span className="world-badge">MY LITTLE WORLD <i /> 已保存的花园</span>
  </div>;
}
