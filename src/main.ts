import './style.css';
import { planAction, type AIPlan } from './ai';
import { MAX_TURNS, TERRAIN, UNIT_SPECS, hpFrac, rangeOf } from './data';
import { Game } from './game';
import { eq, key } from './hex';
import { EMPTY_OVERLAY, Renderer, sleep, type Overlay } from './render';
import type { Hex, Side, Unit } from './types';

const HUMAN: Side = 'blue';
const AI_SIDE: Side = 'red';

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

function startGame(seed: number): void {
  game = new Game(seed);
  selected = null;
  hover = null;
  busy = false;
  $('overlay').hidden = true;
  const url = new URL(location.href);
  url.searchParams.set('seed', String(seed));
  history.replaceState(null, '', url);
  renderer.load(game);
  refresh();
  banner('Your turn');
}

// ----------------------------------------------------------------- helpers

function overlayState(path: Hex[] = []): Overlay {
  if (game.winner || game.current !== HUMAN) return EMPTY_OVERLAY;
  if (!selected || selected.side !== HUMAN) return EMPTY_OVERLAY;
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
function banner(text: string, side: Side = HUMAN): void {
  const b = $('banner');
  b.textContent = text;
  b.className = `show ${side}`;
  clearTimeout(bannerTimer);
  bannerTimer = window.setTimeout(() => (b.className = ''), 1400);
}

function select(u: Unit | null): void {
  selected = u;
  refresh();
}

function readyUnits(): Unit[] {
  return game.unitsOf(HUMAN).filter((u) => game.canMove(u) || game.attackTargets(u).length > 0);
}

// ------------------------------------------------------------------ panel

function renderPanel(): void {
  const mine = game.current === HUMAN;
  $('turn-label').textContent = `Turn ${game.turn} / ${MAX_TURNS}`;
  const pill = $('side-label');
  pill.textContent = mine ? 'Your move' : 'Enemy move';
  pill.className = `side-pill ${game.current}`;
  $('forces').textContent = `${game.unitsOf(HUMAN).length} v ${game.unitsOf(AI_SIDE).length}`;
  $('score').textContent = `${game.score(HUMAN)} v ${game.score(AI_SIDE)}`;
  ($('end-turn') as HTMLButtonElement).disabled = !mine || busy || !!game.winner;

  renderInspect();
  renderLog();
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
  let html = `<div class="terrain-line"><b>${ti.name}</b>${ti.diceLost ? `<span class="muted"> −${ti.diceLost} attack die against units here</span>` : ''}</div>${ti.passable ? '' : '<div class="muted small">Impassable</div>'}`;
  const u = game.unitAt(h);
  if (u) {
    const s = UNIT_SPECS[u.type];
    const status = u.side !== game.current ? 'waiting' : u.attacked ? 'has attacked' : u.mp > 0 ? `${u.mp} move left` : 'no moves left';
    html += `<div class="unit-card ${u.side}">
      <div class="uc-head"><span class="swatch ${u.side}"></span><b>${s.name}</b><span class="muted">${u.side === HUMAN ? 'yours' : 'enemy'} · ${status}</span></div>
      <div class="bar-wrap"><div class="bar-fill ${hpFrac(u) <= 0.35 ? 'low' : hpFrac(u) <= 0.7 ? 'mid' : ''}" style="width:${hpFrac(u) * 100}%"></div></div>
      <div class="statgrid">${statRow('Strength', `${u.hp}/${s.maxHp}`)}${statRow('Move', s.attackMove === s.move ? s.move : `${s.attackMove} + attack, or ${s.move}`)}${statRow('Attack', s.attack.join(' / '))}${statRow('Range', rangeOf(u.type))}</div>
      <p class="muted small">${s.blurb}</p></div>`;
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

async function execute(plan: AIPlan): Promise<void> {
  if (plan.dest) await doMove(plan.unit, plan.dest);
  if (plan.target && !game.winner) await doAttack(plan.unit, plan.target);
  refresh();
}

function checkGameOver(): boolean {
  if (!game.winner) return false;
  const title = game.winner === 'draw' ? 'A draw' : game.winner === HUMAN ? 'Victory!' : 'Defeat';
  $('overlay-title').textContent = title;
  $('overlay-title').className = game.winner === 'draw' ? '' : game.winner === HUMAN ? 'win' : 'lose';
  $('overlay-text').textContent = game.winReason;
  setTimeout(() => ($('overlay').hidden = false), 600);
  return true;
}

async function runAI(): Promise<void> {
  busy = true;
  refresh();
  banner('Enemy turn', AI_SIDE);
  await sleep(700);
  while (!game.winner && game.current === AI_SIDE) {
    const plan = planAction(game);
    if (!plan) break;
    await execute(plan);
    busy = true;
    await sleep(!plan.dest && !plan.target ? 0 : 220);
  }
  if (!game.winner) {
    game.endTurn();
    if (!game.winner) banner('Your turn');
  }
  busy = false;
  selected = null;
  refresh();
  checkGameOver();
}

async function endTurn(): Promise<void> {
  if (busy || game.winner || game.current !== HUMAN) return;
  selected = null;
  game.endTurn();
  refresh();
  if (checkGameOver()) return;
  await runAI();
}

// ----------------------------------------------------------------- input

async function onHexClick(h: Hex): Promise<void> {
  if (busy || game.winner || game.current !== HUMAN) return;

  const clicked = game.unitAt(h);
  if (selected && selected.side === HUMAN) {
    const u = selected;
    if (clicked && clicked.side !== HUMAN && game.attackTargets(u).includes(clicked)) {
      await doAttack(u, clicked);
      selected = null;
      refresh();
      checkGameOver();
      return;
    }
    if (!clicked && game.moveTargets(u).some((r) => eq(r.hex, h))) {
      await doMove(u, h);
      const keepSelected = game.canMove(u) || game.attackTargets(u).length > 0;
      selected = keepSelected ? u : null;
      refresh();
      checkGameOver();
      return;
    }
  }
  if (clicked && clicked.side === HUMAN && clicked !== selected) select(clicked);
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
  if (h && selected && selected.side === HUMAN && game.current === HUMAN && !game.winner) {
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
  startGame(newSeed());
});
$('overlay-new').addEventListener('click', () => startGame(newSeed()));

window.addEventListener('keydown', (e) => {
  if (e.target instanceof HTMLButtonElement && e.key === ' ') return; // let focused buttons keep Space
  if (e.key === 'Escape') {
    if (!busy) select(null);
  } else if (e.key === ' ' || e.key === 'Enter') {
    e.preventDefault();
    void endTurn();
  } else if ((e.key === 'n' || e.key === 'N') && !busy && game.current === HUMAN && !game.winner) {
    const list = readyUnits();
    if (!list.length) return;
    const i = selected ? list.indexOf(selected) : -1;
    select(list[(i + 1) % list.length]);
  }
});

const seedParam = Number(new URLSearchParams(location.search).get('seed'));
startGame(Number.isFinite(seedParam) && seedParam > 0 ? seedParam : newSeed());
