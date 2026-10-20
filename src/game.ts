import { DIE_FACES, DIE_LABELS, MAX_TURNS, TERRAIN, UNIT_SPECS, attackAt, dieHits, hitChance, rangeOf, type DieFace } from './data';
import { distance, eq, fromOffset, key, neighbors } from './hex';
import { generateMap, mulberry32, type GameMap } from './map';
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

export const other = (s: Side): Side => (s === 'blue' ? 'red' : 'blue');

// Starting units for blue in offset coords; red gets the point-mirrored positions.
const START_UNITS: [UnitType, number, number][] = [
  ['infantry', 1, 4],
  ['infantry', 3, 3],
  ['infantry', 3, 5],
  ['infantry', 2, 7],
  ['armour', 2, 3],
  ['armour', 2, 5],
  ['artillery', 0, 4],
  ['artillery', 1, 6],
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
  current: Side = 'blue';
  winner: Side | 'draw' | null = null;
  winReason = '';
  log: LogEntry[] = [];
  private nextId = 1;
  private readonly rng: () => number;

  constructor(readonly seed: number) {
    this.map = generateMap(seed);
    this.rng = mulberry32(seed ^ 0x9e3779b9);
    for (const [type, col, row] of START_UNITS) {
      const pos = fromOffset(col, row);
      this.spawn('blue', type, pos);
      this.spawn('red', type, this.map.mirror(pos));
    }
    this.startTurn();
    this.addLog(null, 'Orders received. The campaign begins.');
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

  canMove(u: Unit): boolean {
    return !u.attacked && u.mp > 0 && u.side === this.current;
  }

  /** Every hex the unit could pass through or stop on this turn (incl. its own hex). */
  reachable(u: Unit): Map<string, Reach> {
    const result = new Map<string, Reach>();
    result.set(key(u.pos), { hex: u.pos, cost: 0, prev: null });
    if (!this.canMove(u)) return result;

    const frontier: { hex: Hex; cost: number }[] = [{ hex: u.pos, cost: 0 }];
    while (frontier.length) {
      frontier.sort((a, b) => a.cost - b.cost);
      const cur = frontier.shift()!;
      if (cur.cost > result.get(key(cur.hex))!.cost) continue;
      // Entering an enemy zone of control ends movement (leaving one is free).
      if (!eq(cur.hex, u.pos) && this.inEnemyZoc(u.side, cur.hex)) continue;
      for (const n of neighbors(cur.hex)) {
        const t = this.map.terrain(n);
        if (!t) continue;
        const step = TERRAIN[t].cost[u.type];
        if (!Number.isFinite(step)) continue;
        const occupant = this.unitAt(n);
        if (occupant && occupant.side !== u.side) continue;
        const cost = cur.cost + step;
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

  /** Enemy units `u` could shoot at if it stood on `from`. */
  targetsFrom(u: Unit, from: Hex, hasMoved: boolean): Unit[] {
    if (u.attacked || u.side !== this.current) return [];
    if (u.type === 'artillery' && hasMoved) return [];
    const range = rangeOf(u.type);
    return this.units.filter(
      (e) => e.side !== u.side && distance(from, e.pos) <= range && this.diceFor(u, from, e) > 0,
    );
  }

  attackTargets(u: Unit): Unit[] {
    return this.targetsFrom(u, u.pos, u.moved);
  }

  // ----------------------------------------------------------------- combat

  /** Number of attack dice `a` rolls from `aHex` against `d`. */
  diceFor(a: Unit, aHex: Hex, d: Unit): number {
    const terrain = this.map.terrain(d.pos) ?? 'plain';
    return Math.max(0, attackAt(a.type, distance(aHex, d.pos)) - TERRAIN[terrain].diceLost);
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
    u.pos = dest;
    u.mp -= r.cost;
    u.moved = true;
    return path;
  }

  endTurn(): void {
    if (this.winner) return;
    // Units that sat still recover a little.
    for (const u of this.unitsOf(this.current)) {
      if (u.moved || u.attacked) continue;
      u.hp = Math.min(UNIT_SPECS[u.type].maxHp, u.hp + 1);
    }
    if (this.current === 'red' && this.turn >= MAX_TURNS) {
      this.decideByScore();
      return;
    }
    this.current = other(this.current);
    if (this.current === 'blue') this.turn++;
    this.startTurn();
  }

  // ---------------------------------------------------------------- internals

  private spawn(side: Side, type: UnitType, pos: Hex): void {
    this.units.push({ id: this.nextId++, type, side, pos, hp: UNIT_SPECS[type].maxHp, mp: 0, attacked: false, moved: false, done: false });
  }

  private startTurn(): void {
    for (const u of this.unitsOf(this.current)) {
      u.mp = UNIT_SPECS[u.type].move;
      u.attacked = false;
      u.moved = false;
      u.done = false;
    }
  }

  /** Remaining strength (total HP) of a side's army. */
  score(side: Side): number {
    return this.unitsOf(side).reduce((s, u) => s + u.hp, 0);
  }

  private decideByScore(): void {
    const b = this.score('blue');
    const r = this.score('red');
    this.winner = Math.abs(b - r) < 0.5 ? 'draw' : b > r ? 'blue' : 'red';
    this.winReason = `Turn limit reached. Blue scored ${b.toFixed(1)}, Red ${r.toFixed(1)}.`;
    this.addLog(null, this.winReason);
  }

  private checkVictory(): void {
    if (this.winner) return;
    for (const s of ['blue', 'red'] as Side[]) {
      if (this.unitsOf(s).length === 0) {
        this.winner = other(s);
        this.winReason = `${s === 'blue' ? 'Blue' : 'Red'} has no forces left.`;
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
