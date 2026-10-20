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
