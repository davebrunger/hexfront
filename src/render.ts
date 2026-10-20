import { hpFrac } from './data';
import type { CombatResult, Game } from './game';
import { cornerPoints, hash2, toPixel } from './hex';
import type { Hex, Terrain, Unit } from './types';

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
  moves: Hex[];
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
  plain: [52, 38, 72],
  forest: [100, 24, 52],
  hills: [38, 34, 62],
  water: [200, 40, 60],
};

export class Renderer {
  private game!: Game;
  private layers!: Record<'terrain' | 'highlight' | 'units' | 'effects' | 'hit', SVGGElement>;
  private hoverEl!: SVGPolygonElement;
  private views = new Map<number, UnitView>();
  private moving = new Set<number>();
  private hexPoints = cornerPoints(SIZE);

  constructor(private svg: SVGSVGElement) {}

  /** (Re)build the whole board for a new game. */
  load(game: Game): void {
    this.game = game;
    this.views.clear();
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

  private tree(g: SVGElement, x: number, y: number, s: number): void {
    el('rect', { x: x - 1, y: y + 2 * s, width: 2, height: 4 * s, class: 'trunk' }, g);
    el('polygon', { points: `${x},${y - 12 * s} ${x - 7 * s},${y} ${x + 7 * s},${y}`, class: 'tree' }, g);
    el('polygon', { points: `${x},${y - 7 * s} ${x - 8 * s},${y + 5 * s} ${x + 8 * s},${y + 5 * s}`, class: 'tree tree-b' }, g);
  }

  private mound(g: SVGElement, x: number, y: number, w: number): void {
    el('path', { d: `M${x - w},${y} Q${x - w * 0.3},${y - w * 1.2} ${x + w * 0.2},${y - w * 0.95} T${x + w},${y} Z`, class: 'mound' }, g);
    el('path', { d: `M${x - w * 0.5},${y - w * 0.25} Q${x - w * 0.15},${y - w * 0.7} ${x + w * 0.2},${y - w * 0.55}`, class: 'mound-hi' }, g);
  }

  // ------------------------------------------------------------- dynamic

  update(o: Overlay): void {
    this.drawHighlights(o);
    this.syncUnits();
  }

  private drawHighlights(o: Overlay): void {
    const layer = this.layers.highlight;
    for (const c of [...layer.children]) if (c !== this.hoverEl) c.remove();
    const poly = (h: Hex, cls: string) => {
      const { x, y } = toPixel(h, SIZE);
      return el('polygon', { points: this.hexPoints, transform: `translate(${x},${y})`, class: cls }, layer);
    };
    for (const h of o.moves) poly(h, 'hl-move');
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
      const ready = current && !u.attacked && u.mp > 0;
      v.dot.style.display = ready ? '' : 'none';
      v.outer.classList.toggle('spent', current && !ready && !this.game.winner);
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
    await sleep(res.defenderDied ? 450 : 120);
  }

  hexFromEvent(e: Event): Hex | null {
    const t = (e.target as Element | null)?.closest?.('.hit-hex');
    if (!t) return null;
    return { q: Number(t.getAttribute('data-q')), r: Number(t.getAttribute('data-r')) };
  }
}
