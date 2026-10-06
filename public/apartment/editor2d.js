// Top-down floor plan editor on a <canvas>. Works with mouse, pen and touch:
// one finger drags things (or pans on empty space), two fingers pan and zoom.
//
// The editor owns a working copy of the layout and mutates it while you drag.
// It reports finished edits through `onCommit(layout)` and selection changes
// through `onSelect(selection)`.
import {
  DEFAULTS,
  clamp,
  formatArea,
  formatLength,
  newLocalId,
  pointInPolygon,
  polygonArea,
  polygonCentroid,
  projectOnWall,
  wallEndExtensions,
  wallFrame,
  wallLength,
  bounds,
} from './model.js';

const HIT = 10; // touch/click tolerance in CSS pixels
const SNAP = 12;
const DRAG_START = 5;
const same = (p, q) => Math.abs(p[0] - q[0]) < 1e-6 && Math.abs(p[1] - q[1]) < 1e-6;
const round = (v, step) => Math.round(Math.round(v / step) * step * 1000) / 1000;
const dist = (p, q) => Math.hypot(p[0] - q[0], p[1] - q[1]);

export class PlanEditor {
  constructor(canvas, { onCommit, onSelect, onTool, onCalibrate, readOnly = false }) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.onCommit = onCommit;
    this.onSelect = onSelect;
    this.onTool = onTool;
    this.onCalibrate = onCalibrate;
    this.readOnly = readOnly;
    this.layout = null;
    this.tool = 'select';
    this.selection = null; // { type: 'wall'|'opening'|'room', id }
    this.view = { zoom: 50, x: 0, y: 0 }; // CSS px per metre; world point at the canvas origin
    this.pointers = new Map();
    this.gesture = null;
    this.draft = null; // wall/room being drawn: { points: [...], cursor }
    this.hover = null;
    this.image = null; // HTMLImageElement of the background floor plan
    this.colors = {};
    this.fitted = false;
    this.insetBottom = 0;

    this.resize = this.resize.bind(this);
    this.observer = new ResizeObserver(this.resize);
    this.observer.observe(canvas);
    canvas.addEventListener('pointerdown', (e) => this.pointerDown(e));
    canvas.addEventListener('pointermove', (e) => this.pointerMove(e));
    canvas.addEventListener('pointerup', (e) => this.pointerUp(e));
    canvas.addEventListener('pointercancel', (e) => this.pointerUp(e, true));
    canvas.addEventListener('pointerleave', () => {
      this.hover = null;
      if (this.draft) this.draft.cursor = null;
      this.draw();
    });
    canvas.addEventListener('wheel', (e) => this.wheel(e), { passive: false });
    canvas.addEventListener('dblclick', () => this.finishDraft());
    canvas.addEventListener('contextmenu', (e) => e.preventDefault());
    this.keydown = (e) => this.key(e);
    window.addEventListener('keydown', this.keydown);
    this.themeQuery = matchMedia('(prefers-color-scheme: dark)');
    this.themeChange = () => {
      this.readColors();
      this.draw();
    };
    this.themeQuery.addEventListener('change', this.themeChange);
    this.readColors();
  }

  destroy() {
    this.observer.disconnect();
    window.removeEventListener('keydown', this.keydown);
    this.themeQuery.removeEventListener('change', this.themeChange);
  }

  readColors() {
    const css = getComputedStyle(this.canvas);
    const v = (name) => css.getPropertyValue(name).trim();
    this.colors = {
      bg: v('--sunken'),
      grid: v('--line'),
      ink: v('--ink'),
      muted: v('--muted'),
      wall: v('--ink'),
      accent: v('--accent'),
      accentSoft: v('--accent-soft'),
      room: v('--accent-soft'),
      danger: v('--danger'),
      card: v('--card'),
    };
  }

  // ---- state from outside -------------------------------------------------

  setLayout(layout) {
    this.layout = layout;
    if (this.selection && !this.selected()) this.select(null);
    if (!this.fitted && this.width) this.fit();
    this.draw();
  }

  setImage(image) {
    this.image = image;
    if (image && !bounds(this.layout) && this.width) this.fit();
    this.draw();
  }

  setTool(tool) {
    this.tool = tool;
    this.draft = null;
    this.calib = null;
    if (tool !== 'select') this.select(null);
    this.canvas.dataset.tool = tool;
    this.onTool?.(tool);
    this.draw();
  }

  select(selection) {
    const changed = JSON.stringify(selection) !== JSON.stringify(this.selection);
    this.selection = selection;
    if (changed) this.onSelect?.(selection);
    this.draw();
  }

  selected() {
    const s = this.selection;
    if (!s || !this.layout) return null;
    const list = { wall: this.layout.walls, opening: this.layout.openings, room: this.layout.rooms }[s.type];
    return list?.find((x) => x.id === s.id) ?? null;
  }

  commit() {
    this.onCommit?.(this.layout);
    this.draw();
  }

  // ---- view ---------------------------------------------------------------

  resize() {
    const rect = this.canvas.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    const dpr = Math.min(devicePixelRatio || 1, 3);
    this.width = rect.width;
    this.height = rect.height;
    this.canvas.width = Math.round(rect.width * dpr);
    this.canvas.height = Math.round(rect.height * dpr);
    this.dpr = dpr;
    if (!this.fitted && this.layout) this.fit();
    this.draw();
  }

  fit() {
    if (!this.width || !this.layout) return;
    let b = bounds(this.layout);
    const bg = this.layout.background;
    if (!b && bg && this.image) {
      b = { minX: bg.x, minY: bg.y, maxX: bg.x + this.image.naturalWidth * bg.scale, maxY: bg.y + this.image.naturalHeight * bg.scale };
    }
    b ??= { minX: -1, minY: -1, maxX: 9, maxY: 7 };
    const w = Math.max(b.maxX - b.minX, 1);
    const h = Math.max(b.maxY - b.minY, 1);
    const pad = 40;
    const bottom = pad + this.insetBottom; // keep clear of the panel over the canvas
    const zoom = clamp(Math.min((this.width - pad * 2) / w, (this.height - pad - bottom) / h), 5, 600);
    this.view = {
      zoom,
      x: (b.minX + b.maxX) / 2 - this.width / 2 / zoom,
      y: (b.minY + b.maxY) / 2 - (pad + (this.height - pad - bottom) / 2) / zoom,
    };
    this.fitted = true;
    this.draw();
  }

  toWorld(sx, sy) {
    return [this.view.x + sx / this.view.zoom, this.view.y + sy / this.view.zoom];
  }

  toScreen([x, y]) {
    return [(x - this.view.x) * this.view.zoom, (y - this.view.y) * this.view.zoom];
  }

  eventPoint(e) {
    const rect = this.canvas.getBoundingClientRect();
    return [e.clientX - rect.left, e.clientY - rect.top];
  }

  zoomAt(sx, sy, factor) {
    const before = this.toWorld(sx, sy);
    this.view.zoom = clamp(this.view.zoom * factor, 5, 800);
    this.view.x = before[0] - sx / this.view.zoom;
    this.view.y = before[1] - sy / this.view.zoom;
  }

  wheel(e) {
    e.preventDefault();
    const [sx, sy] = this.eventPoint(e);
    if (e.ctrlKey || e.metaKey || Math.abs(e.deltaY) > 0 && e.deltaMode === 1 || !e.deltaX) {
      this.zoomAt(sx, sy, Math.exp(-e.deltaY * (e.deltaMode === 1 ? 0.05 : 0.0015)));
    } else {
      this.view.x += e.deltaX / this.view.zoom;
      this.view.y += e.deltaY / this.view.zoom;
    }
    this.draw();
  }

  // Grid step that matches the zoom: finer when zoomed in.
  step() {
    return this.view.zoom > 160 ? 0.01 : this.view.zoom > 40 ? 0.05 : 0.1;
  }

  // ---- hit testing --------------------------------------------------------

  allPoints() {
    return [...this.layout.walls.flatMap((w) => [w.a, w.b]), ...this.layout.rooms.flatMap((r) => r.points)];
  }

  // Every point array (wall ends and room corners) sitting at the same spot as `p`.
  joinedAt(p) {
    return this.allPoints().filter((q) => same(p, q));
  }

  hit(world) {
    const tol = HIT / this.view.zoom;
    const L = this.layout;
    for (const o of L.openings) {
      const wall = L.walls.find((w) => w.id === o.wall);
      if (!wall) continue;
      const pr = projectOnWall(wall, world);
      if (pr.dist <= wall.t / 2 + tol && Math.abs(pr.at - o.at) <= o.w / 2) return { type: 'opening', id: o.id, item: o };
    }
    let best = null;
    for (const p of this.allPoints()) {
      const d = dist(p, world);
      if (d <= tol * 1.4 && (!best || d < best.d)) best = { d, point: p };
    }
    // Room corners are only grabbed when the room is selected (or a wall meets them).
    if (best) {
      const isWallEnd = L.walls.some((w) => w.a === best.point || w.b === best.point || same(w.a, best.point) || same(w.b, best.point));
      const room = this.selection?.type === 'room' && this.selected();
      if (isWallEnd || room?.points.some((q) => same(q, best.point))) return { type: 'point', point: best.point };
    }
    let wallHit = null;
    for (const w of L.walls) {
      const pr = projectOnWall(w, world);
      if (pr.dist <= w.t / 2 + tol && (!wallHit || pr.dist < wallHit.d)) wallHit = { d: pr.dist, w };
    }
    if (wallHit) return { type: 'wall', id: wallHit.w.id, item: wallHit.w };
    for (const r of [...L.rooms].reverse()) {
      if (pointInPolygon(world, r.points)) return { type: 'room', id: r.id, item: r };
    }
    return null;
  }

  // Snaps a point being placed. `anchor` is the fixed other end (for angles),
  // `moving` lists point arrays that move along and must not snap to themselves.
  snap(p, { anchor = null, moving = [], free = false } = {}) {
    this.guides = null;
    if (free) return { p };
    const tol = SNAP / this.view.zoom;
    let best = null;
    for (const q of this.allPoints()) {
      if (moving.includes(q)) continue;
      const d = dist(p, q);
      if (d <= tol && (!best || d < best.d)) best = { d, p: [q[0], q[1]], kind: 'point' };
    }
    if (best) return best;
    // Onto a wall's centre line (for T-junctions).
    for (const w of this.layout.walls) {
      if (moving.includes(w.a) && moving.includes(w.b)) continue;
      const pr = projectOnWall(w, p);
      if (pr.dist <= tol * 0.8 && pr.at > 0.01 && pr.at < wallLength(w) - 0.01) {
        return { p: pr.point.map((v) => Math.round(v * 1000) / 1000), kind: 'line', wall: w };
      }
    }
    const step = this.step();
    if (anchor) {
      // Lengths in whole steps, angles in 45° steps when close.
      let dx = p[0] - anchor[0];
      let dy = p[1] - anchor[1];
      const len = Math.hypot(dx, dy);
      const angle = Math.atan2(dy, dx);
      const snapped = Math.round(angle / (Math.PI / 4)) * (Math.PI / 4);
      if (Math.abs(snapped - angle) < (6 * Math.PI) / 180) {
        const l = round(len, step);
        dx = Math.cos(snapped) * l;
        dy = Math.sin(snapped) * l;
        const q = [anchor[0] + dx, anchor[1] + dy].map((v) => Math.round(v * 1000) / 1000);
        // Along a horizontal or vertical line, line the end up with other corners.
        const horizontal = Math.abs(Math.sin(snapped)) < 1e-6;
        const vertical = Math.abs(Math.cos(snapped)) < 1e-6;
        return { p: this.align(q, moving, tol, [horizontal, vertical]), kind: 'angle' };
      }
    }
    return { p: this.align([round(p[0], step), round(p[1], step)], moving, tol), kind: 'grid' };
  }

  // Lines a point up with other corners when close. `axes` says which
  // coordinates may change: both on a free move, one along a straight line.
  align(p, moving, tol, axes = [true, true]) {
    const out = [...p];
    const guides = [null, null];
    for (const k of [0, 1]) {
      if (!axes[k]) continue;
      let best = null;
      for (const q of this.allPoints()) {
        if (moving.includes(q)) continue;
        const d = Math.abs(q[k] - p[k]);
        if (d < tol && (!best || d < best.d)) best = { d, v: q[k] };
      }
      if (best) out[k] = guides[k] = best.v;
    }
    this.guides = guides;
    return out;
  }

  // ---- pointer input ------------------------------------------------------

  pointerDown(e) {
    this.canvas.setPointerCapture(e.pointerId);
    const s = this.eventPoint(e);
    this.pointers.set(e.pointerId, s);
    if (this.pointers.size === 2) {
      // Second finger: switch to pan + pinch, undo whatever the first started.
      if (this.gesture?.snapshot) this.restore(this.gesture.snapshot);
      const [p1, p2] = [...this.pointers.values()];
      this.gesture = { type: 'pinch', d: dist(p1, p2), mid: [(p1[0] + p2[0]) / 2, (p1[1] + p2[1]) / 2] };
      return;
    }
    if (this.pointers.size > 2) return;
    const world = this.toWorld(...s);
    const pan = e.button === 1 || e.button === 2 || this.tool === 'pan' || this.spaceDown;
    this.gesture = { type: 'press', start: s, last: s, world, pan, free: e.altKey, pointerType: e.pointerType };
  }

  pointerMove(e) {
    const s = this.eventPoint(e);
    if (!this.pointers.has(e.pointerId)) {
      if (e.pointerType === 'mouse') this.hoverAt(s, e.altKey);
      return;
    }
    this.pointers.set(e.pointerId, s);
    const g = this.gesture;
    if (!g) return;

    if (g.type === 'pinch') {
      const [p1, p2] = [...this.pointers.values()];
      const d = dist(p1, p2);
      const mid = [(p1[0] + p2[0]) / 2, (p1[1] + p2[1]) / 2];
      this.view.x -= (mid[0] - g.mid[0]) / this.view.zoom;
      this.view.y -= (mid[1] - g.mid[1]) / this.view.zoom;
      if (g.d > 0) this.zoomAt(mid[0], mid[1], d / g.d);
      g.d = d;
      g.mid = mid;
      return this.draw();
    }

    if (g.type === 'press') {
      if (dist(s, g.start) < DRAG_START) {
        if (e.pointerType !== 'mouse') this.hoverAt(s, e.altKey);
        return;
      }
      this.startDrag(g, e);
    }
    if (g.type === 'pan') {
      this.view.x -= (s[0] - g.last[0]) / this.view.zoom;
      this.view.y -= (s[1] - g.last[1]) / this.view.zoom;
      g.last = s;
      return this.draw();
    }
    if (g.type === 'draw') {
      g.world = this.toWorld(...s);
      this.hoverAt(s, e.altKey);
      return;
    }
    this.drag(g, this.toWorld(...s), e.altKey);
  }

  pointerUp(e, cancelled = false) {
    this.pointers.delete(e.pointerId);
    const g = this.gesture;
    if (!g) return;
    if (g.type === 'pinch') {
      if (this.pointers.size === 0) this.gesture = null;
      else this.gesture = { type: 'pan', last: [...this.pointers.values()][0] };
      return;
    }
    if (this.pointers.size) return;
    this.gesture = null;
    if (cancelled) {
      if (g.snapshot) this.restore(g.snapshot);
      return this.draw();
    }
    if (g.type === 'press') return this.tap(g, e);
    if (g.type === 'draw') return this.tap(g, e);
    this.guides = null;
    if (g.snapshot) {
      if (g.changed) this.commit();
      else this.draw();
    }
  }

  hoverAt(s, free) {
    const world = this.toWorld(...s);
    if (this.tool === 'wall' || this.tool === 'room') {
      const anchor = this.draft?.points.at(-1) ?? null;
      const snapped = this.snap(world, { anchor, free });
      this.draft ??= { points: [], cursor: null };
      this.draft.cursor = snapped.p;
      this.draft.snapKind = snapped.kind;
    } else if (this.tool === 'calibrate') {
      this.calib ??= { points: [] };
      this.calib.cursor = world;
    } else if (this.tool === 'door' || this.tool === 'window') {
      this.hover = this.wallUnder(world);
    } else if (!this.readOnly) {
      this.hover = this.hit(world);
      this.canvas.style.cursor = this.hover ? (this.hover.type === 'room' ? 'pointer' : 'grab') : '';
    }
    this.draw();
  }

  wallUnder(world) {
    const tol = HIT / this.view.zoom;
    let best = null;
    for (const w of this.layout.walls) {
      const pr = projectOnWall(w, world);
      if (pr.dist <= w.t / 2 + tol * 1.5 && (!best || pr.dist < best.d)) best = { d: pr.dist, wall: w, at: pr.at };
    }
    return best && { type: 'wall-spot', wall: best.wall, at: best.at };
  }

  snapshot() {
    return JSON.stringify(this.layout);
  }

  restore(json) {
    const fresh = JSON.parse(json);
    Object.assign(this.layout, fresh);
  }

  startDrag(g, e) {
    if (g.pan || this.readOnly || this.tool === 'pan') {
      g.type = 'pan';
      return;
    }
    if (this.tool === 'wall' || this.tool === 'room') {
      // Dragging while drawing pans on touch, places on mouse.
      g.type = e.pointerType === 'mouse' ? 'draw' : 'pan';
      return;
    }
    if (this.tool === 'image') {
      g.type = 'image';
      g.snapshot = this.snapshot();
      g.origin = [this.layout.background.x, this.layout.background.y];
      return;
    }
    if (this.tool !== 'select') {
      g.type = 'pan';
      return;
    }
    const hit = this.hit(g.world);
    if (!hit) {
      g.type = 'pan';
      return;
    }
    g.snapshot = this.snapshot();
    if (hit.type === 'point') {
      g.type = 'point';
      g.moving = this.joinedAt(hit.point);
      const wall = this.layout.walls.find((w) => g.moving.includes(w.a) || g.moving.includes(w.b));
      g.anchor = wall ? [...(g.moving.includes(wall.a) ? wall.b : wall.a)] : null;
      return;
    }
    if (hit.type === 'opening') {
      g.type = 'opening';
      g.item = hit.item;
      this.select({ type: 'opening', id: hit.id });
      return;
    }
    // Moving a wall or room moves every corner joined to it; walls attached there stretch along.
    this.select({ type: hit.type, id: hit.id });
    const corners = hit.type === 'wall' ? [hit.item.a, hit.item.b] : hit.item.points;
    g.type = 'move';
    g.corners = corners.map((p) => [...p]);
    g.moving = [...new Set(corners.flatMap((p) => this.joinedAt(p)))];
    g.origins = g.moving.map((p) => [...p]);
  }

  drag(g, world, free) {
    const dx = world[0] - g.world[0];
    const dy = world[1] - g.world[1];
    g.changed = true;
    if (g.type === 'point') {
      const target = this.snap([g.world[0] + dx, g.world[1] + dy], { anchor: g.anchor, moving: g.moving, free }).p;
      // Keep the grab offset out of it: the point jumps to the snapped spot.
      for (const p of g.moving) {
        p[0] = target[0];
        p[1] = target[1];
      }
    } else if (g.type === 'move') {
      let delta = [dx, dy];
      if (!free) {
        // Snap whichever moving corner is closest to a fixed corner; else whole steps.
        const tol = SNAP / this.view.zoom;
        let best = null;
        const fixed = this.allPoints().filter((q) => !g.moving.includes(q));
        for (const c of g.corners) {
          const moved = [c[0] + dx, c[1] + dy];
          for (const q of fixed) {
            const d = dist(moved, q);
            if (d <= tol && (!best || d < best.d)) best = { d, delta: [q[0] - c[0], q[1] - c[1]] };
          }
        }
        const step = this.step();
        delta = best ? best.delta : [round(dx, step), round(dy, step)];
      }
      g.moving.forEach((p, i) => {
        p[0] = Math.round((g.origins[i][0] + delta[0]) * 1000) / 1000;
        p[1] = Math.round((g.origins[i][1] + delta[1]) * 1000) / 1000;
      });
    } else if (g.type === 'opening') {
      const o = g.item;
      const wall = this.layout.walls.find((w) => w.id === o.wall);
      const len = wallLength(wall);
      const at = projectOnWall(wall, world).at;
      o.at = clamp(free ? Math.round(at * 1000) / 1000 : round(at, this.step()), o.w / 2, len - o.w / 2);
    } else if (g.type === 'image') {
      const bg = this.layout.background;
      bg.x = Math.round((g.origin[0] + dx) * 1000) / 1000;
      bg.y = Math.round((g.origin[1] + dy) * 1000) / 1000;
    }
    this.draw();
  }

  tap(g, e) {
    const world = g.world;
    if (this.readOnly && this.tool !== 'select') return;
    switch (this.tool) {
      case 'wall':
      case 'room':
        return this.placeDraftPoint(this.snap(world, { anchor: this.draft?.points.at(-1) ?? null, free: g.free }).p, e);
      case 'door':
      case 'window': {
        const spot = this.wallUnder(world);
        if (!spot) return;
        const kind = this.tool;
        const len = wallLength(spot.wall);
        const def = DEFAULTS[kind];
        const w = Math.min(def.w, Math.max(len - 0.1, 0.3));
        const opening = {
          id: newLocalId(),
          wall: spot.wall.id,
          kind,
          at: clamp(round(spot.at, 0.05), w / 2, len - w / 2),
          w,
          h: Math.min(def.h, this.layout.height - 0.1),
          sill: def.sill,
          flip: 0,
        };
        this.layout.openings.push(opening);
        this.setTool('select');
        this.select({ type: 'opening', id: opening.id });
        return this.commit();
      }
      case 'calibrate': {
        this.calib ??= { points: [] };
        this.calib.points.push(world);
        if (this.calib.points.length === 2) {
          const [p, q] = this.calib.points;
          this.calib = null;
          this.setTool('select');
          this.onCalibrate?.(p, q);
        }
        return this.draw();
      }
      default: {
        if (this.tool !== 'select') return;
        const hit = this.hit(world);
        if (!hit || hit.type === 'point') {
          // A tap on a corner selects the wall it belongs to.
          const wall = hit && this.layout.walls.find((w) => w.a === hit.point || w.b === hit.point);
          return this.select(wall ? { type: 'wall', id: wall.id } : null);
        }
        return this.select({ type: hit.type, id: hit.id });
      }
    }
  }

  placeDraftPoint(p) {
    this.draft ??= { points: [], cursor: null };
    const pts = this.draft.points;
    if (pts.length && dist(pts.at(-1), p) < 0.02) return this.finishDraft();
    // Closing the shape on its first point.
    if (pts.length >= 2 && dist(pts[0], p) < 0.02) {
      pts.push(pts[0]);
      return this.finishDraft(true);
    }
    pts.push(p);
    this.draw();
  }

  finishDraft(closed = false) {
    const d = this.draft;
    this.draft = null;
    if (!d) return;
    let pts = d.points;
    if (this.tool === 'room') {
      if (closed) pts = pts.slice(0, -1);
      if (pts.length < 3) return this.draw();
      const room = { id: newLocalId(), name: '', points: pts.map((p) => [...p]) };
      this.layout.rooms.push(room);
      this.addWallsAlong([...pts, pts[0]]);
      this.setTool('select');
      this.select({ type: 'room', id: room.id });
      return this.commit();
    }
    if (pts.length < 2) return this.draw();
    const walls = this.addWallsAlong(pts);
    if (walls.length === 1) this.select({ type: 'wall', id: walls[0].id });
    this.commit();
  }

  // Adds walls between consecutive points, skipping stretches an existing
  // wall already covers (rooms drawn against walls that are already there).
  addWallsAlong(pts) {
    const added = [];
    for (let i = 0; i + 1 < pts.length; i++) {
      const a = [...pts[i]];
      const b = [...pts[i + 1]];
      if (dist(a, b) < 0.01) continue;
      const covered = this.layout.walls.some((w) => projectOnWall(w, a).dist < 0.002 && projectOnWall(w, b).dist < 0.002);
      if (covered) continue;
      const wall = { id: newLocalId(), a, b, t: DEFAULTS.wallThickness };
      this.layout.walls.push(wall);
      added.push(wall);
    }
    return added;
  }

  key(e) {
    if (e.target.closest?.('input, textarea, select, [contenteditable]')) return;
    if (e.key === ' ') {
      this.spaceDown = e.type === 'keydown';
      return;
    }
    if (e.key === 'Escape') {
      if (this.draft?.points.length > 1) this.finishDraft();
      else if (this.tool !== 'select') this.setTool('select');
      else this.select(null);
      return;
    }
    if (e.key === 'Enter' && this.draft) return this.finishDraft();
    if ((e.key === 'Delete' || e.key === 'Backspace') && this.selection && !this.readOnly) {
      e.preventDefault();
      this.deleteSelected();
    }
  }

  deleteSelected() {
    const s = this.selection;
    if (!s) return;
    const L = this.layout;
    if (s.type === 'wall') {
      L.walls = L.walls.filter((w) => w.id !== s.id);
      L.openings = L.openings.filter((o) => o.wall !== s.id);
    } else if (s.type === 'opening') {
      L.openings = L.openings.filter((o) => o.id !== s.id);
    } else if (s.type === 'room') {
      L.rooms = L.rooms.filter((r) => r.id !== s.id);
    }
    this.select(null);
    this.commit();
  }

  // ---- drawing ------------------------------------------------------------

  draw() {
    if (this.frame) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = null;
      this.paint();
    });
  }

  paint() {
    const { ctx, colors: c } = this;
    if (!this.width || !this.layout) return;
    const z = this.view.zoom;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.fillStyle = c.bg;
    ctx.fillRect(0, 0, this.width, this.height);
    // World transform: 1 unit = 1 metre.
    ctx.setTransform(this.dpr * z, 0, 0, this.dpr * z, -this.view.x * z * this.dpr, -this.view.y * z * this.dpr);
    const px = 1 / z; // one CSS pixel in metres

    const bg = this.layout.background;
    if (bg && this.image?.complete && this.image.naturalWidth) {
      ctx.globalAlpha = bg.opacity;
      ctx.drawImage(this.image, bg.x, bg.y, this.image.naturalWidth * bg.scale, this.image.naturalHeight * bg.scale);
      ctx.globalAlpha = 1;
    }
    this.paintGrid(px);

    const sel = this.selection;
    for (const r of this.layout.rooms) {
      ctx.beginPath();
      r.points.forEach((p, i) => (i ? ctx.lineTo(...p) : ctx.moveTo(...p)));
      ctx.closePath();
      ctx.globalAlpha = sel?.id === r.id ? 0.9 : 0.55;
      ctx.fillStyle = c.room;
      ctx.fill();
      ctx.globalAlpha = 1;
      if (sel?.id === r.id) {
        ctx.lineWidth = 2 * px;
        ctx.strokeStyle = c.accent;
        ctx.setLineDash([6 * px, 4 * px]);
        ctx.stroke();
        ctx.setLineDash([]);
      }
    }

    const ext = wallEndExtensions(this.layout.walls);
    for (const w of this.layout.walls) {
      const { dx, dy, nx, ny, len } = wallFrame(w);
      const [ea, eb] = ext[w.id];
      const h = w.t / 2;
      const a = [w.a[0] - dx * ea, w.a[1] - dy * ea];
      const b = [w.a[0] + dx * (len + eb), w.a[1] + dy * (len + eb)];
      ctx.beginPath();
      ctx.moveTo(a[0] + nx * h, a[1] + ny * h);
      ctx.lineTo(b[0] + nx * h, b[1] + ny * h);
      ctx.lineTo(b[0] - nx * h, b[1] - ny * h);
      ctx.lineTo(a[0] - nx * h, a[1] - ny * h);
      ctx.closePath();
      const active = sel?.id === w.id;
      const hovered = this.hover?.id === w.id || this.hover?.wall === w;
      ctx.fillStyle = active ? c.accent : c.wall;
      ctx.globalAlpha = hovered && !active ? 0.7 : 1;
      ctx.fill();
      ctx.globalAlpha = 1;
    }

    for (const o of this.layout.openings) this.paintOpening(o, px);

    // Room names and areas.
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (const r of this.layout.rooms) {
      const [cx, cy] = polygonCentroid(r.points);
      const area = formatArea(polygonArea(r.points));
      this.label([cx, cy], r.name ? `${r.name}\n${area}` : area, px, { color: c.ink, size: 13, bold: !!r.name });
    }

    // Lengths along walls when there is room for them, on the side facing
    // the middle of the plan so they read as inside measurements.
    const b = bounds(this.layout);
    const centre = b && [(b.minX + b.maxX) / 2, (b.minY + b.maxY) / 2];
    ctx.font = '500 11px system-ui, -apple-system, "Segoe UI", sans-serif';
    for (const w of this.layout.walls) {
      const len = wallLength(w);
      if (len * z < 60 && sel?.id !== w.id) continue;
      let { nx, ny } = wallFrame(w);
      const m = [(w.a[0] + w.b[0]) / 2, (w.a[1] + w.b[1]) / 2];
      if ((centre[0] - m[0]) * nx + (centre[1] - m[1]) * ny < 0) [nx, ny] = [-nx, -ny];
      const text = formatLength(len);
      const half = (Math.abs(nx) * (ctx.measureText(text).width / 2 + 6) + Math.abs(ny) * 9) * px;
      const off = w.t / 2 + half + 3 * px;
      const mid = [m[0] + nx * off, m[1] + ny * off];
      this.label(mid, text, px, { color: sel?.id === w.id ? c.accent : c.muted, size: 11, chip: sel?.id === w.id });
    }

    if (sel?.type === 'wall') {
      const w = this.selected();
      if (w) for (const p of [w.a, w.b]) this.handle(p, px);
    }
    if (sel?.type === 'room') {
      const r = this.selected();
      if (r) for (const p of r.points) this.handle(p, px, true);
    }
    if (this.hover?.type === 'point') this.handle(this.hover.point, px);
    if (this.hover?.type === 'wall-spot') {
      const { wall, at } = this.hover;
      const { dx, dy, nx, ny } = wallFrame(wall);
      const w = DEFAULTS[this.tool]?.w ?? 0.9;
      const p = [wall.a[0] + dx * at, wall.a[1] + dy * at];
      ctx.strokeStyle = c.accent;
      ctx.lineWidth = 3 * px;
      ctx.beginPath();
      ctx.moveTo(p[0] - dx * w / 2 + nx * wall.t, p[1] - dy * w / 2 + ny * wall.t);
      ctx.lineTo(p[0] + dx * w / 2 + nx * wall.t, p[1] + dy * w / 2 + ny * wall.t);
      ctx.stroke();
    }

    this.paintDraft(px);
    this.paintCalibration(px);
    if (this.guides) this.paintGuides(px);
  }

  paintGrid(px) {
    const { ctx } = this;
    const [x0, y0] = this.toWorld(0, 0);
    const [x1, y1] = this.toWorld(this.width, this.height);
    const z = this.view.zoom;
    const minor = z > 120 ? 0.1 : z > 30 ? 0.5 : 1;
    const lines = (step, alpha) => {
      ctx.beginPath();
      for (let x = Math.floor(x0 / step) * step; x <= x1; x += step) {
        ctx.moveTo(x, y0);
        ctx.lineTo(x, y1);
      }
      for (let y = Math.floor(y0 / step) * step; y <= y1; y += step) {
        ctx.moveTo(x0, y);
        ctx.lineTo(x1, y);
      }
      ctx.globalAlpha = alpha;
      ctx.strokeStyle = this.colors.grid;
      ctx.lineWidth = px;
      ctx.stroke();
      ctx.globalAlpha = 1;
    };
    if (minor < 1) lines(minor, 0.6);
    lines(1, 1);
  }

  paintOpening(o, px) {
    const { ctx, colors: c } = this;
    const wall = this.layout.walls.find((w) => w.id === o.wall);
    if (!wall) return;
    const { dx, dy, nx, ny } = wallFrame(wall);
    const center = [wall.a[0] + dx * o.at, wall.a[1] + dy * o.at];
    const h = wall.t / 2 + 0.5 * px;
    const s = [center[0] - dx * o.w / 2, center[1] - dy * o.w / 2];
    const e = [center[0] + dx * o.w / 2, center[1] + dy * o.w / 2];
    const active = this.selection?.id === o.id;
    ctx.fillStyle = c.bg;
    ctx.beginPath();
    ctx.moveTo(s[0] + nx * h, s[1] + ny * h);
    ctx.lineTo(e[0] + nx * h, e[1] + ny * h);
    ctx.lineTo(e[0] - nx * h, e[1] - ny * h);
    ctx.lineTo(s[0] - nx * h, s[1] - ny * h);
    ctx.closePath();
    ctx.fill();
    ctx.strokeStyle = active ? c.accent : c.ink;
    ctx.lineWidth = (active ? 2.5 : 1.5) * px;
    if (o.kind === 'window') {
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(...s);
      ctx.lineTo(...e);
      ctx.stroke();
      return;
    }
    // Door: a leaf standing open at 90° plus its swing arc.
    const hingeAtEnd = o.flip & 1;
    const side = o.flip & 2 ? -1 : 1;
    const hinge = hingeAtEnd ? e : s;
    const free = hingeAtEnd ? s : e;
    const leaf = [hinge[0] + nx * side * o.w, hinge[1] + ny * side * o.w];
    ctx.beginPath();
    ctx.moveTo(...hinge);
    ctx.lineTo(...leaf);
    ctx.stroke();
    const a0 = Math.atan2(free[1] - hinge[1], free[0] - hinge[0]);
    const a1 = Math.atan2(leaf[1] - hinge[1], leaf[0] - hinge[0]);
    let diff = a1 - a0;
    while (diff > Math.PI) diff -= 2 * Math.PI;
    while (diff < -Math.PI) diff += 2 * Math.PI;
    ctx.setLineDash([4 * px, 3 * px]);
    ctx.lineWidth = px;
    ctx.beginPath();
    ctx.arc(hinge[0], hinge[1], o.w, a0, a1, diff < 0);
    ctx.stroke();
    ctx.setLineDash([]);
  }

  paintDraft(px) {
    const d = this.draft;
    if (!d || !(this.tool === 'wall' || this.tool === 'room')) return;
    const { ctx, colors: c } = this;
    const pts = d.cursor ? [...d.points, d.cursor] : d.points;
    if (pts.length > 1) {
      ctx.strokeStyle = c.accent;
      ctx.lineWidth = Math.max(DEFAULTS.wallThickness, 3 * px);
      ctx.lineCap = 'square';
      ctx.globalAlpha = 0.75;
      ctx.beginPath();
      pts.forEach((p, i) => (i ? ctx.lineTo(...p) : ctx.moveTo(...p)));
      if (this.tool === 'room' && pts.length > 2) ctx.closePath();
      ctx.stroke();
      ctx.globalAlpha = 1;
      ctx.lineCap = 'butt';
      const a = pts.at(-2);
      const b = pts.at(-1);
      this.label([(a[0] + b[0]) / 2, (a[1] + b[1]) / 2], formatLength(dist(a, b)), px, { color: c.accent, size: 12, chip: true });
    }
    for (const p of d.points) this.handle(p, px, true);
    if (d.cursor) this.handle(d.cursor, px, d.snapKind !== 'point');
  }

  paintCalibration(px) {
    const k = this.calib;
    if (this.tool !== 'calibrate' || !k) return;
    const { ctx, colors: c } = this;
    const pts = k.cursor ? [...k.points, k.cursor] : k.points;
    ctx.strokeStyle = c.danger;
    ctx.lineWidth = 2 * px;
    if (pts.length === 2) {
      ctx.beginPath();
      ctx.moveTo(...pts[0]);
      ctx.lineTo(...pts[1]);
      ctx.stroke();
    }
    for (const p of pts) {
      ctx.beginPath();
      ctx.arc(p[0], p[1], 6 * px, 0, Math.PI * 2);
      ctx.stroke();
    }
  }

  paintGuides(px) {
    const { ctx } = this;
    const [gx, gy] = this.guides;
    const [x0, y0] = this.toWorld(0, 0);
    const [x1, y1] = this.toWorld(this.width, this.height);
    ctx.strokeStyle = this.colors.accent;
    ctx.lineWidth = px;
    ctx.setLineDash([3 * px, 3 * px]);
    ctx.beginPath();
    if (gx != null && gx !== false) {
      ctx.moveTo(gx, y0);
      ctx.lineTo(gx, y1);
    }
    if (gy != null && gy !== false) {
      ctx.moveTo(x0, gy);
      ctx.lineTo(x1, gy);
    }
    ctx.stroke();
    ctx.setLineDash([]);
  }

  handle(p, px, hollow = false) {
    const { ctx, colors: c } = this;
    ctx.beginPath();
    ctx.arc(p[0], p[1], 6 * px, 0, Math.PI * 2);
    ctx.fillStyle = hollow ? c.card : c.accent;
    ctx.fill();
    ctx.lineWidth = 2 * px;
    ctx.strokeStyle = hollow ? c.accent : c.card;
    ctx.stroke();
  }

  label(p, text, px, { color, size = 12, bold = false, chip = false }) {
    const { ctx, colors: c } = this;
    ctx.save();
    // Text is drawn in screen space so it keeps its size when zooming.
    const [sx, sy] = this.toScreen(p);
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.font = `${bold ? 650 : 500} ${size}px system-ui, -apple-system, "Segoe UI", sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const lines = text.split('\n');
    const lh = size * 1.25;
    lines.forEach((line, i) => {
      const y = sy + (i - (lines.length - 1) / 2) * lh;
      const w = ctx.measureText(line).width;
      if (chip) {
        ctx.fillStyle = c.card;
        ctx.beginPath();
        ctx.roundRect(sx - w / 2 - 6, y - lh / 2 - 1, w + 12, lh + 2, 6);
        ctx.fill();
      } else {
        ctx.lineWidth = 3;
        ctx.strokeStyle = c.bg;
        ctx.globalAlpha = 0.85;
        ctx.strokeText(line, sx, y);
        ctx.globalAlpha = 1;
      }
      ctx.fillStyle = i === 0 ? color : c.muted;
      ctx.font = `${i === 0 && bold ? 650 : 500} ${i === 0 ? size : size - 1}px system-ui, -apple-system, "Segoe UI", sans-serif`;
      ctx.fillText(line, sx, y);
    });
    ctx.restore();
  }
}
