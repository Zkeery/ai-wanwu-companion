import React from 'react';
import * as THREE from 'three';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import SharedLivingWorld3D from '@/components/shared-living-world-3d';
import { parseGathering } from '@/lib/gatherings';

const gpu = vi.hoisted(() => ({ scene: null as THREE.Scene | null }));
// The UI, engine, furniture and door callbacks are real; only WebGL and texture loading are offline.
vi.mock('three', async original => {
  const actual = await original<typeof import('three')>();
  class OfflineRenderer {
    domElement = document.createElement('canvas'); shadowMap = { enabled: false, type: 0 };
    outputColorSpace = ''; toneMapping = 0; toneMappingExposure = 1;
    setPixelRatio = vi.fn(); setSize = vi.fn(); setClearColor = vi.fn(); setAnimationLoop = vi.fn();
    render = vi.fn((scene: THREE.Scene, camera: THREE.Camera) => { scene.updateMatrixWorld(true); camera.updateMatrixWorld(true); gpu.scene = scene; });
    dispose = vi.fn(); forceContextLoss = vi.fn();
  }
  return { ...actual, WebGLRenderer: OfflineRenderer };
});
function gathering(id = 'synthetic-daily-ui') {
  return parseGathering({ id, title: '本地小院', scene_type: 'home', revision: 1, closed: false, is_manager: true, me: 'owner',
    members: [{ id: 'owner', name: '合成成员', manager: true }], companions: [{ id: 4, name: '沙发伙伴', owner_id: 'owner',
      activity: 'rest', area: 'indoor', x: .5, y: .5,
      avatar3d: { version: 1, kind: 'cup', body: '#6da385', accent: '#f3dfbb', detail: '#364d44', seed: 4, source: 'procedural_existing_features' } }],
    items: [], votes: [], events: [], stories: [], goal: null, story_enabled: false, season: { current_season: 'summer' } });
}
beforeEach(() => {
  gpu.scene = null;
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
  vi.stubGlobal('fetch', vi.fn(() => { throw new Error('daily UI must stay offline'); }));
  vi.spyOn(THREE.TextureLoader.prototype, 'load').mockImplementation(() => new THREE.Texture<HTMLImageElement>());
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(800);
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(500);
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('daily local farmhouse entry with the real engine', () => {
  it('starts with a complete exterior, enters by opening the front door, then closes it when returning to the yard', async () => {
    const group = gathering(), before = JSON.stringify(group), onFocusView = vi.fn(), onActivity = vi.fn();
    render(<SharedLivingWorld3D gathering={group} focusedId={null} onSelect={vi.fn()} animate={false}
      visualStyle="realistic" localLeisurePreview onFocusView={onFocusView} onActivity={onActivity} />);
    await act(async () => {});
    const host = screen.getByTestId('living3d-canvas');
    const roof = gpu.scene!.getObjectByName('home-common-gabled-roof')!;
    expect(host.dataset.houseView).toBe('exterior'); expect(host.dataset.mainDoorOpen).toBe('false');
    expect(roof.visible).toBe(true);
    expect(screen.queryByRole('button', { name: '看室内' })).toBeNull(); expect(screen.queryByRole('button', { name: '看外观' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /^院子/ }));
    expect(screen.getByRole('button', { name: /^院子/ })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: '看全景' })).toHaveAttribute('aria-pressed', 'false');
    expect(host.dataset.focusView).toBe('outdoor'); expect(host.dataset.houseView).toBe('exterior'); expect(roof.visible).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: '打开入户门' }));
    expect(host.dataset.houseView).toBe('interior'); expect(host.dataset.mainDoorOpen).toBe('true');
    expect(onFocusView).toHaveBeenCalledWith('indoor');
    fireEvent.click(screen.getByRole('button', { name: '回到院子' }));
    expect(host.dataset.houseView).toBe('exterior'); expect(host.dataset.mainDoorOpen).toBe('false');
    expect(roof.visible).toBe(true);
    expect(screen.getByRole('button', { name: '打开入户门' })).toHaveTextContent('开门进屋');
    expect(onFocusView).toHaveBeenLastCalledWith('overview');
    expect(JSON.stringify(group)).toBe(before); expect(onActivity).not.toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled();
  });

  it('does not reveal the interior merely because an indoor actor becomes focused before the door is opened', async () => {
    const group = gathering(), select = vi.fn();
    const page = render(<SharedLivingWorld3D gathering={group} focusedId={null} onSelect={select} animate={false} visualStyle="realistic" localLeisurePreview />);
    await act(async () => {});
    page.rerender(<SharedLivingWorld3D gathering={group} focusedId={4} onSelect={select} animate={false} visualStyle="realistic" localLeisurePreview />);
    expect(screen.getByTestId('living3d-canvas').dataset.houseView).toBe('exterior');
    expect(screen.queryByRole('button', { name: '回到院子' })).toBeNull(); expect(fetch).not.toHaveBeenCalled();
  });

  it.each([
    { id: 'production-home', style: 'classic' as const, optIn: false },
    { id: 'production-home', style: 'realistic' as const, optIn: true },
    { id: 'synthetic-daily-ui', style: 'realistic' as const, optIn: false },
    { id: 'synthetic-daily-ui', style: 'classic' as const, optIn: true },
  ])('keeps the existing house-view controls when leisure guard is false: $id/$style/$optIn', async ({ id, style, optIn }) => {
    render(<SharedLivingWorld3D gathering={gathering(id)} focusedId={null} onSelect={vi.fn()} animate={false} visualStyle={style} localLeisurePreview={optIn} />);
    await act(async () => {});
    expect(screen.getByRole('button', { name: '看室内' })).toBeInTheDocument(); expect(screen.getByRole('button', { name: '看外观' })).toBeInTheDocument();
    expect(screen.getByTestId('living3d-canvas').dataset.houseView).toBe('interior');
    expect(screen.queryByRole('button', { name: '回到院子' })).toBeNull(); expect(fetch).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: '看外观' }));
    fireEvent.click(screen.getByRole('button', { name: /^院子/ }));
    expect(screen.getByTestId('living3d-canvas').dataset.focusView).toBe('overview');
    expect(gpu.scene!.getObjectByName('home-common-gabled-roof')!.visible).toBe(true);
  });
});
