export type LivingLabelAnchor = Readonly<{ id: number; x: number; y: number; width: number; height: number }>;
export type LivingLabelPosition = Readonly<{ id: number; x: number; y: number }>;

/** Keep the full click targets apart without moving or hiding their characters. */
export function layoutLivingLabels(labels: readonly LivingLabelAnchor[], width: number, height: number): LivingLabelPosition[] {
  const gap = 6, inset = 8;
  const placed: { id: number; x: number; y: number; width: number; height: number }[] = [];
  for (const label of [...labels].sort((a, b) => a.id - b.id)) {
    const maxX = Math.max(inset, width - inset - label.width), maxY = Math.max(inset, height - inset - label.height);
    const clampX = (x: number) => Math.max(inset, Math.min(maxX, x));
    const clampY = (y: number) => Math.max(inset, Math.min(maxY, y));
    const origin = { x: clampX(label.x - label.width / 2), y: clampY(label.y - label.height) };
    const xs = new Set([origin.x, inset, maxX]), ys = new Set([origin.y, inset, maxY]);
    for (const p of placed) {
      xs.add(clampX(p.x - label.width - gap)); xs.add(clampX(p.x + p.width + gap));
      ys.add(clampY(p.y - label.height - gap)); ys.add(clampY(p.y + p.height + gap));
    }
    let best = origin, bestScore = Infinity;
    for (const x of xs) for (const y of ys) {
      const overlaps = placed.reduce((sum, p) => sum + Math.max(0, Math.min(x + label.width + gap, p.x + p.width + gap) - Math.max(x, p.x)) * Math.max(0, Math.min(y + label.height + gap, p.y + p.height + gap) - Math.max(y, p.y)), 0);
      const score = overlaps * 1e6 + (x - origin.x) ** 2 + (y - origin.y) ** 2;
      if (score < bestScore) { best = { x, y }; bestScore = score; }
    }
    placed.push({ ...label, ...best });
  }
  return placed.map(p => ({ id: p.id, x: p.x + p.width / 2, y: p.y + p.height }));
}
