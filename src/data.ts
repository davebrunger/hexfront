import type { Side, Terrain, UnitType } from './types';

export const MAX_TURNS = 30;

export const SIDE_NAMES: Record<Side, string> = { allied: 'Allied', axis: 'Axis' };

export interface UnitSpec {
  name: string;
  /** Full strength; a unit at 0 is destroyed. */
  maxHp: number;
  /** Most spaces the unit can move in a turn. */
  move: number;
  /** Most spaces the unit can move and still attack that turn. */
  attackMove: number;
  /** Attack value by distance to the target: index 0 is adjacent. Its length is the unit's range. */
  attack: number[];
  blurb: string;
}

export const UNIT_SPECS: Record<UnitType, UnitSpec> = {
  infantry: {
    name: 'Infantry',
    maxHp: 4,
    move: 2,
    attackMove: 1,
    attack: [3, 2, 1],
    blurb: 'Moves 1 space and attacks, or 2 spaces without attacking.',
  },
  armour: {
    name: 'Armour',
    maxHp: 3,
    move: 3,
    attackMove: 3,
    attack: [2, 2, 2],
    blurb: 'Moves up to 3 spaces and still attacks.',
  },
  artillery: {
    name: 'Artillery',
    maxHp: 2,
    move: 1,
    attackMove: 0,
    attack: [3, 3, 2, 2, 1, 1],
    blurb: 'Shells targets up to 6 hexes away, ignoring terrain. Moves 1 space or fires, not both.',
  },
};

/** Furthest distance a unit type can attack. */
export const rangeOf = (t: UnitType) => UNIT_SPECS[t].attack.length;

/** Attack value of a unit type against a target `dist` hexes away (0 if out of range). */
export const attackAt = (t: UnitType, dist: number) => UNIT_SPECS[t].attack[dist - 1] ?? 0;

export type DieFace = 'infantry' | 'armour' | 'grenade' | 'flag' | 'star';

/** The six sides of an attack die. */
export const DIE_FACES: DieFace[] = ['infantry', 'infantry', 'armour', 'grenade', 'flag', 'star'];

export const DIE_LABELS: Record<DieFace, string> = {
  infantry: 'Infantry',
  armour: 'Armour',
  grenade: 'Grenade',
  flag: 'Flag',
  star: 'Star',
};

/** A die scores a hit if it shows a grenade or the target's unit type. */
export const dieHits = (face: DieFace, target: UnitType) => face === 'grenade' || face === target;

/** Chance a single die hits a target of this type. */
export const hitChance = (target: UnitType) => DIE_FACES.filter((f) => dieHits(f, target)).length / DIE_FACES.length;

/** Fraction of full strength remaining. */
export const hpFrac = (u: { type: UnitType; hp: number }) => u.hp / UNIT_SPECS[u.type].maxHp;

export interface TerrainInfo {
  name: string;
  /** Attack dice lost when the target stands on this terrain (artillery ignores this). */
  diceLost: number;
  passable: boolean;
  /** Entering this terrain ends the unit's movement for the turn. */
  stopsMove: boolean;
}

export const TERRAIN: Record<Terrain, TerrainInfo> = {
  plain: { name: 'Open ground', diceLost: 0, passable: true, stopsMove: false },
  forest: { name: 'Forest', diceLost: 1, passable: true, stopsMove: true },
  village: { name: 'Village', diceLost: 1, passable: true, stopsMove: true },
  hills: { name: 'Hills', diceLost: 1, passable: true, stopsMove: true },
  water: {
    name: 'Lake',
    diceLost: 0,
    passable: false,
    stopsMove: false,
  },
  river: { name: 'River', diceLost: 0, passable: false, stopsMove: false },
  bridge: { name: 'Bridge', diceLost: 0, passable: true, stopsMove: false },
};

/** River hexes, with or without a bridge; drawn as one continuous river. */
export const isRiver = (t: Terrain | undefined) => t === 'river' || t === 'bridge';
