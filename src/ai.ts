import { TERRAIN, UNIT_SPECS, attackAt, hitChance, hpFrac } from './data';
import { distance, eq, key } from './hex';
import { other, type Game } from './game';
import type { Hex, Unit } from './types';

export interface AIPlan {
  unit: Unit;
  dest: Hex | null;
  target: Unit | null;
}

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
 * Decide the next thing the current side's AI wants to do. Returns null when it has nothing left.
 * The plan is executed through the same Game methods a human uses, so the AI has no special powers.
 */
export function planAction(game: Game): AIPlan | null {
  const side = game.current;
  const foe = other(side);

  const unit = game.unitsOf(side).find((u) => !u.done);
  if (!unit) return null;
  unit.done = true;

  const enemies = game.unitsOf(foe);
  // Aggression grows through the game, and faster when behind on score.
  const behind = Math.max(0, game.score(foe) - game.score(side));
  const caution = Math.max(MIN_CAUTION, 1 - CAUTION_PER_TURN * game.turn - CAUTION_PER_POINT_BEHIND * behind);

  const reach = game.reachable(unit);
  const candidates = [...reach.values()]
    .map((r) => r.hex)
    .filter((h) => eq(h, unit.pos) || !game.unitAt(h));

  let best: { score: number; hex: Hex; target: Unit | null } | null = null;
  for (const hex of candidates) {
    const spaces = game.spacesMoved(unit) + reach.get(key(hex))!.cost;
    let score = 0;

    // Combat value of the best target available from this hex.
    let target: Unit | null = null;
    let targetVal = -Infinity;
    for (const t of game.targetsFrom(unit, hex, spaces)) {
      const f = game.forecast(unit, t, hex);
      const v = f.dealt + f.killChance * 3;
      if (v > targetVal) {
        targetVal = v;
        target = t;
      }
    }
    if (target && targetVal > 0) score += targetVal * ATTACK_WEIGHT;
    else target = null;

    // Closing with / keeping away from the enemy. Artillery can't move and fire, so it settles
    // where it will have 2-3 dice next turn while staying out of infantry reach.
    const dEnemy = enemies.length ? Math.min(...enemies.map((e) => distance(hex, e.pos))) : 0;
    if (unit.type === 'artillery') {
      score -= Math.abs(dEnemy - 4) * 0.6;
    } else {
      score -= dEnemy * (unit.type === 'armour' ? 0.8 : 0.7) * CLOSE_WEIGHT;
    }

    // Forest and hills cost most attackers a die, so hold them.
    const cover = TERRAIN[game.map.terrain(hex)!].protection;
    score += ((cover.infantry + cover.armour) / 2) * TERRAIN_WEIGHT * caution;

    // Danger: expected damage from enemy attacks next turn (forest, hills and villages reduce it).
    const fragile = 1 + (1 - hpFrac(unit)) * 1.25 + (unit.type === 'artillery' ? 0.5 : 0);
    score -= danger(game, unit, hex, enemies) * DANGER_WEIGHT * fragile * caution;

    score += game.rand() * 0.4;
    if (!best || score > best.score) best = { score, hex, target };
  }

  if (!best) return { unit, dest: null, target: null };
  return { unit, dest: eq(best.hex, unit.pos) ? null : best.hex, target: best.target };
}
