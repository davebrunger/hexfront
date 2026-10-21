import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { applyAction, planAction } from '../src/ai';
import { DIE_FACES, MAX_TURNS, TERRAIN, attackAt, dieHits, isRiver, rangeOf } from '../src/data';
import { Game } from '../src/game';
import { distance, eq, fromOffset, key, neighbors } from '../src/hex';
import type { Obstacle, Terrain, Unit } from '../src/types';
import { MAP_HEIGHT, MAP_WIDTH, MAP_LETTERS, PRESET_MAPS, parseMap, parseUnits, rowWidth, type MapDef } from '../src/map';

/** A new game with the Allies to move (random maps pick the first side at random). */
function alliedGame(seed: number, mapDef?: MapDef): Game {
  const g = new Game(seed, mapDef);
  if (g.current !== 'allied') g.endTurn();
  return g;
}

/** Order `units` (of the side to move) and skip ahead to the movement or attack phase. */
function readyFor(g: Game, phase: 'move' | 'attack', ...units: Unit[]): void {
  g.giveOrders(units);
  if (phase === 'attack') g.endMovement();
}

/** Execute an AI plan without any animation (mirrors what the UI controller does). */
function runPlan(game: Game): boolean {
  const action = planAction(game);
  if (!action) return false;
  applyAction(game, action);
  return true;
}

function playOut(seed: number): Game {
  const game = alliedGame(seed);
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
      const { map } = alliedGame(seed);
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
      const { map } = alliedGame(seed);
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
      const g = alliedGame(1, def);
      assert.equal(g.map.hexes.length, 5 * 13 + 4 * 12);
      assert.ok(g.unitsOf('allied').length > 0 && g.unitsOf('axis').length > 0);
    }
    const pegasus = alliedGame(1, PRESET_MAPS.find((m) => m.id === 'pegasus-bridge'));
    assert.equal(pegasus.unitsOf('allied').length, 8);
    assert.equal(pegasus.unitsOf('axis').length, 6);
    assert.ok(pegasus.units.every((u) => u.type === 'infantry'));
    assert.equal(pegasus.unitAt(fromOffset(0, 0))?.side, 'axis');
    assert.equal(pegasus.unitAt(fromOffset(8, 8))?.side, 'allied');
    assert.equal(pegasus.map.terrain(fromOffset(3, 2)), 'bridge');
    assert.equal(pegasus.map.terrain(fromOffset(5, 5)), 'water');
    assert.equal(pegasus.map.terrain(fromOffset(0, 8)), 'river');
  });
  it('loads obstacles from preset maps', () => {
    const def = PRESET_MAPS.find((m) => m.id === 'pegasus-bridge')!;
    const { map } = alliedGame(1, def);
    assert.deepEqual(map.obstacles.get(key(fromOffset(5, 2))), { kind: 'wire' });
    assert.deepEqual(map.obstacles.get(key(fromOffset(3, 3))), { kind: 'sandbags', facing: 3 });
    assert.equal(map.obstacles.has(key(fromOffset(0, 0))), false);
    const obstacles = [...def.obstacles!];
    obstacles[0] = '6' + obstacles[0].slice(1);
    assert.throws(() => parseMap({ ...def, obstacles }), /unknown obstacle '6'/);
    assert.equal(alliedGame(1).map.obstacles.size, 0, 'random maps have none');
  });
  it('rejects malformed map definitions', () => {
    const rows = [...PRESET_MAPS[0].rows];
    assert.throws(() => parseMap({ id: 'x', name: 'Short', firstSide: 'allied', rows: rows.slice(1) }), /expected 9 rows/);
    rows[1] = rows[1] + ' .';
    assert.throws(() => parseMap({ id: 'x', name: 'Wide', firstSide: 'allied', rows }), /row 2 should have 12 hexes/);
    rows[1] = rows[1].replace(' .', '').replace('.', 'z');
    assert.throws(() => parseMap({ id: 'x', name: 'Odd', firstSide: 'allied', rows }), /unknown terrain 'z'/);
    const units = [...PRESET_MAPS[0].units!];
    units[0] = units[0].replace('j', 'q');
    assert.throws(() => parseUnits({ ...PRESET_MAPS[0], units }), /unknown unit 'q'/);
    const onRiver = [...PRESET_MAPS[0].units!];
    onRiver[8] = 'i' + onRiver[8].slice(1); // the bottom-left hex is river
    assert.throws(() => alliedGame(1, { ...PRESET_MAPS[0], units: onRiver }), /impassable/);
  });
  it('is deterministic for a seed', () => {
    const a = alliedGame(99).map;
    const b = alliedGame(99).map;
    for (const h of a.hexes) assert.equal(a.terrain(h), b.terrain(h));
  });
});

describe('starting position', () => {
  it('starts the Allies at the bottom and the Axis at the top', () => {
    const g = alliedGame(1);
    for (const u of g.unitsOf('allied')) assert.ok(u.pos.r >= MAP_HEIGHT - 2);
    for (const u of g.unitsOf('axis')) assert.ok(u.pos.r <= 1);
  });
  it('places 8 units per side on distinct, passable hexes', () => {
    for (const seed of [1, 5, 8, 21, 314]) {
      const g = alliedGame(seed);
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
    const g = alliedGame(7);
    const u = g.unitsOf('allied')[0];
    for (const r of g.moveTargets(u)) {
      assert.ok(r.cost <= u.mp);
      assert.equal(g.unitAt(r.hex), undefined);
    }
  });
  it('entering forest or hills ends movement for the turn', () => {
    const g = alliedGame(7);
    const arm = g.unitsOf('allied').find((u) => u.type === 'armour')!;
    g.units = g.units.filter((u) => u === arm);
    readyFor(g, 'move', arm);
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
  it('hills do not stop movement', () => {
    const g = alliedGame(7);
    const arm = g.unitsOf('allied').find((u) => u.type === 'armour')!;
    g.units = [arm];
    readyFor(g, 'move', arm);
    const line = [1, 2, 3].map((i) => ({ q: arm.pos.q + i, r: arm.pos.r }));
    for (const h of line) g.map.tiles.set(key(h), 'plain');
    g.map.tiles.set(key(line[0]), 'hills');
    assert.equal(g.reachable(arm).get(key(line[1]))?.prev, key(line[0]));
    assert.equal(MAP_LETTERS.v, 'village');
  });
  it('bridges can only be entered from land', () => {
    const g = alliedGame(7);
    const inf = g.unitsOf('allied').find((u) => u.type === 'infantry')!;
    g.units = [inf];
    for (const h of g.map.hexes) g.map.tiles.set(key(h), 'plain');
    const a = fromOffset(4, 4);
    const b = fromOffset(5, 4);
    g.map.tiles.set(key(a), 'bridge');
    g.map.tiles.set(key(b), 'bridge');
    inf.pos = a;
    readyFor(g, 'move', inf);
    const reach = g.reachable(inf);
    assert.ok(reach.has(key(b)), 'reachable round by land');
    assert.notEqual(reach.get(key(b))!.prev, key(a), 'not straight from the neighbouring bridge');
  });
  it('enemy zone of control stops movement', () => {
    const g = alliedGame(7);
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
    const g = alliedGame(3);
    const art = g.unitsOf('allied').find((u) => u.type === 'artillery')!;
    const inf = g.unitsOf('axis').find((u) => u.type === 'infantry')!;
    inf.pos = { q: art.pos.q + 1, r: art.pos.r }; // adjacent, well within infantry range
    g.map.tiles.set(key(inf.pos), 'plain');
    const before = inf.hp;
    const artHp = art.hp;
    readyFor(g, 'attack', art);
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
    const g = alliedGame(3);
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
    const g = alliedGame(3);
    const pick = (type: string) => g.unitsOf('allied').find((u) => u.type === type)!;
    const enemy = g.unitsOf('axis')[0];
    const near = (u: { pos: { q: number; r: number } }) => {
      enemy.pos = { q: u.pos.q + 1, r: u.pos.r };
      g.map.tiles.set(key(enemy.pos), 'plain');
      g.map.tiles.set(key(u.pos), 'plain');
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
    const g = alliedGame(3);
    const art = g.unitsOf('allied').find((u) => u.type === 'artillery')!;
    const inf = g.unitsOf('axis').find((u) => u.type === 'infantry')!;
    inf.pos = { q: art.pos.q + 1, r: art.pos.r };
    g.map.tiles.set(key(inf.pos), 'hills');
    assert.equal(g.forecast(art, inf).dice, 3);
  });
  it('forecasts the chance to destroy a target', () => {
    const g = alliedGame(3);
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

describe('terrain combat', () => {
  function board(): Game {
    const g = alliedGame(1);
    for (const h of g.map.hexes) g.map.tiles.set(key(h), 'plain');
    return g;
  }
  const at = (col: number, row: number) => fromOffset(col, row);
  const set = (g: Game, col: number, row: number, t: Terrain) => g.map.tiles.set(key(at(col, row)), t);

  it('forest and villages protect by attacker type', () => {
    const g = board();
    for (const t of ['forest', 'village'] as const) {
      set(g, 5, 4, t);
      assert.equal(g.diceAt('infantry', at(4, 4), at(5, 4)), 2);
      assert.equal(g.diceAt('armour', at(4, 4), at(5, 4)), 0);
      assert.equal(g.diceAt('artillery', at(4, 4), at(5, 4)), 3);
    }
  });
  it('hills protect only against attackers below them', () => {
    const g = board();
    set(g, 5, 4, 'hills');
    assert.equal(g.diceAt('infantry', at(4, 4), at(5, 4)), 2);
    assert.equal(g.diceAt('armour', at(3, 4), at(5, 4)), 1);
    set(g, 4, 4, 'hills');
    assert.equal(g.diceAt('infantry', at(4, 4), at(5, 4)), 3);
  });
  it('armour attacking from a village loses two dice, on top of the target\'s cover', () => {
    const g = board();
    set(g, 4, 4, 'village');
    assert.equal(g.diceAt('armour', at(4, 4), at(5, 4)), 0);
    assert.equal(g.diceAt('infantry', at(4, 4), at(5, 4)), 3);
    set(g, 4, 4, 'plain');
    set(g, 2, 4, 'village');
    set(g, 4, 4, 'hills');
    // Armour in a village (-2) at a hill 2 away (-1): 2 - 3 = no dice, so no attack.
    assert.equal(g.diceAt('armour', at(2, 4), at(4, 4)), 0);
  });
  it('no attack on a turn a unit moved onto forest or a village', () => {
    const g = board();
    const inf = g.unitsOf('allied').find((u) => u.type === 'infantry')!;
    const enemy = g.unitsOf('axis')[0];
    g.units = [inf, enemy];
    inf.pos = at(4, 4);
    enemy.pos = at(5, 4);
    set(g, 4, 4, 'forest');
    assert.ok(g.targetsFrom(inf, inf.pos, 0).includes(enemy), 'can attack if it started there');
    assert.deepEqual(g.targetsFrom(inf, inf.pos, 1), []);
    set(g, 4, 4, 'hills');
    assert.ok(g.targetsFrom(inf, inf.pos, 1).includes(enemy));
  });
});

describe('obstacles', () => {
  /** An all-open board with one Allied infantry and armour and one Axis infantry, and no obstacles. */
  function board() {
    const g = alliedGame(1);
    for (const h of g.map.hexes) g.map.tiles.set(key(h), 'plain');
    const inf = g.unitsOf('allied').find((u) => u.type === 'infantry')!;
    const arm = g.unitsOf('allied').find((u) => u.type === 'armour')!;
    const enemy = g.unitsOf('axis').find((u) => u.type === 'infantry')!;
    g.units = [inf, arm, enemy];
    inf.pos = fromOffset(2, 6);
    arm.pos = fromOffset(8, 6);
    enemy.pos = fromOffset(5, 2);
    return { g, inf, arm, enemy };
  }
  const at = (col: number, row: number) => fromOffset(col, row);
  const put = (g: Game, col: number, row: number, o: Obstacle) => g.map.obstacles.set(key(at(col, row)), o);
  const sandbags: Obstacle = { kind: 'sandbags', facing: 3 };
  const wire: Obstacle = { kind: 'wire' };

  it('sandbags protect against infantry and armour, but not on top of terrain cover', () => {
    const { g } = board();
    put(g, 5, 4, sandbags);
    assert.equal(g.diceAt('infantry', at(4, 4), at(5, 4)), 2);
    assert.equal(g.diceAt('armour', at(4, 4), at(5, 4)), 1);
    assert.equal(g.diceAt('artillery', at(4, 4), at(5, 4)), 3);
    g.map.tiles.set(key(at(5, 4)), 'forest');
    assert.equal(g.diceAt('infantry', at(4, 4), at(5, 4)), 2, 'forest and sandbags: still -1');
    assert.equal(g.diceAt('armour', at(4, 4), at(5, 4)), 0, 'forest -2 is larger than sandbags -1');
    g.map.tiles.set(key(at(5, 4)), 'hills');
    g.map.tiles.set(key(at(4, 4)), 'hills');
    assert.equal(g.diceAt('infantry', at(4, 4), at(5, 4)), 2, 'hill to hill: sandbags still count');
  });
  it('sandbags are removed from every hex a unit leaves', () => {
    const { g, inf } = board();
    put(g, 2, 6, sandbags);
    put(g, 3, 6, sandbags);
    readyFor(g, 'move', inf);
    const path = g.moveUnit(inf, at(4, 6));
    assert.ok(path.some((h) => eq(h, at(3, 6))), 'moved through the second sandbags');
    assert.equal(g.map.obstacles.size, 0);
  });
  it('wire stops movement and armour clears it on entering, still able to attack', () => {
    const { g, inf, arm, enemy } = board();
    put(g, 3, 5, wire);
    readyFor(g, 'move', inf, arm);
    const reach = g.reachable(inf);
    assert.ok(reach.has(key(at(3, 5))));
    assert.ok(![...reach.values()].some((r) => r.prev === key(at(3, 5))), 'cannot move on past wire');
    put(g, 8, 5, wire);
    g.moveUnit(arm, at(8, 5));
    assert.equal(arm.mp, 0);
    assert.equal(g.map.obstacles.has(key(at(8, 5))), false);
    enemy.pos = at(8, 4);
    g.endMovement();
    assert.ok(g.attackTargets(arm).includes(enemy));
  });
  it('infantry on wire roll one die fewer, and may clear it instead of attacking', () => {
    const { g, inf, arm } = board();
    put(g, 2, 6, wire);
    readyFor(g, 'attack', inf, arm);
    assert.equal(g.diceAt('infantry', at(2, 6), at(3, 6)), 2);
    assert.ok(g.canClearObstacle(inf), 'no target needed');
    assert.equal(g.canClearObstacle(arm), false);
    g.clearObstacle(inf);
    assert.equal(g.map.obstacles.size, 0);
    assert.equal(inf.attacked, true);
    put(g, 2, 6, wire);
    assert.equal(g.canClearObstacle(inf), false, 'not after attacking');
  });
});

describe('line of sight', () => {
  /** A game on an all-open board with just one unit per side, `from` attacking `to`. */
  function board(): Game {
    const g = alliedGame(1);
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
  it('between hills is only blocked by units on hills', () => {
    const g = board();
    set(g, 2, 4, 'hills');
    set(g, 6, 4, 'hills');
    set(g, 3, 4, 'forest');
    g.units[1].pos = at(5, 4);
    assert.ok(g.lineOfSight(at(2, 4), at(6, 4)), 'forest and a unit off the hills do not block');
    set(g, 5, 4, 'hills');
    assert.ok(!g.lineOfSight(at(2, 4), at(6, 4)), 'a unit on a hill blocks');
  });
  it('is blocked by two adjacent lake hexes but not by separate ones', () => {
    const g = board();
    set(g, 3, 4, 'water');
    assert.ok(g.lineOfSight(at(1, 4), at(7, 4)));
    set(g, 5, 4, 'water');
    assert.ok(g.lineOfSight(at(1, 4), at(7, 4)));
    set(g, 4, 4, 'water');
    assert.ok(!g.lineOfSight(at(1, 4), at(7, 4)));
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
    readyFor(g, 'attack', inf);
    assert.deepEqual(g.attackTargets(inf), []);
    inf.type = 'artillery';
    assert.deepEqual(g.attackTargets(inf), [enemy]);
  });
});

describe('turn sequence', () => {
  it('only lets up to four ordered units act, in order, move then attack phases', () => {
    const g = alliedGame(3);
    const units = g.unitsOf('allied');
    assert.equal(g.phase, 'orders');
    assert.equal(g.canMove(units[0]), false, 'nothing moves before orders');
    for (const u of units.slice(0, 4)) assert.ok(g.toggleOrder(u));
    assert.equal(g.toggleOrder(units[4]), false, 'a fifth order is refused');
    assert.ok(g.toggleOrder(units[0]), 'unordering frees a slot');
    assert.ok(g.toggleOrder(units[4]));
    g.confirmOrders();
    assert.equal(g.phase, 'move');
    assert.equal(g.canMove(units[0]), false, 'unordered units cannot move');
    assert.ok(g.canMove(units[1]));
    assert.equal(g.toggleOrder(units[0]), false, 'orders are fixed after the order phase');
  });
  it('ends a unit\'s movement once another unit moves', () => {
    const g = alliedGame(3);
    for (const h of g.map.hexes) g.map.tiles.set(key(h), 'plain');
    const [a, b] = g.unitsOf('allied').filter((u) => u.type === 'armour');
    g.units = [a, b, g.unitsOf('axis')[0]];
    g.giveOrders([a, b]);
    g.moveUnit(a, g.moveTargets(a).find((r) => r.cost === 1)!.hex);
    assert.ok(g.canMove(a), 'can keep moving until another unit moves');
    g.moveUnit(b, g.moveTargets(b)[0].hex);
    assert.equal(g.canMove(a), false);
  });
  it('allows attacks only in the attack phase, after movement ends', () => {
    const g = alliedGame(3);
    for (const h of g.map.hexes) g.map.tiles.set(key(h), 'plain');
    const inf = g.unitsOf('allied').find((u) => u.type === 'infantry')!;
    const enemy = g.unitsOf('axis')[0];
    g.units = [inf, enemy];
    enemy.pos = { q: inf.pos.q + 1, r: inf.pos.r };
    g.giveOrders([inf]);
    assert.deepEqual(g.attackTargets(inf), [], 'no attacks during movement');
    g.endMovement();
    assert.equal(g.phase, 'attack');
    assert.equal(g.canMove(inf), false, 'no moves during attacks');
    assert.deepEqual(g.attackTargets(inf), [enemy]);
  });
});

describe('first side', () => {
  it('follows the preset map, and is random on generated maps', () => {
    const pegasus = new Game(1, PRESET_MAPS.find((m) => m.id === 'pegasus-bridge'));
    assert.equal(pegasus.firstSide, 'allied');
    assert.equal(pegasus.current, 'allied');
    const firsts = new Set([1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((seed) => new Game(seed).firstSide));
    assert.deepEqual([...firsts].sort(), ['allied', 'axis']);
    assert.equal(new Game(5).firstSide, new Game(5).firstSide, 'the same seed gives the same first side');
    assert.throws(() => new Game(1, { ...PRESET_MAPS[0], firstSide: 'red' as never }), /firstSide/);
  });
  it('counts rounds from the first side, ending after the second side\'s last turn', () => {
    const seed = [1, 2, 3, 4, 5, 6, 7, 8].find((s) => new Game(s).firstSide === 'axis')!;
    const g = new Game(seed);
    g.endTurn();
    assert.equal(g.current, 'allied');
    assert.equal(g.turn, 1);
    g.endTurn();
    assert.equal(g.current, 'axis');
    assert.equal(g.turn, 2);
    g.turn = MAX_TURNS;
    g.endTurn();
    assert.equal(g.winner, null, 'the Allies still get their last turn');
    g.endTurn();
    assert.notEqual(g.winner, null);
  });
});

describe('turns and victory', () => {
  it('damaged units do not heal', () => {
    const g = alliedGame(11);
    const u = g.unitsOf('allied')[0];
    u.hp = 1;
    g.endTurn();
    g.endTurn();
    assert.equal(u.hp, 1);
  });
  it('destroying the last enemy unit wins immediately', () => {
    const g = alliedGame(11);
    const art = g.unitsOf('allied').find((u) => u.type === 'artillery')!;
    const last = g.unitsOf('axis')[0];
    g.units = g.units.filter((u) => u.side === 'allied' || u === last);
    last.pos = { q: art.pos.q + 2, r: art.pos.r };
    g.map.tiles.set(key(last.pos), 'plain');
    last.hp = 1;
    readyFor(g, 'attack', art);
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
