import { TERRAIN, UNIT_SPECS, hpFrac } from './data';
import { distance, eq } from './hex';
import { other, type Game } from './game';
import type { Hex, Unit } from './types';

export interface AIPlan {
  unit: Unit;
  dest: Hex | null;
  target: Unit | null;
}

const value = (u: Unit) => UNIT_SPECS[u.type].value / 6;

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

  const reach = game.reachable(unit);
  const candidates = [...reach.values()]
    .map((r) => r.hex)
    .filter((h) => eq(h, unit.pos) || !game.unitAt(h));

  let best: { score: number; hex: Hex; target: Unit | null } | null = null;
  for (const hex of candidates) {
    const moved = !eq(hex, unit.pos);
    let score = 0;

    // Combat value of the best target available from this hex.
    let target: Unit | null = null;
    let targetVal = -Infinity;
    for (const t of game.targetsFrom(unit, hex, moved || unit.moved)) {
      const f = game.forecast(unit, t, hex);
      const v = f.dealt * value(t) + (f.kills ? value(t) * 3 : 0) - f.taken * value(unit) * 0.8;
      if (v > targetVal) {
        targetVal = v;
        target = t;
      }
    }
    if (target && targetVal > 0) score += targetVal * 2;
    else target = null;

    const terrain = game.map.terrain(hex)!;
    score += (TERRAIN[terrain].defence - 1) * 3;

    // Closing with / keeping away from the enemy.
    const dEnemy = enemies.length ? Math.min(...enemies.map((e) => distance(hex, e.pos))) : 0;
    if (unit.type === 'artillery') {
      score -= Math.abs(dEnemy - 2.5) * 0.9;
      if (dEnemy <= 1) score -= 3;
    } else {
      score -= dEnemy * (unit.type === 'armour' ? 0.8 : 0.7);
    }

    // Danger: enemies that could reach this hex next turn.
    const threat = enemies.filter((e) => distance(e.pos, hex) <= UNIT_SPECS[e.type].move + UNIT_SPECS[e.type].range - 1).length;
    const fragile = 1 + (1 - hpFrac(unit)) * 1.25 + (unit.type === 'artillery' ? 0.8 : 0);
    score -= threat * 0.35 * fragile;

    // Wounded units fall back to heal.
    if (hpFrac(unit) <= 0.4) score += dEnemy * 1.1;

    score += game.rand() * 0.4;
    if (!best || score > best.score) best = { score, hex, target };
  }

  if (!best) return { unit, dest: null, target: null };
  return { unit, dest: eq(best.hex, unit.pos) ? null : best.hex, target: best.target };
}
