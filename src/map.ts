import { distance, fromOffset, key, neighbors, toOffsetCol } from './hex';
import type { Hex, Terrain } from './types';

export const MAP_WIDTH = 16;
/** Must be even: that is what makes a point-reflected map line up with itself. */
export const MAP_HEIGHT = 10;

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export class GameMap {
  readonly tiles = new Map<string, Terrain>();
  readonly hexes: Hex[] = [];

  constructor(
    readonly width: number,
    readonly height: number,
  ) {}

  terrain(h: Hex): Terrain | undefined {
    return this.tiles.get(key(h));
  }

  has(h: Hex): boolean {
    return this.tiles.has(key(h));
  }

  /** Point reflection through the centre of the board (used for a fair, symmetric map). */
  mirror(h: Hex): Hex {
    return { q: this.width - this.height / 2 - h.q, r: this.height - 1 - h.r };
  }
}

/** Centre of blue's deployment area in offset coordinates (col,row); red's is the mirror image. */
export const DEPLOY_CENTRE: [number, number] = [1, 4];

function build(seed: number): GameMap {
  const rng = mulberry32(seed);
  const map = new GameMap(MAP_WIDTH, MAP_HEIGHT);
  for (let row = 0; row < MAP_HEIGHT; row++) {
    for (let col = 0; col < MAP_WIDTH; col++) {
      const h = fromOffset(col, row);
      map.tiles.set(key(h), 'plain');
      map.hexes.push(h);
    }
  }

  const blob = (t: Terrain, radius: number, density: number, minCol: number, maxCol: number) => {
    const candidates = map.hexes.filter((h) => {
      const c = toOffsetCol(h);
      return c >= minCol && c <= maxCol;
    });
    const centre = candidates[Math.floor(rng() * candidates.length)];
    for (const h of map.hexes) {
      if (distance(centre, h) <= radius && rng() < density) {
        map.tiles.set(key(h), t);
        map.tiles.set(key(map.mirror(h)), t);
      }
    }
  };

  for (let i = 0; i < 6; i++) blob('hills', 1 + Math.floor(rng() * 2), 0.85, 0, MAP_WIDTH - 1);
  for (let i = 0; i < 5; i++) blob('forest', 1 + Math.floor(rng() * 2), 0.85, 0, MAP_WIDTH - 1);
  for (let i = 0; i < 3; i++) blob('water', 1, 0.9, 4, MAP_WIDTH - 5);

  // Keep the starting areas free of lakes.
  const deployB = fromOffset(DEPLOY_CENTRE[0], DEPLOY_CENTRE[1]);
  const deployR = map.mirror(deployB);
  for (const h of map.hexes) {
    if (map.terrain(h) === 'water' && (distance(h, deployB) <= 4 || distance(h, deployR) <= 4)) {
      map.tiles.set(key(h), 'plain');
    }
  }
  return map;
}

function isConnected(map: GameMap): boolean {
  const passable = map.hexes.filter((h) => map.terrain(h) !== 'water');
  const start = fromOffset(DEPLOY_CENTRE[0], DEPLOY_CENTRE[1]);
  const seen = new Set<string>([key(start)]);
  const queue = [start];
  while (queue.length) {
    const cur = queue.pop()!;
    for (const n of neighbors(cur)) {
      const t = map.terrain(n);
      if (!t || t === 'water' || seen.has(key(n))) continue;
      seen.add(key(n));
      queue.push(n);
    }
  }
  return seen.size === passable.length;
}

/** Generate a point-symmetric map; retries with derived seeds until every land hex is reachable. */
export function generateMap(seed: number): GameMap {
  for (let attempt = 0; attempt < 100; attempt++) {
    const map = build(seed + attempt * 7919);
    if (isConnected(map)) return map;
  }
  throw new Error('Could not generate a connected map');
}
