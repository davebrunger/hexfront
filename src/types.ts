/** Axial hex coordinates (pointy-top layout). */
export interface Hex {
  q: number;
  r: number;
}

export type Side = 'allied' | 'axis';
export type UnitType = 'infantry' | 'armour' | 'artillery';
/**
 * A man-made obstacle on a hex. Sandbags cover the two edges either side of one corner: `facing` 0
 * is the top corner, counting clockwise to 5. Their rules are in OBSTACLES (data.ts).
 */
export type Obstacle = { kind: 'wire' } | { kind: 'sandbags'; facing: number };

export type Terrain = 'plain' | 'forest' | 'hills' | 'village' | 'water' | 'river' | 'bridge';

export interface Unit {
  id: number;
  type: UnitType;
  side: Side;
  pos: Hex;
  /** Strength, 1..UNIT_SPECS[type].maxHp. A unit at 0 is destroyed. */
  hp: number;
  /** Spaces of movement left this turn. */
  mp: number;
  /** Spaces moved so far this turn. */
  spaces: number;
  attacked: boolean;
  /** Bookkeeping flag for the AI planner: unit has already been handled this turn. */
  done: boolean;
}

export interface LogEntry {
  turn: number;
  side: Side | null;
  text: string;
}
