import type { Hex } from './types';

export const SQRT3 = Math.sqrt(3);

/** The six neighbour directions, in a fixed order. */
export const DIRS: readonly Hex[] = [
  { q: 1, r: 0 },
  { q: 1, r: -1 },
  { q: 0, r: -1 },
  { q: -1, r: 0 },
  { q: -1, r: 1 },
  { q: 0, r: 1 },
];

export const key = (h: Hex): string => `${h.q},${h.r}`;
export const eq = (a: Hex, b: Hex): boolean => a.q === b.q && a.r === b.r;

export function neighbors(h: Hex): Hex[] {
  return DIRS.map((d) => ({ q: h.q + d.q, r: h.r + d.r }));
}

export function distance(a: Hex, b: Hex): number {
  const dq = a.q - b.q;
  const dr = a.r - b.r;
  return (Math.abs(dq) + Math.abs(dr) + Math.abs(dq + dr)) / 2;
}

/** Convert "odd-r" offset (col,row) – a rectangular map layout – to axial. */
export function fromOffset(col: number, row: number): Hex {
  return { q: col - (row >> 1), r: row };
}

export function toOffsetCol(h: Hex): number {
  return h.q + (h.r >> 1);
}

/** Unit vectors towards the edge midpoints of a size-1 hex: one per pair of opposite edges. */
const EDGE_NORMALS = DIRS.slice(0, 3).map((d) => {
  const p = toPixel(d, 1);
  const len = Math.hypot(p.x, p.y);
  return { x: p.x / len, y: p.y / len };
});
const CORNERS = [0, 1, 2, 3, 4, 5].map((i) => {
  const a = (Math.PI / 180) * (60 * i - 30);
  return { x: Math.cos(a), y: Math.sin(a) };
});
const INRADIUS = SQRT3 / 2;

/** Whether a segment passes through the interior of the size-1 hex centred on `c` (touching its edge doesn't count). */
function segmentCrossesHex(c: { x: number; y: number }, p0: { x: number; y: number }, p1: { x: number; y: number }): boolean {
  const eps = 1e-9;
  const dot = (p: { x: number; y: number }, n: { x: number; y: number }) => p.x * n.x + p.y * n.y;
  for (const n of EDGE_NORMALS) {
    const hc = dot(c, n);
    const a = dot(p0, n);
    const b = dot(p1, n);
    if (Math.max(a, b) <= hc - INRADIUS + eps || Math.min(a, b) >= hc + INRADIUS - eps) return false;
  }
  const len = Math.hypot(p1.x - p0.x, p1.y - p0.y);
  const m = { x: -(p1.y - p0.y) / len, y: (p1.x - p0.x) / len };
  const extent = Math.max(...CORNERS.map((k) => Math.abs(dot(k, m))));
  const side = dot(p0, m) - dot(c, m);
  return side > -extent + eps && side < extent - eps;
}

/**
 * Every hex (on or off any map) whose interior the straight line from the centre of `a` to the
 * centre of `b` passes through, after shifting the line sideways by `offset` (in hex sizes).
 * A tiny positive or negative offset tells apart the two sides of a line running along hex edges.
 */
export function hexesOnLine(a: Hex, b: Hex, offset = 0): Hex[] {
  const pa = toPixel(a, 1);
  const pb = toPixel(b, 1);
  const len = Math.hypot(pb.x - pa.x, pb.y - pa.y);
  if (len === 0) return [a];
  const shift = { x: (-(pb.y - pa.y) / len) * offset, y: ((pb.x - pa.x) / len) * offset };
  const p0 = { x: pa.x + shift.x, y: pa.y + shift.y };
  const p1 = { x: pb.x + shift.x, y: pb.y + shift.y };
  const n = distance(a, b);
  const result: Hex[] = [];
  for (let dq = -n - 1; dq <= n + 1; dq++) {
    for (let dr = -n - 1; dr <= n + 1; dr++) {
      const h = { q: a.q + dq, r: a.r + dr };
      if (distance(a, h) + distance(h, b) > n + 1) continue;
      if (segmentCrossesHex(toPixel(h, 1), p0, p1)) result.push(h);
    }
  }
  return result;
}

/** Pixel centre of a hex (pointy-top). */
export function toPixel(h: Hex, size: number): { x: number; y: number } {
  return { x: size * SQRT3 * (h.q + h.r / 2), y: size * 1.5 * h.r };
}

/** SVG `points` string for a pointy-top hexagon centred on the origin. */
export function cornerPoints(size: number): string {
  const pts: string[] = [];
  for (let i = 0; i < 6; i++) {
    const a = (Math.PI / 180) * (60 * i - 30);
    pts.push(`${(size * Math.cos(a)).toFixed(2)},${(size * Math.sin(a)).toFixed(2)}`);
  }
  return pts.join(' ');
}

/** Small deterministic hash -> [0,1) so decorations don't change between redraws. */
export function hash2(q: number, r: number, salt = 0): number {
  let h = (q * 374761393 + r * 668265263 + salt * 2147483647) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}
