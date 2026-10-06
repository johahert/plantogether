// Finds walls in a floor plan image: the long, thick, dark strokes.
// Works on straight horizontal/vertical walls, which covers most apartment
// plans; anything it misses or gets wrong can be fixed in the editor.
//
// detectWalls({ width, height, data }) -> { walls: [{ a, b, t }], thickness }
// with everything in image pixels. `data` is RGBA, like canvas ImageData.

export function detectWalls(image, { minLength } = {}) {
  const { width: W, height: H } = image;
  const dark = darkMask(image);

  // Stroke thickness at each dark pixel: the shorter of its horizontal and
  // vertical run. Thin lines (furniture, dimensions, text) are 1–2 px.
  const hrun = runLengths(dark, W, H, true);
  const vrun = runLengths(dark, W, H, false);
  const longRun = Math.max(20, Math.round(Math.min(W, H) * 0.04));
  const counts = [];
  for (let i = 0; i < dark.length; i++) {
    if (!dark[i] || Math.max(hrun[i], vrun[i]) < longRun) continue;
    const t = Math.min(hrun[i], vrun[i]);
    counts[t] = (counts[t] || 0) + 1;
  }
  // The most common thickness among long strokes is a typical wall. (Junction
  // pixels give huge readings, so a high percentile would be misleading.)
  const tWall = mode(counts, 2) || mode(counts, 1);
  if (!tWall) return { walls: [], thickness: 0 };
  const tMin = tWall <= 2 ? 1 : Math.max(2, Math.round(tWall * 0.3));

  const mask = new Uint8Array(W * H);
  for (let i = 0; i < mask.length; i++) mask[i] = dark[i] && Math.min(hrun[i], vrun[i]) >= tMin ? 1 : 0;

  const minLen = minLength ?? Math.max(4 * tMin, 10);
  const maxThick = Math.max(tWall * 3, tMin + 2);
  const tol = Math.max(2, tMin);
  const walls = [
    ...bands(mask, W, H, true, minLen, tol, tMin, maxThick),
    ...bands(mask, W, H, false, minLen, tol, tMin, maxThick),
  ];
  return { walls: joinCorners(mergeCollinear(walls, tol)), thickness: tWall };
}

function darkMask({ width, height, data }) {
  const n = width * height;
  const gray = new Uint8Array(n);
  const hist = new Array(256).fill(0);
  for (let i = 0; i < n; i++) {
    const a = data[i * 4 + 3] / 255;
    const lum = 0.299 * data[i * 4] + 0.587 * data[i * 4 + 1] + 0.114 * data[i * 4 + 2];
    gray[i] = Math.round(lum * a + 255 * (1 - a)); // transparent counts as white paper
    hist[gray[i]]++;
  }
  const threshold = Math.min(otsu(hist, n), 160);
  const mask = new Uint8Array(n);
  let darkCount = 0;
  for (let i = 0; i < n; i++) {
    mask[i] = gray[i] < threshold ? 1 : 0;
    darkCount += mask[i];
  }
  if (darkCount > n / 2) for (let i = 0; i < n; i++) mask[i] ^= 1; // light lines on a dark background
  return mask;
}

function otsu(hist, total) {
  let sum = 0;
  for (let t = 0; t < 256; t++) sum += t * hist[t];
  let sumB = 0;
  let wB = 0;
  let best = 0;
  let threshold = 128;
  for (let t = 0; t < 256; t++) {
    wB += hist[t];
    if (!wB) continue;
    const wF = total - wB;
    if (!wF) break;
    sumB += t * hist[t];
    const between = wB * wF * (sumB / wB - (sum - sumB) / wF) ** 2;
    if (between > best) {
      best = between;
      threshold = t + 1;
    }
  }
  return threshold;
}

// For every pixel, the length of the dark run it belongs to (row- or column-wise).
function runLengths(mask, W, H, horizontal) {
  const out = new Uint16Array(W * H);
  const lines = horizontal ? H : W;
  const len = horizontal ? W : H;
  const idx = horizontal ? (line, k) => line * W + k : (line, k) => k * W + line;
  for (let line = 0; line < lines; line++) {
    let start = -1;
    for (let k = 0; k <= len; k++) {
      const on = k < len && mask[idx(line, k)];
      if (on && start < 0) start = k;
      if (!on && start >= 0) {
        const run = Math.min(k - start, 65535);
        for (let j = start; j < k; j++) out[idx(line, j)] = run;
        start = -1;
      }
    }
  }
  return out;
}

function mode(counts, from) {
  let best = 0;
  for (let t = from; t < counts.length; t++) if ((counts[t] || 0) > (counts[best] || 0)) best = t;
  return counts[best] ? best : 0;
}

// Stacks long runs from consecutive rows (or columns) into bands; each
// elongated band is one wall, its centre line running along the band.
function bands(mask, W, H, horizontal, minLen, tol, tMin, maxThick) {
  const lines = horizontal ? H : W;
  const len = horizontal ? W : H;
  const at = horizontal ? (line, k) => mask[line * W + k] : (line, k) => mask[k * W + line];
  const done = [];
  let open = [];
  for (let line = 0; line <= lines; line++) {
    const runs = [];
    if (line < lines) {
      let start = -1;
      for (let k = 0; k <= len; k++) {
        const on = k < len && at(line, k);
        if (on && start < 0) start = k;
        if (!on && start >= 0) {
          if (k - start >= minLen) runs.push([start, k]);
          start = -1;
        }
      }
    }
    const next = [];
    for (const [s, e] of runs) {
      const band = open.find((b) => !b.used && Math.abs(b.s - s) <= tol && Math.abs(b.e - e) <= tol);
      if (band) {
        band.used = true;
        band.last = line;
        band.ss += s;
        band.es += e;
        band.n += 1;
        next.push(band);
      } else {
        next.push({ first: line, last: line, s, e, ss: s, es: e, n: 1, used: true });
      }
    }
    for (const band of open) if (!band.used) done.push(band);
    for (const band of next) band.used = false;
    open = next;
  }

  const walls = [];
  for (const band of done) {
    const thick = band.last - band.first + 1;
    const s = band.ss / band.n;
    const e = band.es / band.n;
    if (thick < Math.max(1, tMin * 0.5) || thick > maxThick || e - s < Math.max(minLen, thick * 2)) continue;
    const c = (band.first + band.last + 1) / 2;
    walls.push(horizontal ? { a: [s, c], b: [e, c], t: thick } : { a: [c, s], b: [c, e], t: thick });
  }
  return walls;
}

const isHorizontal = (w) => w.a[1] === w.b[1];

// Joins pieces of one wall that a crossing line or label split apart.
function mergeCollinear(walls, tol) {
  const out = [];
  for (const horizontal of [true, false]) {
    const ax = horizontal ? 0 : 1; // along
    const cx = 1 - ax; // across
    const group = walls.filter((w) => isHorizontal(w) === horizontal).sort((p, q) => p.a[cx] - q.a[cx] || p.a[ax] - q.a[ax]);
    const used = new Set();
    for (const w of group) {
      if (used.has(w)) continue;
      used.add(w);
      const merged = { a: [...w.a], b: [...w.b], t: w.t };
      let grew = true;
      while (grew) {
        grew = false;
        for (const o of group) {
          if (used.has(o) || Math.abs(o.a[cx] - merged.a[cx]) > tol) continue;
          if (o.a[ax] > merged.b[ax] + tol || o.b[ax] < merged.a[ax] - tol) continue;
          used.add(o);
          merged.a[ax] = Math.min(merged.a[ax], o.a[ax]);
          merged.b[ax] = Math.max(merged.b[ax], o.b[ax]);
          merged.t = Math.max(merged.t, o.t);
          grew = true;
        }
      }
      out.push(merged);
    }
  }
  return out;
}

// Moves wall ends onto the centre line of the wall they run into, so that
// corners and T-junctions meet cleanly instead of overlapping.
function joinCorners(walls) {
  for (const w of walls) {
    const ax = isHorizontal(w) ? 0 : 1;
    const cx = 1 - ax;
    for (const end of ['a', 'b']) {
      const p = w[end];
      let best = null;
      for (const o of walls) {
        if (o === w || isHorizontal(o) === isHorizontal(w)) continue;
        const line = o.a[ax]; // the other wall's centre, measured along our axis
        const reach = Math.max(o.t, w.t);
        if (Math.abs(p[ax] - line) > reach) continue;
        const lo = Math.min(o.a[cx], o.b[cx]) - reach;
        const hi = Math.max(o.a[cx], o.b[cx]) + reach;
        if (p[cx] < lo || p[cx] > hi) continue;
        const d = Math.abs(p[ax] - line);
        if (!best || d < best.d) best = { o, d, line };
      }
      if (!best) continue;
      p[ax] = best.line;
      // An L corner: pull the other wall's nearest end onto our centre line too.
      const o = best.o;
      const near = Math.abs(o.a[cx] - p[cx]) < Math.abs(o.b[cx] - p[cx]) ? o.a : o.b;
      if (Math.abs(near[cx] - p[cx]) <= Math.max(o.t, w.t)) near[cx] = p[cx];
    }
  }
  return walls.filter((w) => Math.hypot(w.b[0] - w.a[0], w.b[1] - w.a[1]) > w.t);
}
