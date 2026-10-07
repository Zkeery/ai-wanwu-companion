'use client';
import { useState } from 'react';
import Link from 'next/link';
import { imageUrl, type Character, type LivingSpace } from '@/lib/contracts';
import type { RuntimeView } from '@/lib/life-runtime';
import { useCurrentActivity } from '@/lib/use-current-activity';
import { Modal } from './common';
import PrivateImage from './private-image';
import CompanionMotionPreview from './companion-motion-preview';
import SceneWalkPreview from './scene-walk-preview';

export default function SceneCompanions({ companions, space, view, editing = false }: { companions: Character[]; space?: LivingSpace; view?: RuntimeView | null; editing?: boolean }) {
  const [selected, setSelected] = useState<number | null>(null);
  const person = companions.find(item => item.id === selected);
  const resident = space?.mode === 'private' ? companions.find(item => String(item.id) === space.companion_id) : undefined;
  const src = person && imageUrl(person.image_path);
  const candidate = view?.snapshot;
  const snapshot = candidate && !view?.stale && candidate.space_id === space?.id && candidate.permission.enabled && candidate.present
    ? candidate : null;
  const active = useCurrentActivity(candidate);
  const current = snapshot && snapshot.companion_id === space?.companion_id && active &&
    (active.activity !== 'observe' || space?.items.some(item => item.id === active.target_id && !item.stored)) ? active : null;
  const activity = person && snapshot?.companion_id === String(person.id) && current &&
    (current.activity !== 'observe' || space?.items.some(item => item.id === current.target_id && !item.stored))
    ? current.activity : undefined;
  return <>
    <div className="scene-companions" aria-label="此刻在场的伙伴" onClick={event => event.stopPropagation()}>
      {companions.map(item => <div className="scene-companion-entry" key={item.id}>
        <Link className="scene-companion" href={`/companions/${item.id}?tab=chat`} aria-label={`和${item.name}说话`}>
          {imageUrl(item.image_path) && <PrivateImage src={imageUrl(item.image_path)!} alt="" retryable={false} />}
          <span>{item.name}在这里</span>
        </Link>
        {imageUrl(item.image_path) && <button type="button" className="scene-motion-button"
          aria-label={`看看${item.name}的动作`} onClick={() => setSelected(item.id)}>看看动作</button>}
      </div>)}
    </div>
    {resident && space && imageUrl(resident.image_path) &&
      <SceneWalkPreview id={resident.id} src={imageUrl(resident.image_path)!} name={resident.name} spaceId={space.id}
        disabled={editing || selected !== null || !!view?.stale || !!current} />}
    {person && src && <Modal title={`${person.name}的动作`} close={() => setSelected(null)}>
      <div onClick={event => event.stopPropagation()}>
        <p className="scene-motion-note">这里看看伙伴的动作，不会改变生活中的活动或场景布置。</p>
        <CompanionMotionPreview id={person.id} src={src} name={person.name} activity={activity} />
      </div>
    </Modal>}
  </>;
}
