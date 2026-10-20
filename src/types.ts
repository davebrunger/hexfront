/** Axial hex coordinates (pointy-top layout). */
export interface Hex {
  q: number;
  r: number;
}

export type Side = 'allied' | 'axis';
export type UnitType = 'infantry' | 'armour' | 'artillery';
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
