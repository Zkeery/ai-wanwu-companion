'use client';
import { CloudRain, Sprout, Undo2, Volume2, VolumeX, Flower2, TreePine, Waves, Armchair, Flame, Sparkles, Maximize2 } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { actionNames, type Scene, type SceneAction } from '@/lib/contracts';
import { RainAudio } from '@/lib/rain-audio';
import { TREE_LIMIT } from '@/lib/input-limits';
import { errorText } from '@/lib/api';
import GardenWorld from './garden-world';
import { Modal } from './common';

const groups = [
  { name: '植物', tools: [['plant_tree', TreePine], ['plant_flower', Flower2], ['grow_mushroom', Sprout]] },
  { name: '景观', tools: [['add_pond', Waves], ['place_bench', Armchair]] },
  { name: '氛围', tools: [['light_campfire', Flame], ['release_fireflies', Sparkles], ['light_rain', CloudRain], ['quiet', VolumeX]] },
] as const;

export default function Garden({ scene, busy, act, undo }: { scene: Scene; busy: boolean; act: (action: SceneAction) => void; undo: () => void }) {
  const audio = useRef<RainAudio | null>(null), alive = useRef(false);
  const [enabled, setEnabled] = useState(false), [audioError, setAudioError] = useState('');
  const [category, setCategory] = useState(0), [expanded, setExpanded] = useState(false);
  const playing = enabled && scene.elements.rain > 0 && scene.elements.sound > 0;
  useEffect(() => { alive.current = true; const engine = new RainAudio(); audio.current = engine; return () => { alive.current = false; engine.close(); audio.current = null; }; }, []);
  useEffect(() => { audio.current?.volume(playing); }, [playing]);
  async function toggle() { if (enabled) { audio.current?.volume(false); setEnabled(false); return; } try { await audio.current?.enable(); if (alive.current) { setAudioError(''); setEnabled(true); } } catch (e) { if (alive.current) setAudioError(errorText(e)); } }
  function unavailable(action: SceneAction) {
    const limits: Partial<Record<SceneAction, [number, number]>> = { plant_tree: [scene.elements.tree, TREE_LIMIT], plant_flower: [scene.elements.flower ?? 0, 6], grow_mushroom: [scene.elements.mushroom ?? 0, 4], add_pond: [scene.elements.pond ?? 0, 1], place_bench: [scene.elements.bench ?? 0, 1], light_campfire: [scene.elements.campfire ?? 0, 1], release_fireflies: [scene.elements.fireflies ?? 0, 1] };
    const limit = limits[action]; return !!limit && limit[0] >= limit[1];
  }
  const visibleGroups = groups.map(group => ({ ...group, tools: group.tools.filter(([action]) => !scene.available_actions || scene.available_actions.includes(action)) })).filter(group => group.tools.length);
  const selectedCategory = Math.min(category, Math.max(0, visibleGroups.length - 1));
  const controls = <div className="garden-controls"><p className="garden-tree-count">{scene.elements.tree > TREE_LIMIT ? `已保存 ${scene.elements.tree} 棵，画面展示 ${TREE_LIMIT} 棵` : `树木 ${scene.elements.tree}/${TREE_LIMIT}`}</p><div className="garden-categories" role="group" aria-label="花园工具分类">{visibleGroups.map((group, i) => <button key={group.name} aria-pressed={selectedCategory === i} onClick={() => setCategory(i)}>{group.name}</button>)}</div><div className="garden-actions">{visibleGroups[selectedCategory]?.tools.map(([action, Icon]) => <button key={action} disabled={busy || unavailable(action)} onClick={() => act(action)}><Icon size={19} /><span>{actionNames[action]}{unavailable(action) && <small>{action === 'plant_tree' ? '已达上限' : '已布置'}</small>}</span></button>)}</div><div className="garden-feedback" role="status">{scene.feedback || '种点花，添张长椅，把喜欢的小物放进来。'}</div><div className="garden-bottom"><button onClick={toggle} className="text-button">{playing ? <Volume2 size={15} /> : <VolumeX size={15} />}{playing ? '雨声播放中' : enabled ? '声音已开启 · 当前安静' : '开启声音'}</button><button className="text-button" disabled={busy || !scene.can_undo} onClick={undo}><Undo2 size={15} />撤销</button></div>{audioError && <p role="alert" className="error-text">{audioError}</p>}</div>;
  return <><section className="garden-panel" aria-label="小花园"><div className="garden-heading"><span><Sprout size={17} />我们的小花园</span><button className="icon-button" aria-label="放大小花园" onClick={() => setExpanded(true)}><Maximize2 size={16} /></button></div><GardenWorld elements={scene.elements} />{!expanded && controls}</section>{expanded && <Modal title="我们的小花园" close={() => setExpanded(false)}><div className="expanded-garden"><GardenWorld elements={scene.elements} />{controls}</div></Modal>}</>;
}
