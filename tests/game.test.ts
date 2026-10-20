import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { planAction } from '../src/ai';
import { DIE_FACES, MAX_TURNS, attackAt, dieHits, rangeOf } from '../src/data';
import { Game } from '../src/game';
import { distance, eq, key, neighbors } from '../src/hex';
import { MAP_HEIGHT, MAP_WIDTH } from '../src/map';

/** Execute an AI plan without any animation (mirrors what the UI controller does). */
function runPlan(game: Game): boolean {
  const plan = planAction(game);
  if (!plan) return false;
  if (plan.dest) game.moveUnit(plan.unit, plan.dest);
  if (plan.target && !game.winner) game.attack(plan.unit, plan.target);
  return true;
}

function playOut(seed: number): Game {
  const game = new Game(seed);
  let guard = 0;
  while (!game.winner) {
    while (!game.winner && runPlan(game)) assert.ok(++guard < 100000, 'AI loop runaway');
    if (!game.winner) game.endTurn();
  }
  return game;
}

describe('hex maths', () => {
  it('has 6 neighbours at distance 1', () => {
    const n = neighbors({ q: 3, r: -2 });
    assert.equal(n.length, 6);
    for (const h of n) assert.equal(distance({ q: 3, r: -2 }, h), 1);
  });
  it('distance is symmetric and correct on a line', () => {
    assert.equal(distance({ q: 0, r: 0 }, { q: 3, r: 0 }), 3);
    assert.equal(distance({ q: 0, r: 0 }, { q: -2, r: 4 }), 4);
  });
});

describe('map generation', () => {
  it('is point-symmetric and the expected size', () => {
    for (const seed of [1, 2, 3, 42, 777, 12345]) {
      const { map } = new Game(seed);
      assert.equal(map.hexes.length, MAP_WIDTH * MAP_HEIGHT);
      for (const h of map.hexes) {
        const m = map.mirror(h);
        assert.ok(map.has(m), `mirror of ${key(h)} off the board`);
        assert.equal(map.terrain(h), map.terrain(m), `terrain asymmetric at ${key(h)}`);
      }
    }
  });
  it('is deterministic for a seed', () => {
    const a = new Game(99).map;
    const b = new Game(99).map;
    for (const h of a.hexes) assert.equal(a.terrain(h), b.terrain(h));
  });
});

describe('starting position', () => {
  it('places 8 units per side on distinct, passable hexes', () => {
    for (const seed of [1, 5, 8, 21, 314]) {
      const g = new Game(seed);
      assert.equal(g.unitsOf('blue').length, 8);
      assert.equal(g.unitsOf('red').length, 8);
      const keys = new Set(g.units.map((u) => key(u.pos)));
      assert.equal(keys.size, 16);
      for (const u of g.units) assert.notEqual(g.map.terrain(u.pos), 'water');
    }
  });
});

describe('movement', () => {
  it('respects movement points and cannot stop on units', () => {
    const g = new Game(7);
    const u = g.unitsOf('blue')[0];
    for (const r of g.moveTargets(u)) {
      assert.ok(r.cost <= u.mp);
      assert.equal(g.unitAt(r.hex), undefined);
    }
  });
  it('entering forest or hills ends movement for the turn', () => {
    const g = new Game(7);
    const arm = g.unitsOf('blue').find((u) => u.type === 'armour')!;
    g.units = g.units.filter((u) => u === arm);
    const line = [1, 2, 3].map((i) => ({ q: arm.pos.q + i, r: arm.pos.r }));
    for (const h of line) g.map.tiles.set(key(h), 'plain');
    g.map.tiles.set(key(line[0]), 'forest');
    const reach = g.reachable(arm);
    assert.ok(reach.has(key(line[0])));
    assert.equal(reach.get(key(line[1]))?.prev === key(line[0]), false, 'cannot continue through forest');
    g.moveUnit(arm, line[0]);
    assert.equal(arm.mp, 0);
    assert.equal(g.spacesMoved(arm), 1);
    assert.equal(g.canMove(arm), false);
  });
  it('enemy zone of control stops movement', () => {
    const g = new Game(7);
    const mover = g.unitsOf('blue').find((u) => u.type === 'armour')!;
    const enemy = g.unitsOf('red')[0];
    // Drop the enemy two hexes away from the mover on open ground.
    const target = { q: mover.pos.q + 2, r: mover.pos.r };
    g.map.tiles.set(key(target), 'plain');
    for (const n of neighbors(mover.pos)) g.map.tiles.set(key(n), 'plain');
    enemy.pos = target;
    const reach = g.reachable(mover);
    for (const r of reach.values()) {
      if (distance(r.hex, enemy.pos) === 1 && r.prev !== null) {
        // No reachable hex may be *beyond* a ZOC hex: its predecessor must not itself be in ZOC.
        const prev = [...reach.values()].find((x) => key(x.hex) === r.prev)!;
        assert.ok(eq(prev.hex, mover.pos) || !g.inEnemyZoc('blue', prev.hex));
      }
    }
  });
});

describe('combat', () => {
  it('damage equals the dice that hit, with no return fire', () => {
    const g = new Game(3);
    const art = g.unitsOf('blue').find((u) => u.type === 'artillery')!;
    const inf = g.unitsOf('red').find((u) => u.type === 'infantry')!;
    inf.pos = { q: art.pos.q + 1, r: art.pos.r }; // adjacent, well within infantry range
    g.map.tiles.set(key(inf.pos), 'plain');
    const before = inf.hp;
    const artHp = art.hp;
    const res = g.attack(art, inf);
    assert.equal(res.rolls.length, 3);
    const hits = res.rolls.filter((f) => f === 'grenade' || f === 'infantry').length;
    assert.equal(res.dmgToDefender, Math.min(hits, before));
    assert.equal(inf.hp, before - res.dmgToDefender);
    assert.equal(art.hp, artHp);
    assert.equal(art.attacked, true);
  });
  it('dice hit on a grenade or the target type', () => {
    assert.deepEqual(DIE_FACES.filter((f) => dieHits(f, 'infantry')), ['infantry', 'infantry', 'grenade']);
    assert.deepEqual(DIE_FACES.filter((f) => dieHits(f, 'armour')), ['armour', 'grenade']);
    assert.deepEqual(DIE_FACES.filter((f) => dieHits(f, 'artillery')), ['grenade']);
  });
  it('dice fall off with distance and terrain', () => {
    assert.deepEqual([1, 2, 3, 4].map((d) => attackAt('infantry', d)), [3, 2, 1, 0]);
    assert.equal(rangeOf('artillery'), 6);
    const g = new Game(3);
    const art = g.unitsOf('blue').find((u) => u.type === 'artillery')!;
    const inf = g.unitsOf('red').find((u) => u.type === 'infantry')!;
    inf.pos = { q: art.pos.q + 1, r: art.pos.r };
    g.map.tiles.set(key(inf.pos), 'plain');
    const near = g.forecast(art, inf);
    assert.equal(near.dice, 3);
    assert.equal(near.dealt, 1.5);
    assert.equal(g.forecast(art, { ...inf, pos: { q: art.pos.q + 5, r: art.pos.r } }).dice, 1);
    // Terrain costs non-artillery attackers a die.
    const mine = g.unitsOf('blue').find((u) => u.type === 'infantry')!;
    inf.pos = { q: mine.pos.q + 1, r: mine.pos.r };
    g.map.tiles.set(key(inf.pos), 'hills');
    assert.equal(g.forecast(mine, inf).dice, 2);
    inf.pos = { q: mine.pos.q + 3, r: mine.pos.r };
    g.map.tiles.set(key(inf.pos), 'forest');
    assert.equal(g.forecast(mine, inf).dice, 0);
    assert.ok(!g.attackTargets(mine).includes(inf), 'cannot attack with no dice');
  });
  it('limits how far each unit can move and still attack', () => {
    const g = new Game(3);
    const pick = (type: string) => g.unitsOf('blue').find((u) => u.type === type)!;
    const enemy = g.unitsOf('red')[0];
    const near = (u: { pos: { q: number; r: number } }) => {
      enemy.pos = { q: u.pos.q + 1, r: u.pos.r };
      g.map.tiles.set(key(enemy.pos), 'plain');
    };
    const inf = pick('infantry');
    near(inf);
    assert.equal(g.targetsFrom(inf, inf.pos, 1).length > 0, true);
    assert.deepEqual(g.targetsFrom(inf, inf.pos, 2), []);
    const arm = pick('armour');
    near(arm);
    assert.equal(g.targetsFrom(arm, arm.pos, 3).length > 0, true);
    const art = pick('artillery');
    near(art);
    assert.equal(g.targetsFrom(art, art.pos, 0).length > 0, true);
    assert.deepEqual(g.targetsFrom(art, art.pos, 1), []);
  });
  it('artillery ignores terrain dice penalties', () => {
    const g = new Game(3);
    const art = g.unitsOf('blue').find((u) => u.type === 'artillery')!;
    const inf = g.unitsOf('red').find((u) => u.type === 'infantry')!;
    inf.pos = { q: art.pos.q + 1, r: art.pos.r };
    g.map.tiles.set(key(inf.pos), 'hills');
    assert.equal(g.forecast(art, inf).dice, 3);
  });
  it('forecasts the chance to destroy a target', () => {
    const g = new Game(3);
    const a = g.unitsOf('blue').find((u) => u.type === 'armour')!;
    const d = g.unitsOf('red').find((u) => u.type === 'infantry')!;
    d.pos = { q: a.pos.q + 1, r: a.pos.r };
    g.map.tiles.set(key(d.pos), 'plain');
    d.hp = 2;
    // 2 dice, each hitting infantry half the time: both must hit.
    assert.equal(g.forecast(a, d).killChance, 0.25);
    d.hp = 3;
    assert.equal(g.forecast(a, d).killChance, 0);
  });
});

describe('turns and victory', () => {
  it('damaged units do not heal', () => {
    const g = new Game(11);
    const u = g.unitsOf('blue')[0];
    u.hp = 1;
    g.endTurn();
    g.endTurn();
    assert.equal(u.hp, 1);
  });
  it('destroying the last enemy unit wins immediately', () => {
    const g = new Game(11);
    const art = g.unitsOf('blue').find((u) => u.type === 'artillery')!;
    const last = g.unitsOf('red')[0];
    g.units = g.units.filter((u) => u.side === 'blue' || u === last);
    last.pos = { q: art.pos.q + 2, r: art.pos.r };
    g.map.tiles.set(key(last.pos), 'plain');
    last.hp = 1;
    // Dice can miss, so keep firing until the target falls.
    for (let i = 0; i < 100 && !g.winner; i++) {
      art.attacked = false;
      g.attack(art, last);
    }
    assert.equal(g.winner, 'blue');
  });
});

describe('AI vs AI', () => {
  it('finishes full games without errors or illegal moves', () => {
    const results: string[] = [];
    for (const seed of [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]) {
      const g = playOut(seed);
      assert.ok(g.winner);
      assert.ok(g.turn <= MAX_TURNS);
      results.push(`${seed}:${g.winner}@${g.turn}`);
    }
    console.log('AI-vs-AI results ->', results.join('  '));
  });
});
