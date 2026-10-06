import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LayoutError, polygonArea, sanitizeLayout, wallEndExtensions, wallPieces } from '../public/apartment/model.js';

const wall = (id, a, b, t = 0.1) => ({ id, a, b, t });

test('sanitizeLayout keeps good data, rounds to millimetres and fills defaults', () => {
  const out = sanitizeLayout({
    walls: [wall('w1', [0, 0], [4.12345, 0])],
    openings: [{ id: 'o1', wall: 'w1', kind: 'window', at: 2 }],
    rooms: [{ id: 'r1', name: '  Kitchen ', points: [[0, 0], [4, 0], [4, 3]] }],
  });
  assert.equal(out.height, 2.5);
  assert.deepEqual(out.walls[0].b, [4.123, 0]);
  assert.deepEqual(out.openings[0], { id: 'o1', wall: 'w1', kind: 'window', at: 2, w: 1.2, h: 1.2, sill: 0.9, flip: 0 });
  assert.equal(out.rooms[0].name, 'Kitchen');
  assert.equal(out.background, null);
});

test('sanitizeLayout rejects broken input', () => {
  const bad = [
    null,
    { walls: 'nope' },
    { walls: [wall('w1', [0, 0], [0, 0])] }, // no length
    { walls: [wall('w1', [0, 0], [Infinity, 0])] },
    { walls: [wall('w1', [0, 0], [1e6, 0])] },
    { walls: [wall('w1', [0, 0], [1, 0]), wall('w1', [0, 1], [1, 1])] }, // duplicate id
    { walls: [wall('bad id!', [0, 0], [1, 0])] },
    { rooms: [{ id: 'r', points: [[0, 0], [1, 1]] }] },
    { height: 40 },
  ];
  for (const input of bad) assert.throws(() => sanitizeLayout(input), LayoutError, JSON.stringify(input));
});

test('openings fit their wall; openings on deleted walls are dropped', () => {
  const out = sanitizeLayout({
    height: 2.4,
    walls: [wall('w1', [0, 0], [3, 0])],
    openings: [
      { id: 'o1', wall: 'w1', kind: 'door', at: 2.9, w: 0.9, h: 2.1 }, // pokes past the end
      { id: 'o2', wall: 'gone', kind: 'door', at: 1 },
      { id: 'o3', wall: 'w1', kind: 'window', at: 1, w: 1, h: 1.2, sill: 2 }, // sill too high for the ceiling
    ],
  });
  assert.deepEqual(out.openings.map((o) => o.id), ['o1', 'o3']);
  assert.equal(out.openings[0].at, 2.55);
  assert.equal(out.openings[1].sill, 1.2);
});

test('the background image is only kept when the server has one', () => {
  const input = { walls: [], background: { x: 1, y: 2, scale: 0.0123456789, opacity: 0.3, v: 999 } };
  assert.equal(sanitizeLayout(input).background, null);
  const kept = sanitizeLayout(input, { background: { v: 7, x: 0, y: 0, scale: 0.01, opacity: 0.5 } });
  assert.deepEqual(kept.background, { v: 7, x: 1, y: 2, scale: 0.0123457, opacity: 0.3 });
});

test('wallPieces leaves holes for doors and windows', () => {
  const w = wall('w', [0, 0], [5, 0]);
  const pieces = wallPieces(w, [
    { wall: 'w', at: 1, w: 1, sill: 0, h: 2 }, // door 0.5–1.5
    { wall: 'w', at: 3.5, w: 1, sill: 1, h: 1 }, // window 3–4, 1–2 m up
  ], 2.5);
  assert.deepEqual(pieces, [
    { from: 0, to: 0.5, bottom: 0, top: 2.5 },
    { from: 0.5, to: 1.5, bottom: 2, top: 2.5 }, // above the door
    { from: 1.5, to: 3, bottom: 0, top: 2.5 },
    { from: 3, to: 4, bottom: 0, top: 1 }, // below the window
    { from: 3, to: 4, bottom: 2, top: 2.5 }, // above it
    { from: 4, to: 5, bottom: 0, top: 2.5 },
  ]);
});

test('walls reach into shared corners, free ends stay put', () => {
  const ext = wallEndExtensions([wall('a', [0, 0], [4, 0], 0.2), wall('b', [4, 0], [4, 3], 0.1)]);
  assert.deepEqual(ext, { a: [0, 0.05], b: [0.1, 0] });
});

test('polygonArea', () => {
  assert.equal(polygonArea([[0, 0], [4, 0], [4, 3], [0, 3]]), 12);
  assert.equal(polygonArea([[0, 0], [0, 3], [4, 3], [4, 0]]), 12);
});
