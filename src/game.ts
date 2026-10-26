import { DIE_FACES, DIE_LABELS, MAX_TURNS, OBSTACLES, ORDERS_PER_TURN, SIDE_NAMES, TERRAIN, UNIT_SPECS, attackAt, dieHits, hitChance, rangeOf, type DieFace } from './data';
import { distance, eq, fromOffset, hexesOnLine, key, neighbors } from './hex';
import { generateMap, mulberry32, parseMap, parseUnits, type Deployment, type GameMap, type MapDef } from './map';
import type { Hex, LogEntry, Side, Unit, UnitType } from './types';

export interface Reach {
  hex: Hex;
  cost: number;
  prev: string | null;
}

export interface Forecast {
  dice: number;
  /** Expected damage. */
  dealt: number;
  /** Chance the attack destroys the target. */
  killChance: number;
}

export interface CombatResult {
  attacker: Unit;
  defender: Unit;
  rolls: DieFace[];
  dmgToDefender: number;
  defenderDied: boolean;
  ranged: boolean;
  /** Flags rolled; a surviving defender must retreat that many hexes (see `pendingRetreat`). */
  flags: number;
}

/**
 * A retreat still to be carried out after an attack. Its owner first decides how many of the
 * `ignorable` flags to ignore (`ignoreFlags`), then picks each hex (`retreatOptions`, `retreatTo`).
 */
/** A unit that won a close combat and may take ground by advancing into `to` (see `takeGround`). */
export interface PendingAdvance {
  unit: Unit;
  to: Hex;
}

export interface PendingRetreat {
  unit: Unit;
  /** Hexes still to retreat. */
  steps: number;
  /** Flags the unit may still choose to ignore (from sandbags or terrain). */
  ignorable: number;
}

/**
 * A turn runs in three phases: give orders to up to ORDERS_PER_TURN units, move the ordered units
 * one at a time, then attack with them one at a time.
 */
export type Phase = 'orders' | 'move' | 'attack';

export const other = (s: Side): Side => (s === 'allied' ? 'axis' : 'allied');

// Standard starting units for the Allies (at the bottom, moving first) in offset coords (col, row);
// the Axis (at the top) gets the point-mirrored positions. Preset maps may set their own.
const START_UNITS: [UnitType, number, number][] = [
  ['infantry', 1, 7],
  ['infantry', 4, 7],
  ['infantry', 7, 7],
  ['infantry', 10, 7],
  ['armour', 2, 8],
  ['armour', 10, 8],
  ['artillery', 5, 8],
  ['artillery', 7, 8],
];

/** Chance of at least `k` hits from `n` dice that each hit with chance `p`. */
function atLeast(k: number, n: number, p: number): number {
  let total = 0;
  let choose = 1;
  for (let i = 0; i <= n; i++) {
    if (i >= k) total += choose * p ** i * (1 - p) ** (n - i);
    choose = (choose * (n - i)) / (i + 1);
  }
  return total;
}

export class Game {
  readonly map: GameMap;
  units: Unit[] = [];
  turn = 1;
  /** The side that moves first each round: set by a preset map, random on a generated one. */
  readonly firstSide: Side;
  current: Side;
  phase: Phase = 'orders';
  /** Ids of the current side's units ordered this turn. */
  readonly ordered = new Set<number>();
  /** The unit that moved last this phase; moving another unit ends its movement. */
  private lastMover: Unit | null = null;
  winner: Side | 'draw' | null = null;
  /** A retreat that must be resolved before anything else happens. */
  pendingRetreat: PendingRetreat | null = null;
  /** A take-ground decision that must be made before anything else happens. */
  pendingAdvance: PendingAdvance | null = null;
  /** Armour that took ground and may still make its overrun attack; attacking with another unit gives it up. */
  overrunUnit: Unit | null = null;
  /** The close combat attack just made, for taking ground once its retreat is settled. */
  private closeCombat: PendingAdvance | null = null;
  winReason = '';
  log: LogEntry[] = [];
  private nextId = 1;
  private readonly rng: () => number;

  /** Plays on `mapDef` if given, otherwise on a map generated from `seed` (which also drives the dice). */
  constructor(
    readonly seed: number,
    mapDef?: MapDef,
  ) {
    this.map = mapDef ? parseMap(mapDef) : generateMap(seed);
    this.rng = mulberry32(seed ^ 0x9e3779b9);
    if (mapDef && mapDef.firstSide !== 'allied' && mapDef.firstSide !== 'axis') {
      throw new Error(`${mapDef.name}: firstSide must be "allied" or "axis"`);
    }
    this.firstSide = mapDef ? mapDef.firstSide : this.rng() < 0.5 ? 'allied' : 'axis';
    this.current = this.firstSide;
    const units: Deployment[] =
      (mapDef && parseUnits(mapDef)) ??
      START_UNITS.flatMap(([type, col, row]) => [
        { side: 'allied' as const, type, pos: fromOffset(col, row) },
        { side: 'axis' as const, type, pos: this.map.mirror(fromOffset(col, row)) },
      ]);
    for (const { side, type, pos } of units) {
      const t = this.map.terrain(pos);
      if (!t || !TERRAIN[t].passable) throw new Error(`Map has impassable terrain at a ${side} starting hex`);
      this.spawn(side, type, pos);
    }
    for (const side of ['allied', 'axis'] as const) {
      if (!this.unitsOf(side).length) throw new Error(`Map has no ${side} units`);
    }
    this.startTurn();
    this.addLog(null, `Orders received. The campaign begins; ${SIDE_NAMES[this.firstSide]} move first.`);
  }

  /** Public so the AI can add a little variety without owning an RNG of its own. */
  rand(): number {
    return this.rng();
  }

  // ---------------------------------------------------------------- queries

  unitAt(h: Hex): Unit | undefined {
    return this.units.find((u) => eq(u.pos, h));
  }

  unitsOf(side: Side): Unit[] {
    return this.units.filter((u) => u.side === side);
  }

  inEnemyZoc(side: Side, h: Hex): boolean {
    return neighbors(h).some((n) => {
      const u = this.unitAt(n);
      return u !== undefined && u.side !== side;
    });
  }

  /** Spaces `u` has moved so far this turn. */
  spacesMoved(u: Unit): number {
    return u.spaces;
  }

  /** Entering `h` ends movement: forest, villages, wire, or next to an enemy. */
  stopsMovement(side: Side, h: Hex): boolean {
    return this.terrainStops(h) || this.inEnemyZoc(side, h);
  }

  /** Terrain or an obstacle on `h` stops a unit entering it (forest, villages, wire). */
  private terrainStops(h: Hex): boolean {
    const t = this.map.terrain(h);
    const o = this.map.obstacles.get(key(h));
    return (t !== undefined && TERRAIN[t].stopsMove) || (o !== undefined && OBSTACLES[o.kind].stopsMove);
  }

  // ---------------------------------------------------------------- phases

  /** Order or unorder one of the current side's units. Returns false if it can't be ordered. */
  toggleOrder(u: Unit): boolean {
    if (this.phase !== 'orders' || u.side !== this.current) return false;
    if (this.ordered.has(u.id)) this.ordered.delete(u.id);
    else if (this.ordered.size < ORDERS_PER_TURN) this.ordered.add(u.id);
    else return false;
    return true;
  }

  /** Finish the order phase with the units ordered so far. */
  confirmOrders(): void {
    if (this.phase !== 'orders') return;
    this.phase = 'move';
    const n = this.ordered.size;
    this.addLog(this.current, `${SIDE_NAMES[this.current]} order ${n} unit${n === 1 ? '' : 's'}`);
  }

  /** Order exactly `units` and move on to the movement phase. */
  giveOrders(units: Unit[]): void {
    this.ordered.clear();
    for (const u of units.slice(0, ORDERS_PER_TURN)) this.toggleOrder(u);
    this.confirmOrders();
  }

  /** Finish the movement phase; ordered units can now attack. */
  endMovement(): void {
    if (this.phase !== 'move') return;
    this.phase = 'attack';
    for (const u of this.units) u.done = false;
  }

  isOrdered(u: Unit): boolean {
    return u.side === this.current && this.ordered.has(u.id);
  }

  /** Whether `u` has something it can still do in the current phase. */
  isReady(u: Unit): boolean {
    if (this.winner || this.pendingRetreat || this.pendingAdvance || u.side !== this.current) return false;
    if (this.phase === 'orders') return this.ordered.has(u.id) || this.ordered.size < ORDERS_PER_TURN;
    if (this.phase === 'move') return this.canMove(u);
    return this.attackTargets(u).length > 0 || this.canClearObstacle(u);
  }

  canMove(u: Unit): boolean {
    return this.phase === 'move' && this.isOrdered(u) && !u.attacked && u.mp > 0;
  }

  /**
   * Every hex the unit could pass through or stop on this turn (incl. its own hex). With
   * `planning`, works out where it could go if ordered, whatever the phase.
   */
  reachable(u: Unit, planning = false): Map<string, Reach> {
    const result = new Map<string, Reach>();
    result.set(key(u.pos), { hex: u.pos, cost: 0, prev: null });
    if (planning ? u.mp <= 0 || u.side !== this.current : !this.canMove(u)) return result;

    const frontier: { hex: Hex; cost: number }[] = [{ hex: u.pos, cost: 0 }];
    while (frontier.length) {
      frontier.sort((a, b) => a.cost - b.cost);
      const cur = frontier.shift()!;
      if (cur.cost > result.get(key(cur.hex))!.cost) continue;
      // Entering forest, hills, a village or an enemy zone of control ends movement (leaving is free).
      if (!eq(cur.hex, u.pos) && this.stopsMovement(u.side, cur.hex)) continue;
      for (const n of neighbors(cur.hex)) {
        const t = this.map.terrain(n);
        if (!t) continue;
        if (!TERRAIN[t].passable) continue;
        if (TERRAIN[t].landEntryOnly && !TERRAIN[this.map.terrain(cur.hex)!].land) continue;
        const occupant = this.unitAt(n);
        if (occupant && occupant.side !== u.side) continue;
        const cost = cur.cost + 1;
        if (cost > u.mp) continue;
        const known = result.get(key(n));
        if (known && known.cost <= cost) continue;
        result.set(key(n), { hex: n, cost, prev: key(cur.hex) });
        frontier.push({ hex: n, cost });
      }
    }
    return result;
  }

  /** Hexes the unit may actually end its move on. */
  moveTargets(u: Unit): Reach[] {
    return [...this.reachable(u).values()].filter((r) => !eq(r.hex, u.pos) && !this.unitAt(r.hex));
  }

  pathTo(reach: Map<string, Reach>, dest: Hex): Hex[] {
    const path: Hex[] = [];
    let cur = reach.get(key(dest));
    while (cur && cur.prev !== null) {
      path.unshift(cur.hex);
      cur = reach.get(cur.prev);
    }
    return path;
  }

  /** Enemy units `u` could shoot at if it stood on `from` having moved `spaces` this turn. */
  targetsFrom(u: Unit, from: Hex, spaces: number): Unit[] {
    if (!this.mayAttackFrom(u, from, spaces)) return [];
    // In close combat (next to an enemy) a unit may only attack the enemies next to it.
    const closeCombat = this.units.some((e) => e.side !== u.side && distance(from, e.pos) === 1);
    const range = closeCombat ? 1 : rangeOf(u.type);
    return this.units.filter(
      (e) =>
        e.side !== u.side &&
        distance(from, e.pos) <= range &&
        this.diceFor(u, from, e) > 0 &&
        (u.type === 'artillery' || this.lineOfSight(from, e.pos, u)),
    );
  }

  /**
   * Whether a unit on `from` can see `to`. Units, sight-blocking terrain and anything off the board
   * (such as the half hexes at the ends of the short rows) between the two hexes block it; the two
   * hexes themselves never do. Between two hexes of high ground only units on high ground block it.
   * `ignore` is left out as an obstruction (a unit considering a move).
   * A line running along hex edges is only blocked if there are obstructions on both sides of it,
   * so the line is checked nudged slightly to each side and blocked only if both are.
   */
  lineOfSight(from: Hex, to: Hex, ignore?: Unit): boolean {
    const high = (h: Hex) => {
      const t = this.map.terrain(h);
      return t !== undefined && TERRAIN[t].high;
    };
    const overHigh = high(from) && high(to);
    const clear = (offset: number) => {
      const contiguous: Hex[] = [];
      for (const h of hexesOnLine(from, to, offset)) {
        if (eq(h, from) || eq(h, to)) continue;
        const unit = this.unitAt(h);
        const blockingUnit = unit !== undefined && unit !== ignore;
        if (overHigh) {
          if (blockingUnit && high(h)) return false;
          continue;
        }
        const t = this.map.terrain(h);
        if (blockingUnit || !t || TERRAIN[t].sight === 'blocks') return false;
        if (TERRAIN[t].sight === 'contiguous') {
          if (contiguous.some((c) => this.map.terrain(c) === t && distance(c, h) === 1)) return false;
          contiguous.push(h);
        }
      }
      return true;
    };
    return clear(1e-4) || clear(-1e-4);
  }

  /** Whether `u` would be allowed to attack (or act instead of attacking) on `from` having moved `spaces`. */
  private mayAttackFrom(u: Unit, from: Hex, spaces: number): boolean {
    if (u.attacked || u.side !== this.current) return false;
    if (spaces > UNIT_SPECS[u.type].attackMove) return false;
    return !(spaces > 0 && TERRAIN[this.map.terrain(from)!].noAttackAfterEntering);
  }

  /** Whether `u` can clear the obstacle it stands on instead of attacking (infantry on wire). */
  canClearObstacle(u: Unit): boolean {
    const o = this.map.obstacles.get(key(u.pos));
    return (
      this.phase === 'attack' &&
      !this.pendingRetreat &&
      !this.pendingAdvance &&
      this.isOrdered(u) &&
      o !== undefined &&
      OBSTACLES[o.kind].clearedInsteadOfAttackBy.includes(u.type) &&
      this.mayAttackFrom(u, u.pos, u.spaces)
    );
  }

  /** Clear the obstacle `u` stands on; this uses up its attack for the turn. */
  clearObstacle(u: Unit): void {
    if (!this.canClearObstacle(u)) throw new Error('Cannot clear obstacle');
    this.forfeitOverrun(u);
    const o = this.map.obstacles.get(key(u.pos))!;
    this.map.obstacles.delete(key(u.pos));
    u.attacked = true;
    u.mp = 0;
    this.addLog(u.side, `${UNIT_SPECS[u.type].name} clears the ${OBSTACLES[o.kind].name.toLowerCase()}`);
  }

  /** Enemies `u` can attack now: only ordered units, in the attack phase. */
  attackTargets(u: Unit): Unit[] {
    if (this.phase !== 'attack' || !this.isOrdered(u) || this.pendingRetreat || this.pendingAdvance) return [];
    return this.targetsFrom(u, u.pos, this.spacesMoved(u));
  }

  // ----------------------------------------------------------------- combat

  /** Number of attack dice `a` rolls from `aHex` against `d`. */
  diceFor(a: Unit, aHex: Hex, d: Unit): number {
    return this.diceAt(a.type, aHex, d.pos);
  }

  /**
   * Attack dice a unit of `type` rolls from `from` at a target on `to`: its attack at that range,
   * less the target terrain's protection and the attacker terrain's penalty, which add together.
   */
  diceAt(type: UnitType, from: Hex, to: Hex): number {
    return Math.max(0, attackAt(type, distance(from, to)) - this.diceLost(type, from, to));
  }

  /**
   * Attack dice a unit of `type` on `from` loses to terrain and obstacles when attacking a target on
   * `to`. The target's terrain and obstacle protection don't add together (the larger applies), but
   * penalties for where the attacker stands do add on.
   */
  diceLost(type: UnitType, from: Hex, to: Hex): number {
    const att = TERRAIN[this.map.terrain(from) ?? 'plain'];
    const def = TERRAIN[this.map.terrain(to) ?? 'plain'];
    const attObstacle = this.map.obstacles.get(key(from));
    const defObstacle = this.map.obstacles.get(key(to));
    const terrainCover = def.high && att.high ? 0 : def.protection[type];
    const obstacleCover = defObstacle ? OBSTACLES[defObstacle.kind].protection[type] : 0;
    const penalty = att.attackPenalty[type] + (attObstacle ? OBSTACLES[attObstacle.kind].attackPenalty[type] : 0);
    return Math.max(terrainCover, obstacleCover) + penalty;
  }

  /** Expected outcome of `att` attacking `def` from `attHex`. */
  forecast(att: Unit, def: Unit, attHex: Hex = att.pos): Forecast {
    const dice = this.diceFor(att, attHex, def);
    const p = hitChance(def.type);
    // Flags the defender can't retreat from cost it strength too.
    const flag = DIE_FACES.filter((f) => f === 'flag').length / DIE_FACES.length;
    const ignored = this.flagsIgnoredAt(def.pos);
    let blocked = 0;
    for (let k = 1; k <= dice; k++) {
      const steps = Math.max(0, k - ignored);
      const lost = steps - this.maxRetreat(def.side, def.pos, steps);
      if (lost > 0) blocked += (atLeast(k, dice, flag) - atLeast(k + 1, dice, flag)) * lost;
    }
    return { dice, dealt: Math.min(dice * p + blocked, def.hp), killChance: atLeast(def.hp, dice, p) };
  }

  attack(att: Unit, def: Unit): CombatResult {
    if (!this.attackTargets(att).includes(def)) throw new Error('Illegal attack');
    this.forfeitOverrun(att);
    const defHex = def.pos;
    const rolls = Array.from({ length: this.diceFor(att, att.pos, def) }, () => DIE_FACES[Math.floor(this.rng() * DIE_FACES.length)]);
    const dealt = Math.min(rolls.filter((f) => dieHits(f, def.type)).length, def.hp);
    def.hp -= dealt;
    att.attacked = true;
    att.mp = 0;
    const flags = rolls.filter((f) => f === 'flag').length;
    const result: CombatResult = {
      attacker: att,
      defender: def,
      rolls,
      dmgToDefender: dealt,
      defenderDied: def.hp <= 0,
      ranged: distance(att.pos, def.pos) > 1,
      flags,
    };
    const an = UNIT_SPECS[att.type].name;
    const dn = UNIT_SPECS[def.type].name;
    const rolled = rolls.map((f) => DIE_LABELS[f]).join(', ');
    let text = `${an} attacks ${dn}, rolls ${rolled}: ${dealt ? `${dealt} hit${dealt > 1 ? 's' : ''}` : 'miss'}`;
    if (result.defenderDied) text += ` — ${dn} destroyed!`;
    this.addLog(att.side, text);
    this.units = this.units.filter((u) => u.hp > 0);
    this.checkVictory();
    // Retreats are resolved after hits and casualties.
    // A successful close combat lets the attacker take ground, once any retreat is settled.
    this.closeCombat = distance(att.pos, defHex) === 1 ? { unit: att, to: defHex } : null;
    if (!result.defenderDied && flags > 0 && !this.winner) this.startRetreat(def, flags);
    if (!this.pendingRetreat) this.offerAdvance();
    return result;
  }

  // ----------------------------------------------------------- taking ground

  /** After a close combat attack, offer to take ground if the target's hex is now empty. */
  private offerAdvance(): void {
    const cc = this.closeCombat;
    this.closeCombat = null;
    if (!cc || this.winner || !this.units.includes(cc.unit)) return;
    const { unit, to } = cc;
    if (unit.type === 'artillery' || unit.halted || this.unitAt(to)) return;
    this.pendingAdvance = { unit, to };
  }

  /**
   * Decide on a pending take-ground: advance into the vacated hex, or stay. Terrain applies as if
   * moving in: forest, villages and wire stop the unit (no taking ground again), and armour clears
   * wire. Armour that advances may then make one overrun attack, unless its new hex forbids attacking.
   */
  takeGround(advance: boolean): void {
    const pa = this.pendingAdvance;
    if (!pa) throw new Error('No ground to take');
    this.pendingAdvance = null;
    if (!advance) return;
    const { unit, to } = pa;
    const name = UNIT_SPECS[unit.type].name;
    const left = this.map.obstacles.get(key(unit.pos));
    if (left && OBSTACLES[left.kind].removedWhenLeft) this.map.obstacles.delete(key(unit.pos));
    unit.pos = to;
    unit.halted = this.terrainStops(to);
    const o = this.map.obstacles.get(key(to));
    if (o && OBSTACLES[o.kind].clearedOnEntryBy.includes(unit.type)) this.map.obstacles.delete(key(to));
    this.addLog(unit.side, `${name} takes ground`);
    if (unit.type === 'armour' && !unit.overran && !TERRAIN[this.map.terrain(to)!].noAttackAfterEntering) {
      unit.overran = true;
      unit.attacked = false;
      this.overrunUnit = unit;
    }
  }

  /** Any other unit acting gives up an overrun that hasn't been made yet. */
  private forfeitOverrun(acting: Unit): void {
    if (this.overrunUnit && this.overrunUnit !== acting) this.overrunUnit.attacked = true;
    this.overrunUnit = null;
  }

  // --------------------------------------------------------------- retreats

  /** `unit` must retreat one hex per flag (less any it chooses to ignore). */
  startRetreat(unit: Unit, flags: number): void {
    this.pendingRetreat = { unit, steps: flags, ignorable: Math.min(flags, this.flagsIgnoredAt(unit.pos)) };
    this.advanceRetreat();
  }

  /** Flags a unit on `h` may ignore: the best of its terrain and obstacle. */
  flagsIgnoredAt(h: Hex): number {
    const o = this.map.obstacles.get(key(h));
    return Math.max(TERRAIN[this.map.terrain(h) ?? 'plain'].flagsIgnored, o ? OBSTACLES[o.kind].flagsIgnored : 0);
  }

  /** The (up to two) hexes one step back towards a unit's baseline: down the map for the Allies, up for the Axis. */
  private retreatSteps(side: Side, from: Hex): Hex[] {
    const dr = side === 'allied' ? 1 : -1;
    return neighbors(from).filter((n) => {
      if (n.r - from.r !== dr) return false;
      const t = this.map.terrain(n);
      return t !== undefined && TERRAIN[t].passable && !this.unitAt(n);
    });
  }

  /** The most of `steps` retreat moves a unit of `side` on `from` can make. Terrain and obstacles don't stop it. */
  maxRetreat(side: Side, from: Hex, steps: number): number {
    if (steps <= 0) return 0;
    let best = 0;
    for (const n of this.retreatSteps(side, from)) {
      best = Math.max(best, 1 + this.maxRetreat(side, n, steps - 1));
      if (best === steps) break;
    }
    return best;
  }

  /**
   * Hexes the retreating unit may step to next: only those on a retreat that goes as far as
   * possible. Empty while the owner still has to decide about ignoring flags.
   */
  retreatOptions(): Hex[] {
    const pr = this.pendingRetreat;
    if (!pr || pr.ignorable > 0) return [];
    const { unit, steps } = pr;
    const best = this.maxRetreat(unit.side, unit.pos, steps);
    return this.retreatSteps(unit.side, unit.pos).filter((n) => 1 + this.maxRetreat(unit.side, n, steps - 1) === best);
  }

  /** The retreating unit's owner ignores `n` of the flags they may ignore (0 to retreat in full). */
  ignoreFlags(n: number): void {
    const pr = this.pendingRetreat;
    if (!pr || n < 0 || n > pr.ignorable) throw new Error('Cannot ignore that many flags');
    pr.steps -= n;
    pr.ignorable = 0;
    if (n) this.addLog(pr.unit.side, `${UNIT_SPECS[pr.unit.type].name} holds firm, ignoring ${n} flag${n > 1 ? 's' : ''}`);
    this.advanceRetreat();
  }

  /** Retreat one hex to `h`, which must be one of `retreatOptions()`. */
  retreatTo(h: Hex): void {
    const pr = this.pendingRetreat;
    if (!pr || !this.retreatOptions().some((o) => eq(o, h))) throw new Error('Illegal retreat');
    const o = this.map.obstacles.get(key(pr.unit.pos));
    if (o && OBSTACLES[o.kind].removedWhenLeft) this.map.obstacles.delete(key(pr.unit.pos));
    pr.unit.pos = h;
    pr.steps--;
    this.advanceRetreat();
  }

  /** Finish the retreat when it's done, or take the hp loss for steps that can't be made. */
  private advanceRetreat(): void {
    const pr = this.pendingRetreat;
    if (!pr || pr.ignorable > 0) return;
    if (pr.steps > 0 && this.maxRetreat(pr.unit.side, pr.unit.pos, pr.steps) > 0) return;
    this.pendingRetreat = null;
    if (pr.steps > 0) {
      const name = UNIT_SPECS[pr.unit.type].name;
      pr.unit.hp -= pr.steps;
      this.addLog(pr.unit.side, `${name} cannot retreat and loses ${pr.steps} strength${pr.unit.hp <= 0 ? ` — ${name} destroyed!` : ''}`);
      this.units = this.units.filter((u) => u.hp > 0);
      this.checkVictory();
    }
    this.offerAdvance();
  }

  // ---------------------------------------------------------------- actions

  /** Move a unit; returns the hexes it passed through (excluding the start). */
  moveUnit(u: Unit, dest: Hex): Hex[] {
    const reach = this.reachable(u);
    const r = reach.get(key(dest));
    if (!r || eq(dest, u.pos) || this.unitAt(dest)) throw new Error('Illegal move');
    const path = this.pathTo(reach, dest);
    if (this.lastMover && this.lastMover !== u) this.lastMover.mp = 0;
    this.lastMover = u;
    const name = UNIT_SPECS[u.type].name;
    for (const left of [u.pos, ...path.slice(0, -1)]) {
      const o = this.map.obstacles.get(key(left));
      if (o && OBSTACLES[o.kind].removedWhenLeft) {
        this.map.obstacles.delete(key(left));
        this.addLog(u.side, `${name} moves off; the ${OBSTACLES[o.kind].name.toLowerCase()} are removed`);
      }
    }
    u.pos = dest;
    u.halted = this.terrainStops(dest);
    u.mp = this.stopsMovement(u.side, dest) ? 0 : u.mp - r.cost;
    u.spaces += r.cost;
    const o = this.map.obstacles.get(key(dest));
    if (o && OBSTACLES[o.kind].clearedOnEntryBy.includes(u.type)) {
      this.map.obstacles.delete(key(dest));
      this.addLog(u.side, `${name} clears the ${OBSTACLES[o.kind].name.toLowerCase()}`);
    }
    return path;
  }

  endTurn(): void {
    if (this.winner || this.pendingRetreat || this.pendingAdvance) return;
    if (this.current !== this.firstSide && this.turn >= MAX_TURNS) {
      this.decideByScore();
      return;
    }
    this.current = other(this.current);
    if (this.current === this.firstSide) this.turn++;
    this.startTurn();
  }

  // ---------------------------------------------------------------- internals

  private spawn(side: Side, type: UnitType, pos: Hex): void {
    this.units.push({ id: this.nextId++, type, side, pos, hp: UNIT_SPECS[type].maxHp, mp: 0, spaces: 0, attacked: false, halted: false, overran: false, done: false });
  }

  private startTurn(): void {
    this.phase = 'orders';
    this.ordered.clear();
    this.lastMover = null;
    this.overrunUnit = null;
    for (const u of this.unitsOf(this.current)) {
      u.mp = UNIT_SPECS[u.type].move;
      u.spaces = 0;
      u.attacked = false;
      u.halted = false;
      u.overran = false;
      u.done = false;
    }
  }

  /** Remaining strength (total HP) of a side's army. */
  score(side: Side): number {
    return this.unitsOf(side).reduce((s, u) => s + u.hp, 0);
  }

  private decideByScore(): void {
    const a = this.score('allied');
    const x = this.score('axis');
    this.winner = a === x ? 'draw' : a > x ? 'allied' : 'axis';
    this.winReason = `Turn limit reached. ${SIDE_NAMES.allied} scored ${a}, ${SIDE_NAMES.axis} ${x}.`;
    this.addLog(null, this.winReason);
  }

  private checkVictory(): void {
    if (this.winner) return;
    for (const s of ['allied', 'axis'] as Side[]) {
      if (this.unitsOf(s).length === 0) {
        this.winner = other(s);
        this.winReason = `${SIDE_NAMES[s]} has no forces left.`;
      }
      if (this.winner) {
        this.addLog(null, this.winReason);
        return;
      }
    }
  }

  private addLog(side: Side | null, text: string): void {
    this.log.push({ turn: this.turn, side, text });
    if (this.log.length > 200) this.log.shift();
  }
}
