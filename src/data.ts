import type { Terrain, UnitType } from './types';

export const MAX_TURNS = 30;

export interface UnitSpec {
  name: string;
  /** Full strength; a unit at 0 is destroyed. */
  maxHp: number;
  move: number;
  /** Attack value by distance to the target: index 0 is adjacent. Its length is the unit's range. */
  attack: number[];
  blurb: string;
}

export const UNIT_SPECS: Record<UnitType, UnitSpec> = {
  infantry: {
    name: 'Infantry',
    maxHp: 4,
    move: 3,
    attack: [3, 2, 1],
    blurb: 'Sturdy and dependable. Best at holding rough ground.',
  },
  armour: {
    name: 'Armour',
    maxHp: 3,
    move: 5,
    attack: [2, 2, 2],
    blurb: 'Fast and hard-hitting, but bogs down in forest and hills.',
  },
  artillery: {
    name: 'Artillery',
    maxHp: 2,
    move: 2,
    attack: [3, 3, 2, 2, 1, 1],
    blurb: 'Shells targets up to 6 hexes away. Cannot move and fire in one turn.',
  },
};

/** Furthest distance a unit type can attack. */
export const rangeOf = (t: UnitType) => UNIT_SPECS[t].attack.length;

/** Attack value of a unit type against a target `dist` hexes away (0 if out of range). */
export const attackAt = (t: UnitType, dist: number) => UNIT_SPECS[t].attack[dist - 1] ?? 0;

/** Fraction of full strength remaining. */
export const hpFrac = (u: { type: UnitType; hp: number }) => u.hp / UNIT_SPECS[u.type].maxHp;

export interface TerrainInfo {
  name: string;
  /** Divisor applied to damage taken by a unit on this terrain. */
  defence: number;
  /** Movement point cost per unit type (Infinity = impassable). */
  cost: Record<UnitType, number>;
}

export const TERRAIN: Record<Terrain, TerrainInfo> = {
  plain: { name: 'Open ground', defence: 1.0, cost: { infantry: 1, armour: 1, artillery: 1 } },
  forest: { name: 'Forest', defence: 1.35, cost: { infantry: 2, armour: 3, artillery: 2 } },
  hills: { name: 'Hills', defence: 1.5, cost: { infantry: 2, armour: 3, artillery: 3 } },
  water: {
    name: 'Lake',
    defence: 1.0,
    cost: { infantry: Infinity, armour: Infinity, artillery: Infinity },
  },
};
