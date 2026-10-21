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
    const t = this.map.terrain(h);
    const o = this.map.obstacles.get(key(h));
    return (t !== undefined && TERRAIN[t].stopsMove) || (o !== undefined && OBSTACLES[o.kind].stopsMove) || this.inEnemyZoc(side, h);
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
    if (this.winner || u.side !== this.current) return false;
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
    const range = rangeOf(u.type);
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
      this.isOrdered(u) &&
      o !== undefined &&
      OBSTACLES[o.kind].clearedInsteadOfAttackBy.includes(u.type) &&
      this.mayAttackFrom(u, u.pos, u.spaces)
    );
  }

  /** Clear the obstacle `u` stands on; this uses up its attack for the turn. */
  clearObstacle(u: Unit): void {
    if (!this.canClearObstacle(u)) throw new Error('Cannot clear obstacle');
    const o = this.map.obstacles.get(key(u.pos))!;
    this.map.obstacles.delete(key(u.pos));
    u.attacked = true;
    u.mp = 0;
    this.addLog(u.side, `${UNIT_SPECS[u.type].name} clears the ${OBSTACLES[o.kind].name.toLowerCase()}`);
  }

  /** Enemies `u` can attack now: only ordered units, in the attack phase. */
  attackTargets(u: Unit): Unit[] {
    if (this.phase !== 'attack' || !this.isOrdered(u)) return [];
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
    return { dice, dealt: Math.min(dice * p, def.hp), killChance: atLeast(def.hp, dice, p) };
  }

  attack(att: Unit, def: Unit): CombatResult {
    if (!this.attackTargets(att).includes(def)) throw new Error('Illegal attack');
    const rolls = Array.from({ length: this.diceFor(att, att.pos, def) }, () => DIE_FACES[Math.floor(this.rng() * DIE_FACES.length)]);
    const dealt = Math.min(rolls.filter((f) => dieHits(f, def.type)).length, def.hp);
    def.hp -= dealt;
    att.attacked = true;
    att.mp = 0;
    const result: CombatResult = {
      attacker: att,
      defender: def,
      rolls,
      dmgToDefender: dealt,
      defenderDied: def.hp <= 0,
      ranged: distance(att.pos, def.pos) > 1,
    };
    const an = UNIT_SPECS[att.type].name;
    const dn = UNIT_SPECS[def.type].name;
    const rolled = rolls.map((f) => DIE_LABELS[f]).join(', ');
    let text = `${an} attacks ${dn}, rolls ${rolled}: ${dealt ? `${dealt} hit${dealt > 1 ? 's' : ''}` : 'miss'}`;
    if (result.defenderDied) text += ` — ${dn} destroyed!`;
    this.addLog(att.side, text);
    this.units = this.units.filter((u) => u.hp > 0);
    this.checkVictory();
    return result;
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
    if (this.winner) return;
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
    this.units.push({ id: this.nextId++, type, side, pos, hp: UNIT_SPECS[type].maxHp, mp: 0, spaces: 0, attacked: false, done: false });
  }

  private startTurn(): void {
    this.phase = 'orders';
    this.ordered.clear();
    this.lastMover = null;
    for (const u of this.unitsOf(this.current)) {
      u.mp = UNIT_SPECS[u.type].move;
      u.spaces = 0;
      u.attacked = false;
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
