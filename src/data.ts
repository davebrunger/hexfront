import type { Terrain, UnitType } from './types';

export const MAX_TURNS = 30;

export interface UnitSpec {
  name: string;
  /** Full strength; a unit at 0 is destroyed. */
  maxHp: number;
  move: number;
  attack: number;
  defence: number;
  range: number;
  /** Relative worth, used for the end-of-game score and by the AI. */
  value: number;
  blurb: string;
}

export const UNIT_SPECS: Record<UnitType, UnitSpec> = {
  infantry: {
    name: 'Infantry',
    maxHp: 4,
    move: 3,
    attack: 4,
    defence: 5,
    range: 1,
    value: 4,
    blurb: 'Sturdy and dependable. Best at holding rough ground.',
  },
  armour: {
    name: 'Armour',
    maxHp: 3,
    move: 5,
    attack: 8,
    defence: 6,
    range: 1,
    value: 8,
    blurb: 'Fast and hard-hitting, but bogs down in forest and hills.',
  },
  artillery: {
    name: 'Artillery',
    maxHp: 2,
    move: 2,
    attack: 7,
    defence: 2,
    range: 2,
    value: 6,
    blurb: 'Shells targets 2 hexes away without return fire. Cannot move and fire in one turn.',
  },
};

/** Fraction of full strength remaining. */
export const hpFrac = (u: { type: UnitType; hp: number }) => u.hp / UNIT_SPECS[u.type].maxHp;

export interface TerrainInfo {
  name: string;
  /** Multiplier applied to the defender's defence value. */
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
