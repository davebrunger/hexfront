import './style.css';
import { planAction, type AIAction } from './ai';
import { MAX_TURNS, OBSTACLES, ORDERS_PER_TURN, SIDE_NAMES, TERRAIN, UNIT_SPECS, hpFrac, rangeOf } from './data';
import { Game, other } from './game';
import { PRESET_MAPS } from './map';
import { eq, key } from './hex';
import { EMPTY_OVERLAY, Renderer, sleep, type Overlay } from './render';
import type { Hex, Obstacle, Side, Terrain, Unit, UnitType } from './types';

/** The side the player commands; the AI plays the other. */
let human: Side = 'allied';
const aiSide = () => other(human);

const $ = <T extends HTMLElement>(id: string): T => {
  const node = document.getElementById(id);
  if (!node) throw new Error(`#${id} missing`);
  return node as T;
};

const svg = document.getElementById('map') as unknown as SVGSVGElement;
const renderer = new Renderer(svg);

let game: Game;
let selected: Unit | null = null;
let hover: Hex | null = null;
let busy = false;

// ------------------------------------------------------------------ setup

function newSeed(): number {
  return Math.floor(Math.random() * 1_000_000) + 1;
}

/**
 * Start a game on the preset map with id `mapId` (a random map when it is empty), with the
 * player commanding `side`.
 */
function startGame(seed: number, mapId = '', side: Side = 'allied'): void {
  const preset = PRESET_MAPS.find((m) => m.id === mapId);
  game = new Game(seed, preset);
  human = side;
  $<HTMLSelectElement>('map-select').value = preset?.id ?? '';
  $<HTMLSelectElement>('side-select').value = side;
  selected = null;
  hover = null;
  busy = false;
  $('overlay').hidden = true;
  const url = new URL(location.href);
  url.searchParams.set('seed', String(seed));
  if (preset) url.searchParams.set('map', preset.id);
  else url.searchParams.delete('map');
  url.searchParams.set('side', side);
  history.replaceState(null, '', url);
  renderer.load(game);
  refresh();
  if (game.current === human) phaseBanner();
  else void runAI();
}

/** Start a new game with the map and side chosen in the panel. */
function startChosenGame(): void {
  startGame(newSeed(), $<HTMLSelectElement>('map-select').value, $<HTMLSelectElement>('side-select').value as Side);
}

// ----------------------------------------------------------------- helpers

function overlayState(path: Hex[] = []): Overlay {
  if (game.winner || game.current !== human) return EMPTY_OVERLAY;
  if (!selected || selected.side !== human) return EMPTY_OVERLAY;
  const targets = game.attackTargets(selected).map((t) => ({ hex: t.pos, ...game.forecast(selected!, t) }));
  return {
    selected: selected.pos,
    moves: game.moveTargets(selected).map((r) => ({
      hex: r.hex,
      canAttack: game.spacesMoved(selected!) + r.cost <= UNIT_SPECS[selected!.type].attackMove,
    })),
    targets,
    path,
  };
}

function refresh(path: Hex[] = []): void {
  renderer.update(overlayState(path));
  renderPanel();
}

let bannerTimer = 0;
function banner(text: string, side: Side = human): void {
  const b = $('banner');
  b.textContent = text;
  b.className = `show ${side}`;
  clearTimeout(bannerTimer);
  bannerTimer = window.setTimeout(() => (b.className = ''), 1400);
}

const PHASE_NAMES = { orders: 'Orders', move: 'Movement', attack: 'Attack' } as const;

/** Announce the phase that has just begun, e.g. "Axis Movement Phase". */
function phaseBanner(): void {
  banner(`${SIDE_NAMES[game.current]} ${PHASE_NAMES[game.phase]} Phase`, game.current);
}

function select(u: Unit | null): void {
  selected = u;
  refresh();
}

function readyUnits(): Unit[] {
  return game.unitsOf(human).filter((u) => game.isReady(u));
}

// ------------------------------------------------------------------ panel

function renderPanel(): void {
  const mine = game.current === human;
  $('turn-label').textContent = `Turn ${game.turn} / ${MAX_TURNS}`;
  const pill = $('side-label');
  pill.textContent = mine ? 'Your move' : 'Enemy move';
  pill.className = `side-pill ${game.current}`;
  $('forces').textContent = `${game.unitsOf(human).length} v ${game.unitsOf(aiSide()).length}`;
  $('score').textContent = `${game.score(human)} v ${game.score(aiSide())}`;
  const button = $('end-turn') as HTMLButtonElement;
  button.disabled = !mine || busy || !!game.winner;
  const label = { orders: 'Confirm orders', move: 'End movement', attack: 'End turn' }[game.phase];
  button.innerHTML = `${label} <kbd>Space</kbd>`;
  $('phase-hint').textContent = !mine
    ? ''
    : game.phase === 'orders'
      ? `Orders: click up to ${ORDERS_PER_TURN} units to order them (${game.ordered.size}/${ORDERS_PER_TURN}).`
      : game.phase === 'move'
        ? 'Movement: move your ordered units one at a time. Moving another unit ends the last one\'s move.'
        : 'Attack: attack with your ordered units, one at a time.';

  renderInspect();
  renderLog();
}

/** One-line summaries of an obstacle's rules for the inspect panel. */
function obstacleNotes(kind: Obstacle['kind']): string[] {
  const o = OBSTACLES[kind];
  const dice = (d: Record<UnitType, number>) =>
    (Object.keys(d) as UnitType[]).filter((u) => d[u]).map((u) => `${UNIT_SPECS[u].name} −${d[u]}`).join(', ');
  const names = (types: UnitType[]) => types.map((u) => UNIT_SPECS[u].name).join(', ');
  const notes: string[] = [];
  if (o.stopsMove) notes.push('Stops movement');
  if (dice(o.protection)) notes.push(`Attacks on it: ${dice(o.protection)} (not added to terrain cover)`);
  if (dice(o.attackPenalty)) notes.push(`Attacks from it: ${dice(o.attackPenalty)}`);
  if (o.removedWhenLeft) notes.push('Removed when a unit leaves');
  if (o.clearedOnEntryBy.length) notes.push(`${names(o.clearedOnEntryBy)} clear it on entering`);
  if (o.clearedInsteadOfAttackBy.length) notes.push(`${names(o.clearedInsteadOfAttackBy)} can clear it instead of attacking`);
  return notes;
}

/** One-line summaries of a terrain type's rules for the inspect panel. */
function terrainNotes(t: Terrain): string[] {
  const ti = TERRAIN[t];
  if (!ti.passable) return [ti.sight === 'contiguous' ? 'Impassable; two adjacent hexes block sight' : 'Impassable'];
  const dice = (d: Record<UnitType, number>) =>
    (Object.keys(d) as UnitType[]).filter((u) => d[u]).map((u) => `${UNIT_SPECS[u].name} −${d[u]}`).join(', ');
  const notes: string[] = [];
  if (ti.stopsMove) notes.push('Stops movement');
  if (ti.noAttackAfterEntering) notes.push('No attack after moving in');
  if (ti.landEntryOnly) notes.push('Enter from land only');
  if (dice(ti.protection)) notes.push(`Attacks on it: ${dice(ti.protection)}${ti.high ? ' (unless from a hill)' : ''}`);
  if (dice(ti.attackPenalty)) notes.push(`Attacks from it: ${dice(ti.attackPenalty)}`);
  if (ti.sight === 'blocks') notes.push(ti.high ? 'Blocks sight, except hill to hill' : 'Blocks sight');
  return notes.length ? notes : ['No effect'];
}

function statRow(label: string, value: string | number): string {
  return `<div><span class="k">${label}</span><b>${value}</b></div>`;
}

function renderInspect(): void {
  const box = $('inspect');
  const h = hover ?? selected?.pos ?? null;
  if (!h || !game.map.has(h)) {
    box.innerHTML = '<p class="hint">Hover over the map to inspect terrain and units.</p>';
    return;
  }
  const t = game.map.terrain(h)!;
  const ti = TERRAIN[t];
  const obstacle = game.map.obstacles.get(key(h));
  let html = `<div class="terrain-line"><b>${ti.name}</b></div><div class="muted small">${terrainNotes(t).join(' · ')}</div>`;
  if (obstacle) {
    html += `<div class="terrain-line"><b>${OBSTACLES[obstacle.kind].name}</b></div><div class="muted small">${obstacleNotes(obstacle.kind).join(' · ')}</div>`;
  }
  const u = game.unitAt(h);
  if (u) {
    const s = UNIT_SPECS[u.type];
    const status =
      u.side !== game.current
        ? 'waiting'
        : game.phase === 'orders'
          ? game.isOrdered(u) ? 'ordered' : 'not ordered'
          : !game.isOrdered(u)
            ? 'not ordered'
            : u.attacked
              ? 'has attacked'
              : game.phase === 'move'
                ? u.mp > 0 ? `${u.mp} move left` : 'moved'
                : 'ready to attack';
    html += `<div class="unit-card ${u.side}">
      <div class="uc-head"><span class="swatch ${u.side}"></span><b>${s.name}</b><span class="muted">${SIDE_NAMES[u.side]} · ${u.side === human ? 'yours' : 'enemy'} · ${status}</span></div>
      <div class="bar-wrap"><div class="bar-fill ${hpFrac(u) <= 0.35 ? 'low' : hpFrac(u) <= 0.7 ? 'mid' : ''}" style="width:${hpFrac(u) * 100}%"></div></div>
      <div class="statgrid">${statRow('Strength', `${u.hp}/${s.maxHp}`)}${statRow('Move', s.attackMove === s.move ? s.move : `${s.attackMove} + attack, or ${s.move}`)}${statRow('Attack', s.attack.join(' / '))}${statRow('Range', rangeOf(u.type))}</div>
      <p class="muted small">${s.blurb}</p></div>`;
    if (u === selected && canHumanClear(u)) {
      html += `<button id="clear-obstacle" type="button">Clear the wire instead of attacking <kbd>C</kbd></button>`;
    }
  }
  box.innerHTML = html;
}

function renderLog(): void {
  const ol = $('log');
  ol.replaceChildren();
  for (const e of game.log.slice(-14).reverse()) {
    const li = document.createElement('li');
    li.className = e.side ?? '';
    li.textContent = `T${e.turn} · ${e.text}`;
    ol.appendChild(li);
  }
}

// ------------------------------------------------------------ game actions

async function doMove(u: Unit, dest: Hex): Promise<void> {
  busy = true;
  const path = game.moveUnit(u, dest);
  renderer.update(EMPTY_OVERLAY);
  renderPanel();
  await renderer.animateMove(u, path);
  busy = false;
}

async function doAttack(u: Unit, target: Unit): Promise<void> {
  busy = true;
  renderer.update(EMPTY_OVERLAY);
  const res = game.attack(u, target);
  await renderer.animateCombat(res);
  busy = false;
}

/** Carry out an AI action with the same animations a player's actions get. Returns whether anything visible happened. */
async function execute(action: AIAction): Promise<boolean> {
  switch (action.kind) {
    case 'orders':
      game.giveOrders(action.units);
      phaseBanner();
      break;
    case 'move':
      if (!action.dest) return false;
      await doMove(action.unit, action.dest);
      break;
    case 'endMovement':
      game.endMovement();
      phaseBanner();
      break;
    case 'attack':
      await doAttack(action.unit, action.target);
      break;
    case 'clear':
      game.clearObstacle(action.unit);
      break;
  }
  refresh();
  return action.kind !== 'move' || action.dest !== null;
}

function canHumanClear(u: Unit): boolean {
  return !busy && !game.winner && game.current === human && u.side === human && game.canClearObstacle(u);
}

function clearSelectedObstacle(): void {
  if (!selected || !canHumanClear(selected)) return;
  game.clearObstacle(selected);
  selected = null;
  refresh();
}

function checkGameOver(): boolean {
  if (!game.winner) return false;
  const title = game.winner === 'draw' ? 'A draw' : game.winner === human ? 'Victory!' : 'Defeat';
  $('overlay-title').textContent = title;
  $('overlay-title').className = game.winner === 'draw' ? '' : game.winner === human ? 'win' : 'lose';
  $('overlay-text').textContent = game.winReason;
  setTimeout(() => ($('overlay').hidden = false), 600);
  return true;
}

async function runAI(): Promise<void> {
  busy = true;
  refresh();
  phaseBanner();
  await sleep(900);
  while (!game.winner && game.current === aiSide()) {
    const action = planAction(game);
    if (!action) break;
    const shown = await execute(action);
    busy = true;
    // Give phase announcements time to be read before the next action.
    await sleep(!shown ? 0 : action.kind === 'orders' || action.kind === 'endMovement' ? 900 : 220);
  }
  if (!game.winner) {
    game.endTurn();
    if (!game.winner) phaseBanner();
  }
  busy = false;
  selected = null;
  refresh();
  checkGameOver();
}

/** The main button: confirm orders, end movement, or end the turn, depending on the phase. */
async function endTurn(): Promise<void> {
  if (busy || game.winner || game.current !== human) return;
  if (game.phase === 'orders') {
    game.confirmOrders();
    phaseBanner();
    refresh();
    return;
  }
  if (game.phase === 'move') {
    game.endMovement();
    phaseBanner();
    selected = selected && game.isReady(selected) ? selected : null;
    refresh();
    return;
  }
  selected = null;
  game.endTurn();
  refresh();
  if (checkGameOver()) return;
  await runAI();
}

// ----------------------------------------------------------------- input

async function onHexClick(h: Hex): Promise<void> {
  if (busy || game.winner || game.current !== human) return;

  const clicked = game.unitAt(h);
  if (game.phase === 'orders') {
    if (clicked && clicked.side === human) game.toggleOrder(clicked);
    select(null);
    return;
  }
  if (selected && selected.side === human) {
    const u = selected;
    if (clicked && clicked.side !== human && game.attackTargets(u).includes(clicked)) {
      await doAttack(u, clicked);
      selected = null;
      refresh();
      checkGameOver();
      return;
    }
    if (!clicked && game.moveTargets(u).some((r) => eq(r.hex, h))) {
      await doMove(u, h);
      const keepSelected = game.canMove(u);
      selected = keepSelected ? u : null;
      refresh();
      checkGameOver();
      return;
    }
  }
  if (clicked && clicked.side === human && clicked !== selected) select(clicked);
  else select(null);
}

svg.addEventListener('click', (e) => {
  const h = renderer.hexFromEvent(e);
  if (h) void onHexClick(h);
});

svg.addEventListener('mousemove', (e) => {
  const h = renderer.hexFromEvent(e);
  if (h && hover && eq(h, hover)) return;
  hover = h;
  renderer.setHover(h);
  if (busy) return;
  // Preview the route for the selected unit.
  if (h && selected && selected.side === human && game.current === human && !game.winner) {
    const reach = game.reachable(selected);
    if (reach.has(key(h)) && !game.unitAt(h)) {
      refresh(game.pathTo(reach, h));
      return;
    }
  }
  refresh();
});

svg.addEventListener('mouseleave', () => {
  hover = null;
  renderer.setHover(null);
  if (!busy) refresh();
});

$('end-turn').addEventListener('click', () => void endTurn());
$('new-game').addEventListener('click', () => {
  if (busy) return;
  startChosenGame();
});
$('overlay-new').addEventListener('click', startChosenGame);
$('inspect').addEventListener('click', (e) => {
  if ((e.target as Element).closest('#clear-obstacle')) clearSelectedObstacle();
});

window.addEventListener('keydown', (e) => {
  if ((e.target instanceof HTMLButtonElement || e.target instanceof HTMLSelectElement) && e.key === ' ') return; // let focused controls keep Space
  if (e.key === 'Escape') {
    if (!busy) select(null);
  } else if (e.key === ' ' || e.key === 'Enter') {
    e.preventDefault();
    void endTurn();
  } else if (e.key === 'c' || e.key === 'C') {
    clearSelectedObstacle();
  } else if ((e.key === 'n' || e.key === 'N') && !busy && game.current === human && !game.winner) {
    const list = readyUnits();
    if (!list.length) return;
    const i = selected ? list.indexOf(selected) : -1;
    select(list[(i + 1) % list.length]);
  }
});

for (const m of PRESET_MAPS) $('map-select').append(new Option(m.name, m.id));
const params = new URLSearchParams(location.search);
const seedParam = Number(params.get('seed'));
const sideParam = params.get('side') === 'axis' ? 'axis' : 'allied';
startGame(Number.isFinite(seedParam) && seedParam > 0 ? seedParam : newSeed(), params.get('map') ?? '', sideParam);
