import { OBSTACLES, ORDERS_PER_TURN, TERRAIN, UNIT_SPECS, attackAt, hitChance, hpFrac } from './data';
import { distance, eq, key } from './hex';
import { other, type Game } from './game';
import type { Hex, Unit } from './types';

/** One step of the AI's turn, carried out through the same Game methods a human uses. */
export type AIAction =
  | { kind: 'orders'; units: Unit[] }
  | { kind: 'move'; unit: Unit; dest: Hex | null }
  | { kind: 'endMovement' }
  | { kind: 'attack'; unit: Unit; target: Unit }
  | { kind: 'clear'; unit: Unit };

// Scoring weights. Tuned to play aggressively rather than optimally: a cautious AI wins more
// often on points but turns most games into a stand-off that runs to the turn limit. It starts
// patient, holding cover, and grows bolder quickly as the turns pass.
const ATTACK_WEIGHT = 4;
const CLOSE_WEIGHT = 0.8;
const TERRAIN_WEIGHT = 2;
const DANGER_WEIGHT = 2.5;
/** Caution falls by this much each turn, and per point of score the side is behind. */
const CAUTION_PER_TURN = 0.06;
const CAUTION_PER_POINT_BEHIND = 0.1;
const MIN_CAUTION = 0.1;

/**
 * Expected damage `unit` would take on `hex` if every enemy attacked it next turn,
 * each moving as far as it can while still being allowed to attack.
 */
function danger(game: Game, unit: Unit, hex: Hex, enemies: Unit[]): number {
  let total = 0;
  for (const e of enemies) {
    const d = Math.max(1, distance(e.pos, hex) - UNIT_SPECS[e.type].attackMove);
    const dice = Math.max(0, attackAt(e.type, d) - game.diceLost(e.type, e.pos, hex));
    total += dice * hitChance(unit.type);
  }
  return total;
}

/**
 * Decide the next thing the current side's AI wants to do. Returns null when its turn is over.
 * It orders the units with the most to gain, moves each to its best position, then attacks.
 */
export function planAction(game: Game): AIAction | null {
  const side = game.current;
  if (game.phase === 'orders') return { kind: 'orders', units: chooseOrders(game) };

  if (game.phase === 'move') {
    const unit = game.unitsOf(side).find((u) => game.isOrdered(u) && !u.done);
    if (!unit) return { kind: 'endMovement' };
    unit.done = true;
    const best = bestPosition(game, unit, false);
    return { kind: 'move', unit, dest: eq(best.hex, unit.pos) ? null : best.hex };
  }

  for (const unit of game.unitsOf(side)) {
    if (!game.isOrdered(unit) || unit.done) continue;
    unit.done = true;
    let target: Unit | null = null;
    let targetVal = 0;
    for (const t of game.attackTargets(unit)) {
      const v = targetValue(game, unit, t, unit.pos);
      if (v > targetVal) {
        targetVal = v;
        target = t;
      }
    }
    if (target) return { kind: 'attack', unit, target };
    // With nothing to shoot, infantry on wire clears it instead.
    if (game.canClearObstacle(unit)) return { kind: 'clear', unit };
  }
  return null;
}

/** Carry out `action` instantly (no animation), as a headless game or test does. */
export function applyAction(game: Game, action: AIAction): void {
  switch (action.kind) {
    case 'orders':
      return game.giveOrders(action.units);
    case 'move':
      if (action.dest) game.moveUnit(action.unit, action.dest);
      return;
    case 'endMovement':
      return game.endMovement();
    case 'attack':
      game.attack(action.unit, action.target);
      resolveRetreat(game);
      return;
    case 'clear':
      return game.clearObstacle(action.unit);
  }
}

/** Settle any pending retreat with the AI deciding for the retreating unit (used when both sides are AI). */
export function resolveRetreat(game: Game): void {
  while (game.pendingRetreat) {
    if (game.pendingRetreat.ignorable > 0) game.ignoreFlags(flagsToIgnore(game));
    else game.retreatTo(retreatHex(game));
  }
}

/** Flags the AI ignores for its retreating unit: all it can, keeping the protection it has there. */
export function flagsToIgnore(game: Game): number {
  return game.pendingRetreat?.ignorable ?? 0;
}

/** Where the AI's retreating unit steps next: the option where it is in least danger, then in best cover. */
export function retreatHex(game: Game): Hex {
  const unit = game.pendingRetreat!.unit;
  const enemies = game.unitsOf(other(unit.side));
  const safety = (h: Hex) => {
    const cover = TERRAIN[game.map.terrain(h)!].protection;
    return -danger(game, unit, h, enemies) + (cover.infantry + cover.armour) / 4;
  };
  return game.retreatOptions().reduce((a, b) => (safety(b) > safety(a) ? b : a));
}

/** Expected damage plus a bonus for the chance of destroying the target. */
function targetValue(game: Game, unit: Unit, target: Unit, from: Hex): number {
  const f = game.forecast(unit, target, from);
  return f.dealt + f.killChance * 3;
}

/**
 * The units with the best move-and-attack available. (Ranking by the gain over standing idle
 * instead played worse: it favours moving units up over using units already well placed.)
 */
function chooseOrders(game: Game): Unit[] {
  return game
    .unitsOf(game.current)
    .map((u) => ({ u, score: bestPosition(game, u, true).score }))
    .sort((a, b) => b.score - a.score)
    .slice(0, ORDERS_PER_TURN)
    .map((o) => o.u);
}

/**
 * The best hex for `unit` to move to this turn, scored on the attack it could make from there,
 * closing with the enemy, cover and danger.
 */
function bestPosition(game: Game, unit: Unit, planning: boolean): { score: number; hex: Hex } {
  const side = game.current;
  const foe = other(side);
  const enemies = game.unitsOf(foe);
  // Aggression grows through the game, and faster when behind on score.
  const behind = Math.max(0, game.score(foe) - game.score(side));
  const caution = Math.max(MIN_CAUTION, 1 - CAUTION_PER_TURN * game.turn - CAUTION_PER_POINT_BEHIND * behind);

  const reach = game.reachable(unit, planning);
  const candidates = [...reach.values()]
    .map((r) => r.hex)
    .filter((h) => eq(h, unit.pos) || !game.unitAt(h));

  let best = { score: -Infinity, hex: unit.pos };
  for (const hex of candidates) {
    const spaces = game.spacesMoved(unit) + reach.get(key(hex))!.cost;
    let score = 0;

    // Combat value of the best target available from this hex.
    let attack = 0;
    for (const t of game.targetsFrom(unit, hex, spaces)) attack = Math.max(attack, targetValue(game, unit, t, hex));
    score += attack * ATTACK_WEIGHT;

    // Closing with / keeping away from the enemy. Artillery can't move and fire, so it settles
    // where it will have 2-3 dice next turn while staying out of infantry reach.
    const dEnemy = enemies.length ? Math.min(...enemies.map((e) => distance(hex, e.pos))) : 0;
    if (unit.type === 'artillery') {
      score -= Math.abs(dEnemy - 4) * 0.6;
    } else {
      score -= dEnemy * (unit.type === 'armour' ? 0.8 : 0.7) * CLOSE_WEIGHT;
    }

    // Cover from terrain or an obstacle (they don't add together), averaged over the attackers it affects.
    const obstacle = game.map.obstacles.get(key(hex));
    const terrainCover = TERRAIN[game.map.terrain(hex)!].protection;
    const obstacleCover = obstacle ? OBSTACLES[obstacle.kind].protection : terrainCover;
    const cover = Math.max(terrainCover.infantry + terrainCover.armour, obstacleCover.infantry + obstacleCover.armour) / 2;
    score += cover * TERRAIN_WEIGHT * caution;

    // Danger: expected damage from enemy attacks next turn (forest, hills and villages reduce it).
    const fragile = 1 + (1 - hpFrac(unit)) * 1.25 + (unit.type === 'artillery' ? 0.5 : 0);
    score -= danger(game, unit, hex, enemies) * DANGER_WEIGHT * fragile * caution;

    score += game.rand() * 0.4;
    if (score > best.score) best = { score, hex };
  }
  return best;
}
