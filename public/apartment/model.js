// The apartment layout: walls, doors/windows and named rooms, in metres.
// Plain ES module shared by the browser and the server (validation + geometry).
//
// Coordinates are a top-down plan: x to the right, y downwards.
// layout = {
//   height: 2.5,                                   ceiling height
//   walls:    [{ id, a: [x, y], b: [x, y], t }],   t = thickness
//   openings: [{ id, wall, kind: 'door'|'window', at, w, h, sill, flip }],
//             at = distance from the wall's `a` end to the opening's centre,
//             flip = which way a door swings (bit 1: hinge side, bit 2: opens to the other side)
//   rooms:    [{ id, name, points: [[x, y], …] }],
//   background: null | { v, x, y, scale, opacity } a traced floor plan image:
//             top-left corner at (x, y), `scale` metres per image pixel,
//             `v` changes whenever a new image is uploaded
// }

export const LIMITS = {
  walls: 1000,
  openings: 500,
  rooms: 200,
  roomPoints: 100,
  coord: 500,
};

export const DEFAULTS = {
  height: 2.5,
  wallThickness: 0.12,
  door: { w: 0.9, h: 2.1, sill: 0 },
  window: { w: 1.2, h: 1.2, sill: 0.9 },
};

export class LayoutError extends Error {}

export function emptyLayout() {
  return { height: DEFAULTS.height, walls: [], openings: [], rooms: [], background: null };
}

const mm = (n) => Math.round(n * 1000) / 1000;

function num(value, field, min, max, round = mm) {
  const n = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
  if (typeof n !== 'number' || !Number.isFinite(n)) throw new LayoutError(`${field} must be a number`);
  if (n < min || n > max) throw new LayoutError(`${field} must be between ${min} and ${max}`);
  return round(n);
}

function point(value, field) {
  if (!Array.isArray(value) || value.length !== 2) throw new LayoutError(`${field} must be [x, y]`);
  return [num(value[0], field, -LIMITS.coord, LIMITS.coord), num(value[1], field, -LIMITS.coord, LIMITS.coord)];
}

function id(value, field) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,24}$/.test(value)) throw new LayoutError(`${field} has a bad id`);
  return value;
}

function list(value, field, max) {
  if (value == null) return [];
  if (!Array.isArray(value)) throw new LayoutError(`${field} must be a list`);
  if (value.length > max) throw new LayoutError(`Too many ${field} (max ${max})`);
  return value;
}

// Validates and normalises a layout sent by a client. Whether there is a
// background image is up to the server (`stored`); the client only moves,
// scales and fades it.
export function sanitizeLayout(input, { background: stored = null } = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new LayoutError('Layout must be an object');
  const height = num(input.height ?? DEFAULTS.height, 'Ceiling height', 1.5, 8);
  const seen = new Set();
  const unique = (value, field) => {
    const v = id(value, field);
    if (seen.has(v)) throw new LayoutError(`Duplicate id ${v}`);
    seen.add(v);
    return v;
  };

  const walls = list(input.walls, 'walls', LIMITS.walls).map((w) => {
    const wall = {
      id: unique(w?.id, 'Wall'),
      a: point(w.a, 'Wall start'),
      b: point(w.b, 'Wall end'),
      t: num(w.t ?? DEFAULTS.wallThickness, 'Wall thickness', 0.02, 1.5),
    };
    if (wallLength(wall) < 0.01) throw new LayoutError('A wall has no length');
    return wall;
  });
  const wallById = new Map(walls.map((w) => [w.id, w]));

  const openings = list(input.openings, 'openings', LIMITS.openings).flatMap((o) => {
    const wall = wallById.get(o?.wall);
    if (!wall) return []; // its wall was deleted: drop it quietly
    const kind = o.kind === 'window' ? 'window' : 'door';
    const len = wallLength(wall);
    const w = num(o.w ?? DEFAULTS[kind].w, 'Opening width', 0.1, len);
    const h = num(o.h ?? DEFAULTS[kind].h, 'Opening height', 0.1, height);
    return [{
      id: unique(o.id, 'Opening'),
      wall: wall.id,
      kind,
      at: mm(clamp(num(o.at ?? len / 2, 'Opening position', -LIMITS.coord, LIMITS.coord), w / 2, len - w / 2)),
      w,
      h,
      sill: mm(Math.min(num(o.sill ?? DEFAULTS[kind].sill, 'Sill height', 0, height), height - h)),
      flip: Number.isInteger(o.flip) && o.flip >= 0 && o.flip <= 3 ? o.flip : 0,
    }];
  });

  const rooms = list(input.rooms, 'rooms', LIMITS.rooms).map((r) => {
    const points = list(r?.points, 'room corners', LIMITS.roomPoints).map((p) => point(p, 'Room corner'));
    if (points.length < 3) throw new LayoutError('A room needs at least 3 corners');
    const name = typeof r.name === 'string' ? r.name.trim().slice(0, 60) : '';
    return { id: unique(r.id, 'Room'), name, points };
  });

  let background = null;
  if (stored) {
    const b = { ...stored, ...(input.background ?? {}) };
    background = {
      v: stored.v,
      x: num(b.x ?? 0, 'Image x', -LIMITS.coord, LIMITS.coord),
      y: num(b.y ?? 0, 'Image y', -LIMITS.coord, LIMITS.coord),
      scale: num(b.scale ?? 0.01, 'Image scale', 0.00001, 10, (n) => Number(n.toPrecision(6))),
      opacity: num(b.opacity ?? 0.5, 'Image opacity', 0, 1),
    };
  }
  return { height, walls, openings, rooms, background };
}

// ---- geometry -------------------------------------------------------------

export const clamp = (v, min, max) => Math.min(max, Math.max(min, v));

export function wallLength(wall) {
  return Math.hypot(wall.b[0] - wall.a[0], wall.b[1] - wall.a[1]);
}

// Unit direction from a to b, and the left-hand normal.
export function wallFrame(wall) {
  const len = wallLength(wall) || 1;
  const dx = (wall.b[0] - wall.a[0]) / len;
  const dy = (wall.b[1] - wall.a[1]) / len;
  return { len, dx, dy, nx: -dy, ny: dx };
}

export function pointOnWall(wall, at) {
  const { dx, dy } = wallFrame(wall);
  return [wall.a[0] + dx * at, wall.a[1] + dy * at];
}

// Closest point on the wall's centre line: { at, dist, point }.
export function projectOnWall(wall, p) {
  const { len, dx, dy } = wallFrame(wall);
  const at = clamp((p[0] - wall.a[0]) * dx + (p[1] - wall.a[1]) * dy, 0, len);
  const q = pointOnWall(wall, at);
  return { at, dist: Math.hypot(p[0] - q[0], p[1] - q[1]), point: q };
}

// Shoelace formula; always positive.
export function polygonArea(points) {
  let sum = 0;
  for (let i = 0; i < points.length; i++) {
    const [x1, y1] = points[i];
    const [x2, y2] = points[(i + 1) % points.length];
    sum += x1 * y2 - x2 * y1;
  }
  return Math.abs(sum) / 2;
}

export function polygonCentroid(points) {
  let a = 0;
  let cx = 0;
  let cy = 0;
  for (let i = 0; i < points.length; i++) {
    const [x1, y1] = points[i];
    const [x2, y2] = points[(i + 1) % points.length];
    const f = x1 * y2 - x2 * y1;
    a += f;
    cx += (x1 + x2) * f;
    cy += (y1 + y2) * f;
  }
  if (Math.abs(a) < 1e-9) {
    const n = points.length || 1;
    return [points.reduce((s, p) => s + p[0], 0) / n, points.reduce((s, p) => s + p[1], 0) / n];
  }
  return [cx / (3 * a), cy / (3 * a)];
}

export function pointInPolygon([x, y], points) {
  let inside = false;
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    const [xi, yi] = points[i];
    const [xj, yj] = points[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

export function bounds(layout) {
  const pts = [
    ...layout.walls.flatMap((w) => [w.a, w.b]),
    ...layout.rooms.flatMap((r) => r.points),
  ];
  if (!pts.length) return null;
  const xs = pts.map((p) => p[0]);
  const ys = pts.map((p) => p[1]);
  return { minX: Math.min(...xs), minY: Math.min(...ys), maxX: Math.max(...xs), maxY: Math.max(...ys) };
}

const pointKey = (p) => `${p[0]},${p[1]}`;

// How far each wall should reach past its end points so that walls meeting
// at a shared corner overlap instead of leaving a notch: { [wallId]: [atA, atB] }.
export function wallEndExtensions(walls) {
  const at = new Map();
  for (const w of walls) {
    for (const p of [w.a, w.b]) {
      const key = pointKey(p);
      if (!at.has(key)) at.set(key, []);
      at.get(key).push(w);
    }
  }
  const ext = {};
  for (const w of walls) {
    ext[w.id] = [w.a, w.b].map((p) => {
      const others = at.get(pointKey(p)).filter((o) => o !== w);
      return others.length ? Math.max(...others.map((o) => o.t)) / 2 : 0;
    });
  }
  return ext;
}

// Splits a wall into solid blocks around its openings, for building 3D boxes.
// Each piece is { from, to, bottom, top } in metres along the wall / above the floor.
export function wallPieces(wall, openings, height) {
  const len = wallLength(wall);
  const holes = openings
    .filter((o) => o.wall === wall.id)
    .map((o) => ({ from: clamp(o.at - o.w / 2, 0, len), to: clamp(o.at + o.w / 2, 0, len), bottom: o.sill, top: o.sill + o.h }))
    .sort((p, q) => p.from - q.from);

  const pieces = [];
  let cursor = 0;
  for (const hole of holes) {
    const from = Math.max(hole.from, cursor);
    if (from > cursor + 1e-6) pieces.push({ from: cursor, to: from, bottom: 0, top: height });
    if (hole.to > from + 1e-6) {
      if (hole.bottom > 1e-6) pieces.push({ from, to: hole.to, bottom: 0, top: hole.bottom });
      if (hole.top < height - 1e-6) pieces.push({ from, to: hole.to, bottom: hole.top, top: height });
    }
    cursor = Math.max(cursor, hole.to);
  }
  if (len > cursor + 1e-6) pieces.push({ from: cursor, to: len, bottom: 0, top: height });
  return pieces;
}

export function newLocalId() {
  const bytes = new Uint8Array(6);
  globalThis.crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'[b & 63]).join('');
}

export function formatLength(m) {
  return `${(Math.round(m * 100) / 100).toLocaleString(undefined, { maximumFractionDigits: 2 })} m`;
}

export function formatArea(m2) {
  return `${(Math.round(m2 * 10) / 10).toLocaleString(undefined, { maximumFractionDigits: 1 })} m²`;
}
