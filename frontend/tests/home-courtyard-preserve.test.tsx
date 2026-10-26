import React from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as Three from 'three';
import SharedLivingWorld3D from '@/components/shared-living-world-3d';
import { parseGathering, type Gathering } from '@/lib/gatherings';
import { createLivingWorld, courtyardFootprint, courtyardGroundPoint, fitCourtyardCamera } from '@/lib/living-world-engine';

type EngineStub = {
  update: ReturnType<typeof vi.fn>; setMotion: ReturnType<typeof vi.fn>;
  rotate: ReturnType<typeof vi.fn>; zoom: ReturnType<typeof vi.fn>;
  setReplay: ReturnType<typeof vi.fn>; reset: ReturnType<typeof vi.fn>; dispose: ReturnType<typeof vi.fn>;
  select: (id: number) => void;
};
const gpuBoundary = vi.hoisted(() => ({ instances: [] as EngineStub[] }));

// Keep the real artwork component and coordinate projection. Only replace the
// browser GPU boundary; the separate resource suite constructs real meshes.
vi.mock('@/lib/living-world-engine', async original => {
  const actual = await original<typeof import('@/lib/living-world-engine')>();
  return { ...actual, createLivingWorld: vi.fn((host: HTMLElement, _labels: HTMLElement, _g: Gathering, select: (id: number) => void) => {
    const canvas = document.createElement('canvas'); host.append(canvas);
    const engine: EngineStub = { setReplay: vi.fn(), update: vi.fn(), setMotion: vi.fn(), rotate: vi.fn(), zoom: vi.fn(), reset: vi.fn(), dispose: vi.fn(() => canvas.remove()), select };
    gpuBoundary.instances.push(engine); return engine;
  }) };
});

function snapshot(scene = 'home', season: string | null = null): Gathering {
  return parseGathering({ id: 'courtyard-preserve', title: '原来的家庭庭院', scene_type: scene, revision: 7, closed: false,
    is_manager: true, me: 'owner', invitation: null,
    members: [{ id: 'owner', name: '我', manager: true }, { id: 'friend', name: '朋友', manager: false }],
    companions: [
      { id: 4, name: '杯子伙伴', owner_id: 'owner', activity: 'walk', x: .32, y: .58,
        avatar3d: { version: 1, kind: 'cup', body: '#6da385', accent: '#f3dfbb', detail: '#364d44', seed: 4, source: 'procedural_existing_features' } },
      { id: 5, name: '花束伙伴', owner_id: 'friend', activity: 'rest', x: .71, y: .48,
        avatar3d: { version: 1, kind: 'bouquet', body: '#b190ca', accent: '#f1d7ef', detail: '#605060', seed: 5, source: 'procedural_existing_features' } },
    ],
    items: [
      { id: 'saved-tree', kind: 'tree', x: .25, y: .4, mine: true, contributor_name: '我', growth_status: 'growing' },
      { id: 'saved-bench', kind: 'bench', x: .8, y: .6, mine: false, contributor_name: '朋友', growth_status: null },
    ],
    votes: [], events: [], stories: [], goal: null, story_enabled: false, season: { current_season: season } });
}

beforeEach(() => {
  vi.clearAllMocks(); gpuBoundary.instances.length = 0;
  vi.stubEnv('NEXT_PUBLIC_BASE_PATH', '/partner');
  vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new Error('unexpected network request'))));
});
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

describe('rotatable home rooms preserve saved data', () => {
  it.each([null,'spring','summer','autumn','winter'])('passes saved %s scenery, furniture and companions to the real 3D renderer without a duplicate flat overlay', season => {
    const g=snapshot('home',season),before=JSON.stringify(g);const view=render(<SharedLivingWorld3D gathering={g} focusedId={null} onSelect={vi.fn()} animate />);
    expect(screen.getByLabelText('共同生活场景')).toHaveAttribute('data-season',season??'base');
    expect(view.container.querySelector('[data-presentation="home-world"]')).not.toBeNull();
    expect(view.container.querySelector('[data-focus-view="overview"]')).not.toBeNull();
    expect(view.container.querySelector('img')).toBeNull();expect(screen.queryByLabelText('已保存的庭院布置')).toBeNull();
    expect(createLivingWorld).toHaveBeenCalledWith(screen.getByTestId('living3d-canvas'),expect.any(HTMLElement),g,expect.any(Function),expect.any(Function));
    expect(g.items.map(i=>[i.id,i.x,i.y,i.mine])).toEqual([['saved-tree',.25,.4,true],['saved-bench',.8,.6,false]]);
    expect(JSON.stringify(g)).toBe(before);expect(fetch).not.toHaveBeenCalled();view.unmount();expect(gpuBoundary.instances[0].dispose).toHaveBeenCalledOnce();
  });
  it('keeps selection, pause and camera controls visible and never writes saved coordinates',()=>{
    const g=snapshot(),before=JSON.stringify(g),choose=vi.fn();render(<SharedLivingWorld3D gathering={g} focusedId={4} onSelect={choose} animate />);
    const e=gpuBoundary.instances[0];fireEvent.click(screen.getByRole('button',{name:'查看花束伙伴的生活近况'}));expect(choose).toHaveBeenCalledWith(5);act(()=>e.select(4));expect(choose).toHaveBeenLastCalledWith(4);
    for(const name of ['向左看','向右看'])fireEvent.click(screen.getByRole('button',{name}));expect(e.rotate).toHaveBeenCalledTimes(2);
    for(const name of ['拉近','拉远'])fireEvent.click(screen.getByRole('button',{name}));expect(e.zoom).toHaveBeenCalledTimes(2);
    fireEvent.click(screen.getByRole('button',{name:'恢复视角'}));expect(e.reset).toHaveBeenCalledOnce();fireEvent.click(screen.getByRole('button',{name:'暂停画面'}));expect(e.setMotion).toHaveBeenLastCalledWith(false);
    expect(screen.getByText('画面已保持静态，仍可点选伙伴查看近况。')).toBeVisible();expect(JSON.stringify(g)).toBe(before);expect(fetch).not.toHaveBeenCalled();
  });
  it('updates the saved season without losing selection or recreating the world',()=>{
    const g=snapshot('home','autumn'),view=render(<SharedLivingWorld3D gathering={g} focusedId={4} onSelect={vi.fn()} animate />),next={...g,revision:8,season:'winter'};
    view.rerender(<SharedLivingWorld3D gathering={next} focusedId={4} onSelect={vi.fn()} animate />);
    expect(screen.getByLabelText('共同生活场景')).toHaveAttribute('data-season','winter');expect(createLivingWorld).toHaveBeenCalledOnce();expect(gpuBoundary.instances[0].update).toHaveBeenLastCalledWith(next,4);
    expect(screen.getByRole('button',{name:'查看杯子伙伴的生活近况'})).toHaveAttribute('aria-pressed','true');expect(next.items).toEqual(g.items);expect(next.companions).toEqual(g.companions);expect(fetch).not.toHaveBeenCalled();
  });
  it('recovers from a WebGL failure with the same saved state and keeps companion selection usable',()=>{
    const g=snapshot(),before=JSON.stringify(g),choose=vi.fn();render(<SharedLivingWorld3D gathering={g} focusedId={null} onSelect={choose} animate />);
    act(()=>screen.getByTestId('living3d-canvas').dispatchEvent(new CustomEvent('living3d-lost')));expect(screen.getByRole('status')).toHaveTextContent('立体画面暂时无法显示');
    fireEvent.click(screen.getByRole('button',{name:'查看杯子伙伴的生活近况'}));expect(choose).toHaveBeenCalledWith(4);fireEvent.click(screen.getByRole('button',{name:'重新打开立体画面'}));
    expect(createLivingWorld).toHaveBeenCalledTimes(2);expect(gpuBoundary.instances[0].dispose).toHaveBeenCalledOnce();expect(JSON.stringify(g)).toBe(before);expect(fetch).not.toHaveBeenCalled();
  });
  it('retains the ordinary forest renderer and its controls',()=>{
    const g=snapshot('forest','spring'),view=render(<SharedLivingWorld3D gathering={g} focusedId={4} onSelect={vi.fn()} animate />);
    expect(view.container.querySelector('[data-presentation="world-3d"]')).not.toBeNull();expect(view.container.querySelector('img')).toBeNull();for(const name of ['向左看','向右看','拉近','拉远','恢复视角'])expect(screen.getByRole('button',{name})).toBeEnabled();expect(gpuBoundary.instances[0].update).toHaveBeenLastCalledWith(g,4);expect(fetch).not.toHaveBeenCalled();
  });
  it('focuses the yard, living room and bedroom within one full home without filtering companions, copying furniture or writing history',()=>{
    const g=snapshot('home','winter'),before=JSON.stringify(g),v=render(<SharedLivingWorld3D gathering={g} focusedId={4} onSelect={vi.fn()} animate />),e=gpuBoundary.instances[0];
    for(const area of ['outdoor','indoor','bedroom','overview'] as const){
      v.rerender(<SharedLivingWorld3D gathering={g} focusedId={4} onSelect={vi.fn()} animate view={area} />);
      expect(v.container.querySelector('[data-presentation="home-world"]')).not.toBeNull();expect(v.container.querySelector(`[data-focus-view="${area}"]`)).not.toBeNull();
      expect(e.update).toHaveBeenLastCalledWith(g,4,area);expect(e.update.mock.lastCall?.[0].items).toBe(g.items);expect(e.update.mock.lastCall?.[0].companions).toBe(g.companions);
    }
    expect(createLivingWorld).toHaveBeenCalledOnce();expect(JSON.stringify(g)).toBe(before);expect(fetch).not.toHaveBeenCalled();
  });
});

describe('courtyard character ground projection', () => {
  it.each([[1200, 510], [390, 400], [800, 800]])('reprojects volume feet onto the saved artwork at %s by %s without changing records', (width, height) => {
    const g = snapshot(), before = JSON.stringify(g), camera = new Three.OrthographicCamera();
    fitCourtyardCamera(camera, width, height);
    for (const c of g.companions) {
      const footprint = courtyardFootprint(g, c.id, width, height);
      expect(footprint).not.toBeNull();
      expect(footprint!.left).toBeGreaterThanOrEqual(0); expect(footprint!.left).toBeLessThanOrEqual(1);
      expect(footprint!.top).toBeGreaterThanOrEqual(0); expect(footprint!.top).toBeLessThanOrEqual(1);
      const ground = courtyardGroundPoint(footprint!, camera);
      expect(ground).not.toBeNull(); expect(ground!.y).toBeCloseTo(0);
      const screenPoint = ground!.clone().project(camera);
      expect(screenPoint.x).toBeCloseTo(footprint!.ndcX, 6);
      expect(screenPoint.y).toBeCloseTo(footprint!.ndcY, 6);
    }
    expect(JSON.stringify(g)).toBe(before);
  });

  it('keeps missing companions absent and clamps legacy off-scene positions without editing them', () => {
    const g = snapshot(); g.companions[0].x = -8; g.companions[0].y = 20;
    const before = JSON.stringify(g);
    const footprint = courtyardFootprint(g, 4, 390, 400);
    expect(footprint).not.toBeNull();
    expect([footprint!.left, footprint!.top, footprint!.ndcX, footprint!.ndcY].every(Number.isFinite)).toBe(true);
    expect(footprint!.left).toBeGreaterThanOrEqual(0); expect(footprint!.left).toBeLessThanOrEqual(1);
    expect(footprint!.top).toBeGreaterThanOrEqual(0); expect(footprint!.top).toBeLessThanOrEqual(1);
    expect(courtyardFootprint(g, 999, 390, 400)).toBeNull();
    expect(JSON.stringify(g)).toBe(before);
  });
});
