import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { planAction } from '../src/ai';
import { DIE_FACES, MAX_TURNS, TERRAIN, attackAt, dieHits, isRiver, rangeOf } from '../src/data';
import { Game } from '../src/game';
import { distance, eq, fromOffset, key, neighbors } from '../src/hex';
import type { Terrain } from '../src/types';
import { MAP_HEIGHT, MAP_WIDTH, MAP_LETTERS, PRESET_MAPS, parseMap, parseUnits, rowWidth } from '../src/map';

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
      assert.equal(map.hexes.length, 5 * 13 + 4 * 12);
      for (let r = 0; r < MAP_HEIGHT; r++) {
        assert.equal(map.hexes.filter((h) => h.r === r).length, r % 2 ? 12 : 13);
        assert.equal(rowWidth(r), r % 2 ? MAP_WIDTH - 1 : MAP_WIDTH);
      }
      for (const h of map.hexes) {
        const m = map.mirror(h);
        assert.ok(map.has(m), `mirror of ${key(h)} off the board`);
        assert.equal(map.terrain(h), map.terrain(m), `terrain asymmetric at ${key(h)}`);
      }
    }
  });
  it('draws rivers as clean lines from edge to edge, with bridges', () => {
    for (let seed = 1; seed <= 50; seed++) {
      const { map } = new Game(seed);
      const river = map.hexes.filter((h) => isRiver(map.terrain(h)));
      if (!river.length) continue;
      let ends = 0;
      for (const h of river) {
        const links = neighbors(h).filter((n) => isRiver(map.terrain(n))).length;
        assert.ok(links === 1 || links === 2, `river hex ${key(h)} has ${links} river neighbours (seed ${seed})`);
        if (links === 1) {
          ends++;
          assert.ok(neighbors(h).some((n) => !map.has(n)), `river end ${key(h)} is not on the map edge`);
        }
      }
      assert.equal(ends, 2);
      assert.ok(river.some((h) => map.terrain(h) === 'bridge'), `seed ${seed} has no bridge`);
      assert.equal(TERRAIN.river.passable, false);
      assert.equal(TERRAIN.bridge.passable, true);
    }
  });
  it('loads every preset map from config', () => {
    assert.ok(PRESET_MAPS.some((m) => m.name === 'Pegasus Bridge'));
    for (const def of PRESET_MAPS) {
      const g = new Game(1, def);
      assert.equal(g.map.hexes.length, 5 * 13 + 4 * 12);
      assert.ok(g.unitsOf('allied').length > 0 && g.unitsOf('axis').length > 0);
    }
    const pegasus = new Game(1, PRESET_MAPS.find((m) => m.id === 'pegasus-bridge'));
    assert.equal(pegasus.unitsOf('allied').length, 8);
    assert.equal(pegasus.unitsOf('axis').length, 6);
    assert.ok(pegasus.units.every((u) => u.type === 'infantry'));
    assert.equal(pegasus.unitAt(fromOffset(0, 0))?.side, 'axis');
    assert.equal(pegasus.unitAt(fromOffset(8, 8))?.side, 'allied');
    assert.equal(pegasus.map.terrain(fromOffset(3, 2)), 'bridge');
    assert.equal(pegasus.map.terrain(fromOffset(5, 5)), 'water');
    assert.equal(pegasus.map.terrain(fromOffset(0, 8)), 'river');
  });
  it('rejects malformed map definitions', () => {
    const rows = [...PRESET_MAPS[0].rows];
    assert.throws(() => parseMap({ id: 'x', name: 'Short', rows: rows.slice(1) }), /expected 9 rows/);
    rows[1] = rows[1] + ' .';
    assert.throws(() => parseMap({ id: 'x', name: 'Wide', rows }), /row 2 should have 12 hexes/);
    rows[1] = rows[1].replace(' .', '').replace('.', 'z');
    assert.throws(() => parseMap({ id: 'x', name: 'Odd', rows }), /unknown terrain 'z'/);
    const units = [...PRESET_MAPS[0].units!];
    units[0] = units[0].replace('j', 'q');
    assert.throws(() => parseUnits({ ...PRESET_MAPS[0], units }), /unknown unit 'q'/);
    const onRiver = [...PRESET_MAPS[0].units!];
    onRiver[8] = 'i' + onRiver[8].slice(1); // the bottom-left hex is river
    assert.throws(() => new Game(1, { ...PRESET_MAPS[0], units: onRiver }), /impassable/);
  });
  it('is deterministic for a seed', () => {
    const a = new Game(99).map;
    const b = new Game(99).map;
    for (const h of a.hexes) assert.equal(a.terrain(h), b.terrain(h));
  });
});

describe('starting position', () => {
  it('starts the Allies at the bottom and the Axis at the top', () => {
    const g = new Game(1);
    for (const u of g.unitsOf('allied')) assert.ok(u.pos.r >= MAP_HEIGHT - 2);
    for (const u of g.unitsOf('axis')) assert.ok(u.pos.r <= 1);
  });
  it('places 8 units per side on distinct, passable hexes', () => {
    for (const seed of [1, 5, 8, 21, 314]) {
      const g = new Game(seed);
      assert.equal(g.unitsOf('allied').length, 8);
      assert.equal(g.unitsOf('axis').length, 8);
      const keys = new Set(g.units.map((u) => key(u.pos)));
      assert.equal(keys.size, 16);
      for (const u of g.units) assert.ok(TERRAIN[g.map.terrain(u.pos)!].passable);
    }
  });
});

describe('movement', () => {
  it('respects movement points and cannot stop on units', () => {
    const g = new Game(7);
    const u = g.unitsOf('allied')[0];
    for (const r of g.moveTargets(u)) {
      assert.ok(r.cost <= u.mp);
      assert.equal(g.unitAt(r.hex), undefined);
    }
  });
  it('entering forest or hills ends movement for the turn', () => {
    const g = new Game(7);
    const arm = g.unitsOf('allied').find((u) => u.type === 'armour')!;
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
  it('villages play like forest', () => {
    assert.deepEqual({ ...TERRAIN.village, name: '' }, { ...TERRAIN.forest, name: '' });
    assert.equal(MAP_LETTERS.v, 'village');
  });
  it('enemy zone of control stops movement', () => {
    const g = new Game(7);
    const mover = g.unitsOf('allied').find((u) => u.type === 'armour')!;
    const enemy = g.unitsOf('axis')[0];
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
        assert.ok(eq(prev.hex, mover.pos) || !g.inEnemyZoc('allied', prev.hex));
      }
    }
  });
});

describe('combat', () => {
  it('damage equals the dice that hit, with no return fire', () => {
    const g = new Game(3);
    const art = g.unitsOf('allied').find((u) => u.type === 'artillery')!;
    const inf = g.unitsOf('axis').find((u) => u.type === 'infantry')!;
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
    const art = g.unitsOf('allied').find((u) => u.type === 'artillery')!;
    const inf = g.unitsOf('axis').find((u) => u.type === 'infantry')!;
    inf.pos = { q: art.pos.q + 1, r: art.pos.r };
    g.map.tiles.set(key(inf.pos), 'plain');
    const near = g.forecast(art, inf);
    assert.equal(near.dice, 3);
    assert.equal(near.dealt, 1.5);
    assert.equal(g.forecast(art, { ...inf, pos: { q: art.pos.q + 5, r: art.pos.r } }).dice, 1);
    // Terrain costs non-artillery attackers a die.
    const mine = g.unitsOf('allied').find((u) => u.type === 'infantry')!;
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
    const pick = (type: string) => g.unitsOf('allied').find((u) => u.type === type)!;
    const enemy = g.unitsOf('axis')[0];
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
    const art = g.unitsOf('allied').find((u) => u.type === 'artillery')!;
    const inf = g.unitsOf('axis').find((u) => u.type === 'infantry')!;
    inf.pos = { q: art.pos.q + 1, r: art.pos.r };
    g.map.tiles.set(key(inf.pos), 'hills');
    assert.equal(g.forecast(art, inf).dice, 3);
  });
  it('forecasts the chance to destroy a target', () => {
    const g = new Game(3);
    const a = g.unitsOf('allied').find((u) => u.type === 'armour')!;
    const d = g.unitsOf('axis').find((u) => u.type === 'infantry')!;
    d.pos = { q: a.pos.q + 1, r: a.pos.r };
    g.map.tiles.set(key(d.pos), 'plain');
    d.hp = 2;
    // 2 dice, each hitting infantry half the time: both must hit.
    assert.equal(g.forecast(a, d).killChance, 0.25);
    d.hp = 3;
    assert.equal(g.forecast(a, d).killChance, 0);
  });
});

describe('line of sight', () => {
  /** A game on an all-open board with just one unit per side, `from` attacking `to`. */
  function board(): Game {
    const g = new Game(1);
    for (const h of g.map.hexes) g.map.tiles.set(key(h), 'plain');
    g.units = [g.unitsOf('allied').find((u) => u.type === 'infantry')!, g.unitsOf('axis')[0]];
    return g;
  }
  const at = (col: number, row: number) => fromOffset(col, row);
  const set = (g: Game, col: number, row: number, t: Terrain) => g.map.tiles.set(key(at(col, row)), t);

  it('is clear across open ground and blocked by units and forest', () => {
    const g = board();
    assert.ok(g.lineOfSight(at(2, 4), at(6, 4)));
    set(g, 4, 4, 'forest');
    assert.ok(!g.lineOfSight(at(2, 4), at(6, 4)));
    set(g, 4, 4, 'village');
    assert.ok(!g.lineOfSight(at(2, 4), at(6, 4)));
    set(g, 4, 4, 'plain');
    g.units[1].pos = at(5, 4);
    assert.ok(!g.lineOfSight(at(2, 4), at(6, 4)));
  });
  it('ignores terrain in the attacker and target hexes, and rivers and bridges', () => {
    const g = board();
    set(g, 2, 4, 'forest');
    set(g, 6, 4, 'village');
    set(g, 3, 4, 'river');
    set(g, 4, 4, 'bridge');
    assert.ok(g.lineOfSight(at(2, 4), at(6, 4)));
  });
  it('lets hills be seen across only from hill to hill', () => {
    const g = board();
    set(g, 4, 4, 'hills');
    assert.ok(!g.lineOfSight(at(2, 4), at(6, 4)));
    set(g, 2, 4, 'hills');
    assert.ok(!g.lineOfSight(at(2, 4), at(6, 4)));
    set(g, 6, 4, 'hills');
    assert.ok(g.lineOfSight(at(2, 4), at(6, 4)));
  });
  it('is blocked by two lake hexes but not one', () => {
    const g = board();
    set(g, 3, 4, 'water');
    assert.ok(g.lineOfSight(at(1, 4), at(6, 4)));
    set(g, 4, 4, 'water');
    assert.ok(!g.lineOfSight(at(1, 4), at(6, 4)));
  });
  it('along a hex edge is only blocked by obstructions on both sides', () => {
    const g = board();
    // The line from (4,2) to (4,4) runs along the edge between (3,3) and (4,3).
    set(g, 3, 3, 'forest');
    assert.ok(g.lineOfSight(at(4, 2), at(4, 4)));
    set(g, 4, 3, 'forest');
    assert.ok(!g.lineOfSight(at(4, 2), at(4, 4)));
  });
  it('treats the half hexes at the side edges as obstructions', () => {
    const g = board();
    // Along the left edge, the line from (0,2) to (0,4) has the off-board half hex on one side.
    assert.ok(g.lineOfSight(at(0, 2), at(0, 4)));
    set(g, 0, 3, 'forest');
    assert.ok(!g.lineOfSight(at(0, 2), at(0, 4)));
  });
  it('limits targets for all units except artillery', () => {
    const g = board();
    const [inf, enemy] = g.units;
    inf.pos = at(2, 4);
    enemy.pos = at(4, 4);
    set(g, 3, 4, 'forest');
    assert.deepEqual(g.attackTargets(inf), []);
    inf.type = 'artillery';
    assert.deepEqual(g.attackTargets(inf), [enemy]);
  });
});

describe('turns and victory', () => {
  it('damaged units do not heal', () => {
    const g = new Game(11);
    const u = g.unitsOf('allied')[0];
    u.hp = 1;
    g.endTurn();
    g.endTurn();
    assert.equal(u.hp, 1);
  });
  it('destroying the last enemy unit wins immediately', () => {
    const g = new Game(11);
    const art = g.unitsOf('allied').find((u) => u.type === 'artillery')!;
    const last = g.unitsOf('axis')[0];
    g.units = g.units.filter((u) => u.side === 'allied' || u === last);
    last.pos = { q: art.pos.q + 2, r: art.pos.r };
    g.map.tiles.set(key(last.pos), 'plain');
    last.hp = 1;
    // Dice can miss, so keep firing until the target falls.
    for (let i = 0; i < 100 && !g.winner; i++) {
      art.attacked = false;
      g.attack(art, last);
    }
    assert.equal(g.winner, 'allied');
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
