import presetMaps from './config/maps.json';
import { TERRAIN, isRiver } from './data';
import { distance, fromOffset, key, neighbors, toOffsetCol } from './hex';
import type { Hex, Obstacle, Side, Terrain, UnitType } from './types';

/** Hexes in the even (long) rows; odd rows are offset half a hex and hold one fewer. */
export const MAP_WIDTH = 13;
/** Must be odd, so the top and bottom rows are both long rows and mirror onto each other. */
export const MAP_HEIGHT = 9;

export const rowWidth = (row: number) => (row % 2 === 0 ? MAP_WIDTH : MAP_WIDTH - 1);

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
  readonly obstacles = new Map<string, Obstacle>();

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
    return fromOffset(rowWidth(h.r) - 1 - toOffsetCol(h), this.height - 1 - h.r);
  }
}

/** Rows at each end of the board where the armies deploy. */
const DEPLOY_ROWS = 2;

/** A random shortest path from `a` to `b` (inclusive), staying on the map. */
function wander(map: GameMap, a: Hex, b: Hex, rng: () => number): Hex[] {
  const path = [a];
  let cur = a;
  while (distance(cur, b) > 0) {
    const steps = neighbors(cur).filter((n) => map.has(n) && distance(n, b) === distance(cur, b) - 1);
    cur = steps[Math.floor(rng() * steps.length)];
    path.push(cur);
  }
  return path;
}

/**
 * A river from the left edge to the right edge, passing through the centre hex so that it is its
 * own mirror image. Returns the half from the left edge up to (and including) the centre, or null
 * if no clean course was found.
 */
function riverCourse(map: GameMap, rng: () => number): Hex[] | null {
  const centre = fromOffset((MAP_WIDTH - 1) / 2, (MAP_HEIGHT - 1) / 2);
  const between = (lo: number, hi: number) => lo + Math.floor(rng() * (hi - lo + 1));
  for (let attempt = 0; attempt < 50; attempt++) {
    const start = fromOffset(0, between(DEPLOY_ROWS, MAP_HEIGHT - DEPLOY_ROWS - 1));
    const bend = fromOffset(between(2, 4), between(DEPLOY_ROWS + 1, MAP_HEIGHT - DEPLOY_ROWS - 2));
    const half = [...wander(map, start, bend, rng), ...wander(map, bend, centre, rng).slice(1)];
    const full = [...half, ...half.slice(0, -1).reverse().map((h) => map.mirror(h))];
    // A clean river never doubles back or touches itself except between consecutive hexes.
    const clean = full.every((h, i) => full.every((o, j) => Math.abs(i - j) <= 1 || distance(h, o) > 1));
    if (clean) return half;
  }
  return null;
}

function build(seed: number): GameMap {
  const rng = mulberry32(seed);
  const map = new GameMap(MAP_WIDTH, MAP_HEIGHT);
  for (let row = 0; row < MAP_HEIGHT; row++) {
    for (let col = 0; col < rowWidth(row); col++) {
      const h = fromOffset(col, row);
      map.tiles.set(key(h), 'plain');
      map.hexes.push(h);
    }
  }

  const blob = (t: Terrain, radius: number, density: number, minRow: number, maxRow: number, avoid = (_h: Hex) => false) => {
    const candidates = map.hexes.filter((h) => h.r >= minRow && h.r <= maxRow && !avoid(h));
    if (!candidates.length) return;
    const centre = candidates[Math.floor(rng() * candidates.length)];
    for (const h of map.hexes) {
      if (distance(centre, h) <= radius && rng() < density) {
        map.tiles.set(key(h), t);
        map.tiles.set(key(map.mirror(h)), t);
      }
    }
  };

  // Every blob is mirrored, so these counts are doubled on the board.
  for (let i = 0; i < 3; i++) blob('hills', 1, 0.7, 0, MAP_HEIGHT - 1);
  for (let i = 0; i < 3; i++) blob('forest', 1, 0.7, 0, MAP_HEIGHT - 1);

  // A river across the middle, with one or two pairs of bridges spaced along it.
  const river = riverCourse(map, rng);
  if (river) {
    for (const h of river) {
      map.tiles.set(key(h), 'river');
      map.tiles.set(key(map.mirror(h)), 'river');
    }
    const spots = river.slice(1, -1).map((_, i) => i + 1);
    const bridges: number[] = [];
    const wanted = 1 + Math.floor(rng() * 2);
    while (bridges.length < wanted && spots.length) {
      const i = spots.splice(Math.floor(rng() * spots.length), 1)[0];
      if (bridges.every((b) => Math.abs(b - i) >= 3)) bridges.push(i);
    }
    for (const i of bridges) {
      map.tiles.set(key(river[i]), 'bridge');
      map.tiles.set(key(map.mirror(river[i])), 'bridge');
    }
  }

  // Lakes keep at least one hex clear of the river.
  const riverHexes = map.hexes.filter((h) => isRiver(map.terrain(h)));
  const nearRiver = (h: Hex) => riverHexes.some((r) => distance(r, h) < 3);
  blob('water', 1, 0.6, DEPLOY_ROWS, MAP_HEIGHT - DEPLOY_ROWS - 1, nearRiver);

  // Keep the deployment rows free of lakes.
  for (const h of map.hexes) {
    if (map.terrain(h) === 'water' && (h.r < DEPLOY_ROWS || h.r >= MAP_HEIGHT - DEPLOY_ROWS)) {
      map.tiles.set(key(h), 'plain');
    }
  }

  // A couple of villages on open ground between the armies, apart from each other.
  for (let i = 0; i < 2; i++) {
    const spots = map.hexes.filter(
      (h) =>
        h.r >= DEPLOY_ROWS &&
        h.r < MAP_HEIGHT - DEPLOY_ROWS &&
        map.terrain(h) === 'plain' &&
        neighbors(h).every((n) => map.terrain(n) !== 'village'),
    );
    if (!spots.length) break;
    const h = spots[Math.floor(rng() * spots.length)];
    map.tiles.set(key(h), 'village');
    map.tiles.set(key(map.mirror(h)), 'village');
  }
  return map;
}

function isConnected(map: GameMap): boolean {
  const passable = map.hexes.filter((h) => TERRAIN[map.terrain(h)!].passable);
  const start = fromOffset(0, MAP_HEIGHT - 1);
  const seen = new Set<string>([key(start)]);
  const queue = [start];
  while (queue.length) {
    const cur = queue.pop()!;
    for (const n of neighbors(cur)) {
      const t = map.terrain(n);
      if (!t || !TERRAIN[t].passable || seen.has(key(n))) continue;
      seen.add(key(n));
      queue.push(n);
    }
  }
  return seen.size === passable.length;
}

/** A hand-made map from `src/config/maps.json`. */
export interface MapDef {
  id: string;
  name: string;
  /** One string per row, top first: one letter per hex, separated by spaces (see MAP_LETTERS). */
  rows: string[];
  /** Starting units laid out like `rows` (see UNIT_LETTERS); omitted means the standard deployment. */
  units?: string[];
  /** Obstacles laid out like `rows` (see parseObstacle); omitted means none. */
  obstacles?: string[];
}

export interface Deployment {
  side: Side;
  type: UnitType;
  pos: Hex;
}

/** Allied units are i/a/r; Axis units are the next letter along. */
export const UNIT_LETTERS: Record<string, [Side, UnitType]> = {
  i: ['allied', 'infantry'],
  j: ['axis', 'infantry'],
  a: ['allied', 'armour'],
  b: ['axis', 'armour'],
  r: ['allied', 'artillery'],
  s: ['axis', 'artillery'],
};

export const MAP_LETTERS: Record<string, Terrain> = {
  '.': 'plain',
  f: 'forest',
  v: 'village',
  h: 'hills',
  l: 'water',
  r: 'river',
  b: 'bridge',
};

export const PRESET_MAPS: MapDef[] = presetMaps;

/** Split a hex grid into its letters, calling `cell` for each hex in reading order. */
function readGrid(name: string, lines: string[], cell: (letter: string, h: Hex, row: number) => void): void {
  if (lines.length !== MAP_HEIGHT) throw new Error(`${name}: expected ${MAP_HEIGHT} rows, got ${lines.length}`);
  lines.forEach((line, row) => {
    const cells = line.trim().split(/\s+/);
    if (cells.length !== rowWidth(row)) {
      throw new Error(`${name}: row ${row + 1} should have ${rowWidth(row)} hexes, got ${cells.length}`);
    }
    cells.forEach((letter, col) => cell(letter, fromOffset(col, row), row));
  });
}

export function parseMap(def: MapDef): GameMap {
  const map = new GameMap(MAP_WIDTH, MAP_HEIGHT);
  readGrid(def.name, def.rows, (letter, h, row) => {
    const t = MAP_LETTERS[letter];
    if (!t) throw new Error(`${def.name}: unknown terrain '${letter}' in row ${row + 1}`);
    map.tiles.set(key(h), t);
    map.hexes.push(h);
  });
  if (def.obstacles) {
    readGrid(`${def.name} obstacles`, def.obstacles, (letter, h, row) => {
      if (letter === '.') return;
      const obstacle = parseObstacle(letter);
      if (!obstacle) throw new Error(`${def.name}: unknown obstacle '${letter}' in obstacles row ${row + 1}`);
      map.obstacles.set(key(h), obstacle);
    });
  }
  return map;
}

/** `w` is barbed wire; a digit 0-5 is sandbags facing that corner (0 = top, clockwise). */
function parseObstacle(letter: string): Obstacle | null {
  if (letter === 'w') return { kind: 'wire' };
  if (/^[0-5]$/.test(letter)) return { kind: 'sandbags', facing: Number(letter) };
  return null;
}

/** The starting units of a preset map, or null if it uses the standard deployment. */
export function parseUnits(def: MapDef): Deployment[] | null {
  if (!def.units) return null;
  const units: Deployment[] = [];
  readGrid(`${def.name} units`, def.units, (letter, pos, row) => {
    if (letter === '.') return;
    const unit = UNIT_LETTERS[letter];
    if (!unit) throw new Error(`${def.name}: unknown unit '${letter}' in units row ${row + 1}`);
    units.push({ side: unit[0], type: unit[1], pos });
  });
  return units;
}

/** Generate a point-symmetric map; retries with derived seeds until every land hex is reachable. */
export function generateMap(seed: number): GameMap {
  for (let attempt = 0; attempt < 100; attempt++) {
    const map = build(seed + attempt * 7919);
    if (isConnected(map)) return map;
  }
  throw new Error('Could not generate a connected map');
}
