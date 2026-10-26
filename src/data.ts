import type { Obstacle, Side, Terrain, UnitType } from './types';

export const MAX_TURNS = 30;

/** Units a side may order each turn; only ordered units move or attack. */
export const ORDERS_PER_TURN = 4;

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
  passable: boolean;
  /** Dry land, as opposed to lake and river (bridges included). */
  land: boolean;
  /** Can only be entered from a land hex. */
  landEntryOnly: boolean;
  /** Entering this terrain ends the unit's movement for the turn. */
  stopsMove: boolean;
  /** A unit can't attack on a turn it moved onto this terrain. */
  noAttackAfterEntering: boolean;
  /** Attack dice each attacking unit type loses when its target stands here. */
  protection: Record<UnitType, number>;
  /** Attack dice each unit type loses when attacking from here. */
  attackPenalty: Record<UnitType, number>;
  /**
   * High ground: `protection` only applies against attackers that aren't on high ground, and
   * units on high ground see each other over anything except units on high ground.
   */
  high: boolean;
  /** 'blocks': any hex blocks line of sight; 'contiguous': two adjacent hexes on the line do. */
  sight: 'clear' | 'blocks' | 'contiguous';
  /** Flags a unit here may choose to ignore each time it is attacked. */
  flagsIgnored: number;
}

const dice = (infantry: number, armour: number, artillery: number) => ({ infantry, armour, artillery });
const NONE = dice(0, 0, 0);
const OPEN = {
  passable: true,
  land: true,
  landEntryOnly: false,
  stopsMove: false,
  noAttackAfterEntering: false,
  protection: NONE,
  attackPenalty: NONE,
  high: false,
  sight: 'clear',
  flagsIgnored: 0,
} as const;
const COVER = { ...OPEN, stopsMove: true, noAttackAfterEntering: true, protection: dice(1, 2, 0), sight: 'blocks' } as const;
const WATER = { ...OPEN, passable: false, land: false } as const;

export const TERRAIN: Record<Terrain, TerrainInfo> = {
  plain: { ...OPEN, name: 'Open ground' },
  forest: { ...COVER, name: 'Forest' },
  village: { ...COVER, name: 'Village', attackPenalty: dice(0, 2, 0) },
  hills: { ...OPEN, name: 'Hills', protection: dice(1, 1, 0), high: true, sight: 'blocks' },
  water: { ...WATER, name: 'Lake', sight: 'contiguous' },
  river: { ...WATER, name: 'River' },
  bridge: { ...OPEN, name: 'Bridge', land: false, landEntryOnly: true },
};

export interface ObstacleInfo {
  name: string;
  /** Entering a hex with this obstacle ends the unit's movement for the turn. */
  stopsMove: boolean;
  /** Attack dice each attacking unit type loses against a unit here. Not added to terrain protection: the larger applies. */
  protection: Record<UnitType, number>;
  /** Attack dice each unit type loses when attacking from here. */
  attackPenalty: Record<UnitType, number>;
  /** Removed when a unit leaves the hex (including passing through it). */
  removedWhenLeft: boolean;
  /** Unit types that remove it on entering the hex (and may still attack). */
  clearedOnEntryBy: UnitType[];
  /** Unit types that may remove it instead of attacking, when standing on it and able to attack. */
  clearedInsteadOfAttackBy: UnitType[];
  /** Flags a unit here may choose to ignore each time it is attacked. */
  flagsIgnored: number;
}

export const OBSTACLES: Record<Obstacle['kind'], ObstacleInfo> = {
  sandbags: {
    name: 'Sandbags',
    stopsMove: false,
    protection: dice(1, 1, 0),
    attackPenalty: NONE,
    removedWhenLeft: true,
    clearedOnEntryBy: [],
    clearedInsteadOfAttackBy: [],
    flagsIgnored: 1,
  },
  wire: {
    name: 'Barbed wire',
    stopsMove: true,
    protection: NONE,
    attackPenalty: dice(1, 0, 0),
    removedWhenLeft: false,
    clearedOnEntryBy: ['armour'],
    clearedInsteadOfAttackBy: ['infantry'],
    flagsIgnored: 0,
  },
};

/** River hexes, with or without a bridge; drawn as one continuous river. */
export const isRiver = (t: Terrain | undefined) => t === 'river' || t === 'bridge';
