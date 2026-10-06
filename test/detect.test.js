import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectWalls } from '../public/apartment/detect.js';

// A white "image" with black filled rectangles, plus thin noise lines.
function drawPlan(W, H, rects, thinLines = []) {
  const data = new Uint8ClampedArray(W * H * 4).fill(255);
  const fill = ([x0, y0, x1, y1], v) => {
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
      const i = (y * W + x) * 4;
      data[i] = data[i + 1] = data[i + 2] = v;
    }
  };
  for (const r of thinLines) fill(r, 60);
  for (const r of rects) fill(r, 0);
  return { width: W, height: H, data };
}

const near = (a, b, tol = 3) => Math.abs(a - b) <= tol;

test('finds the walls of a two-room plan and joins the corners', () => {
  // Outer box 20 px walls from (20,20) to (420,320); an inner 10 px wall at x≈220
  // with a door gap between y=200 and y=260.
  const img = drawPlan(460, 360, [
    [20, 20, 420, 40], // top
    [20, 300, 420, 320], // bottom
    [20, 20, 40, 320], // left
    [400, 20, 420, 320], // right
    [215, 40, 225, 200], // inner, upper part
    [215, 260, 225, 300], // inner, below the door
  ], [
    [60, 120, 380, 121], // a thin dimension line
    [60, 60, 61, 280],
  ]);
  const { walls, thickness } = detectWalls(img);
  assert.ok(thickness >= 18 && thickness <= 22, `thickness ${thickness}`);

  const horizontal = walls.filter((w) => w.a[1] === w.b[1]);
  const vertical = walls.filter((w) => w.a[0] === w.b[0]);
  assert.equal(horizontal.length, 2, JSON.stringify(walls));
  assert.equal(vertical.length, 4, JSON.stringify(walls));

  const top = horizontal.find((w) => w.a[1] < 100);
  assert.ok(near(top.a[1], 30) && near(top.a[0], 30) && near(top.b[0], 410), JSON.stringify(top));
  const left = vertical.find((w) => w.a[0] < 100);
  assert.ok(near(left.a[1], 30) && near(left.b[1], 310), JSON.stringify(left));
  // Corners meet: the top wall's start is the left wall's start.
  assert.deepEqual(top.a, left.a);

  // The inner wall keeps its door gap and joins the outer walls.
  const inner = vertical.filter((w) => near(w.a[0], 220)).sort((p, q) => p.a[1] - q.a[1]);
  assert.equal(inner.length, 2);
  assert.ok(near(inner[0].a[1], 30) && near(inner[0].b[1], 200), JSON.stringify(inner[0]));
  assert.ok(near(inner[1].a[1], 260) && near(inner[1].b[1], 310), JSON.stringify(inner[1]));
  assert.ok(inner[0].t < top.t);
});

test('an empty page has no walls', () => {
  assert.deepEqual(detectWalls(drawPlan(100, 80, [])).walls, []);
});
