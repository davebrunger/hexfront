import { hpFrac, isRiver } from './data';
import type { CombatResult, Game } from './game';
import { DIRS, cornerPoints, hash2, key, toPixel } from './hex';
import type { Hex, Obstacle, Terrain, Unit } from './types';

export const SIZE = 34;
const NS = 'http://www.w3.org/2000/svg';

type Attrs = Record<string, string | number>;

function el<K extends keyof SVGElementTagNameMap>(
  tag: K,
  attrs: Attrs = {},
  parent?: Element,
): SVGElementTagNameMap[K] {
  const node = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, String(v));
  parent?.appendChild(node);
  return node;
}

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export interface Overlay {
  selected: Hex | null;
  /** Hexes the unit can move to, and whether it could still attack from there. */
  moves: { hex: Hex; canAttack: boolean }[];
  targets: { hex: Hex; dice: number; dealt: number; killChance: number }[];
  path: Hex[];
}

export const EMPTY_OVERLAY: Overlay = { selected: null, moves: [], targets: [], path: [] };

interface UnitView {
  outer: SVGGElement;
  body: SVGGElement;
  badge: SVGTextElement;
  bar: SVGRectElement;
  dot: SVGCircleElement;
}

const TERRAIN_FILL: Record<Terrain, [number, number, number]> = {
  plain: [88, 40, 62],
  forest: [100, 24, 52],
  village: [52, 26, 64],
  hills: [38, 34, 62],
  water: [200, 40, 60],
  // River hexes are grass with the river drawn over them.
  river: [88, 40, 62],
  bridge: [88, 40, 62],
};

export class Renderer {
  private game!: Game;
  private layers!: Record<'terrain' | 'highlight' | 'units' | 'effects' | 'hit', SVGGElement>;
  private hoverEl!: SVGPolygonElement;
  private views = new Map<number, UnitView>();
  private obstacleViews = new Map<string, SVGGElement>();
  private moving = new Set<number>();
  private hexPoints = cornerPoints(SIZE);

  constructor(private svg: SVGSVGElement) {}

  /** (Re)build the whole board for a new game. */
  load(game: Game): void {
    this.game = game;
    this.views.clear();
    this.obstacleViews.clear();
    this.moving.clear();
    this.svg.replaceChildren();

    const pts = game.map.hexes.map((h) => toPixel(h, SIZE));
    const pad = SIZE * 1.1;
    const minX = Math.min(...pts.map((p) => p.x)) - pad;
    const maxX = Math.max(...pts.map((p) => p.x)) + pad;
    const minY = Math.min(...pts.map((p) => p.y)) - pad;
    const maxY = Math.max(...pts.map((p) => p.y)) + pad;
    this.svg.setAttribute('viewBox', `${minX} ${minY} ${maxX - minX} ${maxY - minY}`);

    this.buildDefs();
    el('rect', { x: minX, y: minY, width: maxX - minX, height: maxY - minY, class: 'sea' }, this.svg);
    const mk = (cls: string) => el('g', { class: cls }, this.svg);
    this.layers = {
      terrain: mk('layer-terrain'),
      highlight: mk('layer-highlight'),
      units: mk('layer-units'),
      effects: mk('layer-effects'),
      hit: mk('layer-hit'),
    };

    for (const h of game.map.hexes) this.drawTile(h, game.map.terrain(h)!);
    for (const h of game.map.hexes) {
      const obstacle = game.map.obstacles.get(key(h));
      if (obstacle) this.drawObstacle(h, obstacle);
    }
    // paper grain over the terrain
    el('rect', { x: minX, y: minY, width: maxX - minX, height: maxY - minY, class: 'grain', filter: 'url(#paper)' }, this.layers.terrain);

    this.hoverEl = el('polygon', { points: this.hexPoints, class: 'hl-hover', visibility: 'hidden' }, this.layers.highlight);
    for (const h of game.map.hexes) {
      const { x, y } = toPixel(h, SIZE);
      el('polygon', { points: this.hexPoints, transform: `translate(${x},${y})`, class: 'hit-hex', 'data-q': h.q, 'data-r': h.r }, this.layers.hit);
    }
    this.update(EMPTY_OVERLAY);
  }

  private buildDefs(): void {
    const defs = el('defs', {}, this.svg);
    const f = el('filter', { id: 'paper', x: 0, y: 0, width: '100%', height: '100%' }, defs);
    el('feTurbulence', { type: 'fractalNoise', baseFrequency: 0.85, numOctaves: 2, seed: 7, result: 'n' }, f);
    el('feColorMatrix', { in: 'n', type: 'matrix', values: '0 0 0 0 0.25  0 0 0 0 0.18  0 0 0 0 0.08  0 0 0 0.9 -0.28' }, f);
    const sh = el('filter', { id: 'drop', x: '-20%', y: '-20%', width: '150%', height: '160%' }, defs);
    el('feDropShadow', { dx: 1, dy: 2, stdDeviation: 1.4, 'flood-color': '#000', 'flood-opacity': 0.45 }, sh);
  }

  // ------------------------------------------------------------ terrain art

  private drawTile(h: Hex, t: Terrain): void {
    const { x, y } = toPixel(h, SIZE);
    const g = el('g', { transform: `translate(${x},${y})` }, this.layers.terrain);
    const [hue, sat, lig] = TERRAIN_FILL[t];
    const v = hash2(h.q, h.r);
    const poly = el('polygon', { points: this.hexPoints, class: `tile tile-${t}` }, g);
    poly.style.fill = `hsl(${hue + (v - 0.5) * 6}, ${sat}%, ${lig + (v - 0.5) * 7}%)`;

    const j = (salt: number, amt: number) => (hash2(h.q, h.r, salt) - 0.5) * amt;
    switch (t) {
      case 'forest': {
        const spots: [number, number, number][] = [[-12, 7, 1], [11, 6, 0.95], [0, -6, 1.1], [-1, 12, 0.8]];
        spots.forEach(([px, py, s], i) => this.tree(g, px + j(i, 4), py + j(i + 9, 3), s));
        break;
      }
      case 'village': {
        const spots: [number, number][] = [[-10, 7], [9, 9], [0, -7]];
        spots.forEach(([px, py], i) => this.house(g, px + j(i, 4), py + j(i + 9, 3)));
        break;
      }
      case 'hills':
        this.mound(g, -9 + j(1, 4), 6 + j(2, 3), 14);
        this.mound(g, 10 + j(3, 4), 3 + j(4, 3), 11);
        this.mound(g, -1 + j(5, 3), -9 + j(6, 3), 10);
        break;
      case 'water':
        for (let i = 0; i < 3; i++) {
          const yy = -10 + i * 11 + j(i, 3);
          el('path', { d: `M${-15 + j(i + 4, 5)},${yy} q4,-4 8,0 t8,0 t8,0`, class: 'wave' }, g);
        }
        break;
      case 'river':
      case 'bridge':
        this.river(g, h, t === 'bridge');
        break;
      default:
        if (hash2(h.q, h.r, 3) > 0.55) {
          for (let i = 0; i < 3; i++) {
            const gx = -14 + hash2(h.q, h.r, 10 + i) * 28;
            const gy = -12 + hash2(h.q, h.r, 20 + i) * 24;
            el('path', { d: `M${gx},${gy} l-1.5,-4 M${gx},${gy} l0,-5 M${gx},${gy} l1.5,-4`, class: 'tuft' }, g);
          }
        }
    }
    el('polygon', { points: this.hexPoints, class: 'grid' }, g);
  }

  /**
   * Draw the river through `h`: from the centre to the edge facing each neighbouring river hex.
   * A river end with only one river neighbour runs off the nearest map edge instead.
   */
  private river(g: SVGElement, h: Hex, bridge: boolean): void {
    const map = this.game.map;
    const at = (d: Hex) => ({ q: h.q + d.q, r: h.r + d.r });
    const ends = DIRS.filter((d) => isRiver(map.terrain(at(d))));
    if (ends.length < 2) {
      const flow = ends[0] ? toPixel(ends[0], 1) : { x: 0, y: 0 };
      const offMap = DIRS.filter((d) => !map.has(at(d))).sort((a, b) => {
        const pa = toPixel(a, 1);
        const pb = toPixel(b, 1);
        return pa.x * flow.x + pa.y * flow.y - (pb.x * flow.x + pb.y * flow.y);
      });
      ends.push(...offMap.slice(0, 2 - ends.length));
    }
    const pts = ends.map((d) => {
      const p = toPixel(d, SIZE);
      return { x: p.x / 2, y: p.y / 2 };
    });
    const d =
      pts.length === 2
        ? `M${pts[0].x},${pts[0].y} Q0,0 ${pts[1].x},${pts[1].y}`
        : pts.map((p) => `M0,0 L${p.x},${p.y}`).join(' ');
    el('path', { d, class: 'river-bank' }, g);
    el('path', { d, class: 'river' }, g);
    if (bridge && pts.length >= 2) {
      const angle = (Math.atan2(pts[1].y - pts[0].y, pts[1].x - pts[0].x) * 180) / Math.PI;
      const b = el('g', { transform: `rotate(${angle})` }, g);
      el('rect', { x: -7, y: -14, width: 14, height: 28, rx: 1.5, class: 'bridge-deck' }, b);
      for (const x of [-7, 7]) el('line', { x1: x, y1: -15, x2: x, y2: 15, class: 'bridge-rail' }, b);
    }
  }

  private drawObstacle(h: Hex, o: Obstacle): void {
    const { x, y } = toPixel(h, SIZE);
    const g = el('g', { transform: `translate(${x},${y})`, class: 'obstacle' }, this.layers.terrain);
    this.obstacleViews.set(key(h), g);
    if (o.kind === 'wire') {
      // A coil of wire across the hex, on two stakes, with a few barbs.
      for (const sx of [-17, 17]) el('line', { x1: sx, y1: -9, x2: sx, y2: 9, class: 'wire-stake' }, g);
      for (let i = 0; i < 7; i++) el('ellipse', { cx: -15 + i * 5, cy: 0, rx: 4.2, ry: 7, class: 'wire' }, g);
      for (let i = 0; i < 4; i++) {
        const bx = -12 + i * 8;
        el('path', { d: `M${bx - 1.5},-8.5 l3,3 M${bx + 1.5},-8.5 l-3,3 M${bx - 1.5},5.5 l3,3 M${bx + 1.5},5.5 l-3,3`, class: 'wire-barb' }, g);
      }
      return;
    }
    // Sandbags along the two edges either side of corner `facing` (0 = top, clockwise), set just inside the hex.
    const corner = (i: number) => {
      const a = (Math.PI / 180) * (60 * (((i % 6) + 6) % 6) - 30);
      return { x: SIZE * 0.84 * Math.cos(a), y: SIZE * 0.84 * Math.sin(a) };
    };
    const v = o.facing + 5;
    for (const [a, b] of [[corner(v - 1), corner(v)], [corner(v), corner(v + 1)]]) {
      const angle = (Math.atan2(b.y - a.y, b.x - a.x) * 180) / Math.PI;
      const bags = 4;
      for (let i = 0; i < bags; i++) {
        const t = (i + 0.5) / bags;
        const bx = a.x + (b.x - a.x) * t;
        const by = a.y + (b.y - a.y) * t;
        el('rect', { x: -4, y: -3, width: 8, height: 6, rx: 2.6, transform: `translate(${bx},${by}) rotate(${angle})`, class: 'sandbag' }, g);
      }
    }
  }

  private tree(g: SVGElement, x: number, y: number, s: number): void {
    el('rect', { x: x - 1, y: y + 2 * s, width: 2, height: 4 * s, class: 'trunk' }, g);
    el('polygon', { points: `${x},${y - 12 * s} ${x - 7 * s},${y} ${x + 7 * s},${y}`, class: 'tree' }, g);
    el('polygon', { points: `${x},${y - 7 * s} ${x - 8 * s},${y + 5 * s} ${x + 8 * s},${y + 5 * s}`, class: 'tree tree-b' }, g);
  }

  private house(g: SVGElement, x: number, y: number): void {
    el('rect', { x: x - 7, y: y - 4, width: 14, height: 9, class: 'house-wall' }, g);
    el('polygon', { points: `${x - 9},${y - 3} ${x},${y - 11} ${x + 9},${y - 3}`, class: 'house-roof' }, g);
    el('rect', { x: x - 1.5, y: y, width: 3, height: 5, class: 'house-door' }, g);
  }

  private mound(g: SVGElement, x: number, y: number, w: number): void {
    el('path', { d: `M${x - w},${y} Q${x - w * 0.3},${y - w * 1.2} ${x + w * 0.2},${y - w * 0.95} T${x + w},${y} Z`, class: 'mound' }, g);
    el('path', { d: `M${x - w * 0.5},${y - w * 0.25} Q${x - w * 0.15},${y - w * 0.7} ${x + w * 0.2},${y - w * 0.55}`, class: 'mound-hi' }, g);
  }

  // ------------------------------------------------------------- dynamic

  update(o: Overlay): void {
    this.drawHighlights(o);
    this.syncObstacles();
    this.syncUnits();
  }

  /** Remove the graphics of obstacles that have been cleared. */
  private syncObstacles(): void {
    for (const [k, g] of this.obstacleViews) {
      if (this.game.map.obstacles.has(k)) continue;
      g.remove();
      this.obstacleViews.delete(k);
    }
  }

  private drawHighlights(o: Overlay): void {
    const layer = this.layers.highlight;
    for (const c of [...layer.children]) if (c !== this.hoverEl) c.remove();
    const poly = (h: Hex, cls: string) => {
      const { x, y } = toPixel(h, SIZE);
      return el('polygon', { points: this.hexPoints, transform: `translate(${x},${y})`, class: cls }, layer);
    };
    for (const m of o.moves) poly(m.hex, m.canAttack ? 'hl-move' : 'hl-move hl-move-only');
    if (o.path.length && o.selected) {
      const pts = [o.selected, ...o.path].map((h) => {
        const p = toPixel(h, SIZE);
        return `${p.x},${p.y}`;
      });
      el('polyline', { points: pts.join(' '), class: 'hl-path' }, layer);
    }
    if (o.selected) poly(o.selected, 'hl-selected');
    for (const t of o.targets) {
      poly(t.hex, 'hl-attack');
      const { x, y } = toPixel(t.hex, SIZE);
      const g = el('g', { transform: `translate(${x},${y - 26})`, class: 'forecast' }, layer);
      const kill = t.killChance >= 0.01 ? ` · ${Math.round(t.killChance * 100)}% ☠` : '';
      const label = `${t.dice}🎲 −${t.dealt.toFixed(1)}${kill}`;
      const w = label.length * 6 + 10;
      el('rect', { x: -w / 2, y: -8, width: w, height: 15, rx: 4 }, g);
      const txt = el('text', { x: 0, y: 3 }, g);
      txt.textContent = label;
    }
    // keep hover above fills
    layer.appendChild(this.hoverEl);
  }

  setHover(h: Hex | null): void {
    if (!h) {
      this.hoverEl.setAttribute('visibility', 'hidden');
      return;
    }
    const { x, y } = toPixel(h, SIZE);
    this.hoverEl.setAttribute('transform', `translate(${x},${y})`);
    this.hoverEl.setAttribute('visibility', 'visible');
  }

  // ---------------------------------------------------------------- units

  private createView(u: Unit): UnitView {
    const outer = el('g', { class: `unit ${u.side} ${u.type}` }, this.layers.units);
    const body = el('g', { class: 'unit-body' }, outer);
    el('rect', { x: -21, y: -15, width: 42, height: 30, rx: 3.5, class: 'counter-shadow', transform: 'translate(1.5,2.5)' }, body);
    el('rect', { x: -21, y: -15, width: 42, height: 30, rx: 3.5, class: 'counter' }, body);
    el('rect', { x: -14.5, y: -9, width: 29, height: 18, rx: 1.5, class: 'symbol-box' }, body);
    if (u.type === 'infantry') {
      el('path', { d: 'M-14.5,-9 L14.5,9 M14.5,-9 L-14.5,9', class: 'symbol' }, body);
    } else if (u.type === 'armour') {
      el('ellipse', { cx: 0, cy: 0, rx: 10, ry: 5.5, class: 'symbol' }, body);
    } else {
      el('circle', { cx: 0, cy: 0, r: 4.2, class: 'symbol fill' }, body);
    }
    el('rect', { x: -21, y: 18, width: 42, height: 4.5, rx: 1.5, class: 'bar-bg' }, body);
    const bar = el('rect', { x: -21, y: 18, width: 42, height: 4.5, rx: 1.5, class: 'bar' }, body);
    el('circle', { cx: 21, cy: -15, r: 8.5, class: 'badge' }, body);
    const badge = el('text', { x: 21, y: -11.6, class: 'badge-text' }, body);
    const dot = el('circle', { cx: -21, cy: -15, r: 4.2, class: 'ready-dot' }, body);
    const view = { outer, body, badge, bar, dot };
    this.place(view, u.pos);
    return view;
  }

  private place(v: UnitView, h: Hex): void {
    const { x, y } = toPixel(h, SIZE);
    v.outer.style.transform = `translate(${x}px, ${y}px)`;
  }

  syncUnits(): void {
    const alive = new Set(this.game.units.map((u) => u.id));
    for (const [id, v] of this.views) {
      if (alive.has(id)) continue;
      this.views.delete(id);
      v.outer.classList.add('dying');
      setTimeout(() => v.outer.remove(), 650);
    }
    for (const u of this.game.units) {
      let v = this.views.get(u.id);
      if (!v) {
        v = this.createView(u);
        this.views.set(u.id, v);
      }
      if (!this.moving.has(u.id)) this.place(v, u.pos);
      v.badge.textContent = String(u.hp);
      v.bar.setAttribute('width', String(42 * hpFrac(u)));
      v.bar.classList.toggle('mid', hpFrac(u) <= 0.7 && hpFrac(u) > 0.35);
      v.bar.classList.toggle('low', hpFrac(u) <= 0.35);
      const current = u.side === this.game.current;
      const ready = this.game.isReady(u);
      v.dot.style.display = ready ? '' : 'none';
      v.outer.classList.toggle('ordered', this.game.isOrdered(u));
      v.outer.classList.toggle('spent', current && !ready && !this.game.winner && this.game.phase !== 'orders');
    }
    // keep nearer rows drawn on top
    const order = [...this.views.entries()].sort((a, b) => {
      const ua = this.game.units.find((u) => u.id === a[0])!;
      const ub = this.game.units.find((u) => u.id === b[0])!;
      return ua.pos.r - ub.pos.r;
    });
    for (const [, v] of order) this.layers.units.appendChild(v.outer);
  }

  async animateMove(u: Unit, path: Hex[]): Promise<void> {
    const v = this.views.get(u.id);
    if (!v) return;
    this.moving.add(u.id);
    this.layers.units.appendChild(v.outer);
    for (const h of path) {
      this.place(v, h);
      await sleep(150);
    }
    this.moving.delete(u.id);
  }

  private float(h: Hex, text: string, cls: string): void {
    const { x, y } = toPixel(h, SIZE);
    const t = el('text', { x, y: y - 14, class: `float ${cls}` }, this.layers.effects);
    t.textContent = text;
    setTimeout(() => t.remove(), 1300);
  }

  private lunge(v: UnitView, from: Hex, to: Hex): Promise<void> {
    const a = toPixel(from, SIZE);
    const b = toPixel(to, SIZE);
    const len = Math.hypot(b.x - a.x, b.y - a.y) || 1;
    v.body.style.transform = `translate(${((b.x - a.x) / len) * 9}px, ${((b.y - a.y) / len) * 9}px)`;
    return sleep(110).then(() => {
      v.body.style.transform = '';
    });
  }

  private shell(from: Hex, to: Hex): void {
    const a = toPixel(from, SIZE);
    const b = toPixel(to, SIZE);
    const line = el('line', { x1: a.x, y1: a.y, x2: b.x, y2: b.y, class: 'tracer' }, this.layers.effects);
    const burst = el('circle', { cx: b.x, cy: b.y, r: 6, class: 'burst' }, this.layers.effects);
    setTimeout(() => {
      line.remove();
      burst.remove();
    }, 600);
  }

  async animateCombat(res: CombatResult): Promise<void> {
    const a = this.views.get(res.attacker.id);
    const d = this.views.get(res.defender.id);
    const ap = res.attacker.pos;
    const dp = res.defender.pos;
    if (res.ranged) {
      this.shell(ap, dp);
      await sleep(260);
    } else if (a) {
      await this.lunge(a, ap, dp);
    }
    d?.body.classList.add('hit');
    this.float(dp, res.dmgToDefender ? `−${res.dmgToDefender}` : 'miss', 'dmg');
    this.syncUnits();
    await sleep(380);
    d?.body.classList.remove('hit');
    if (res.defenderDied) this.float(dp, '✖', 'kill');
    else if (res.flags) {
      await sleep(200);
      this.float(dp, '⚑'.repeat(res.flags), 'flag');
    }
    await sleep(res.defenderDied ? 450 : 120);
  }

  hexFromEvent(e: Event): Hex | null {
    const t = (e.target as Element | null)?.closest?.('.hit-hex');
    if (!t) return null;
    return { q: Number(t.getAttribute('data-q')), r: Number(t.getAttribute('data-r')) };
  }
}
