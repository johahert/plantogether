// The Apartment tab: toolbar, 2D editor, 3D view, properties panel, saving,
// undo, and getting a floor plan image in (upload, measure, detect walls).
import { PlanEditor } from './editor2d.js';
import { detectWalls } from './detect.js';
import {
  DEFAULTS,
  bounds,
  clamp,
  emptyLayout,
  formatArea,
  formatLength,
  newLocalId,
  polygonArea,
  wallFrame,
  wallLength,
} from './model.js';

const MODE_KEY = 'plantogether:aptMode';
const MAX_UPLOAD_SIDE = 2400;

const TOOLS = [
  ['select', 'Select', '<path d="M5 3l14 8-6 1.6L10 19z"/>'],
  ['wall', 'Wall', '<path d="M4 20 20 4"/><circle cx="4" cy="20" r="2"/><circle cx="20" cy="4" r="2"/>'],
  ['room', 'Room', '<path d="M4 5h16v14H4z"/><path d="M9 5v4M4 12h5"/>'],
  ['door', 'Door', '<path d="M4 20h4V6M8 6a12 12 0 0 1 12 12"/>'],
  ['window', 'Window', '<path d="M3 9h18v6H3zM3 12h18"/>'],
];

const HINTS = {
  wall: 'Tap to place corners. Tap the last corner again (or press Enter) to finish.',
  room: 'Tap each corner of the room. Tap the first corner to close it.',
  door: 'Tap a wall to put a door in it.',
  window: 'Tap a wall to put a window in it.',
  calibrate: 'Measure: tap both ends of something you know the length of, like a wall.',
  image: 'Drag to move the floor plan image.',
};

const svg = (path) =>
  `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${path}</svg>`;

export function mountApartment(root, ctx) {
  const { esc, toast, api } = ctx;
  let list = ctx.list;
  let canEdit = ctx.canEdit;
  let layout = structuredClone(list.layout ?? emptyLayout());
  let committed = JSON.stringify(layout); // last state in the undo history
  let serverJson = JSON.stringify(list.layout ?? emptyLayout());
  const undo = [];
  const redo = [];
  let dirty = false;
  let saving = false;
  let saveTimer = null;
  let mode = localStorage.getItem(MODE_KEY) === '3d' ? '3d' : '2d';
  let viewer = null;
  let viewerLoading = null;
  let cutaway = false;
  let imageVersion = null;

  root.innerHTML = `
    <div class="apt">
      <div class="apt-bar">
        <div class="apt-switch" role="tablist">
          <button type="button" data-apt="mode" data-value="2d" role="tab">Plan</button>
          <button type="button" data-apt="mode" data-value="3d" role="tab">3D</button>
        </div>
        <div class="apt-tools" data-for="2d-edit">
          ${TOOLS.map(([t, label, icon]) => `<button type="button" class="apt-tool" data-apt="tool" data-value="${t}" title="${label}">${svg(icon)}<span>${label}</span></button>`).join('')}
          <button type="button" class="apt-tool" data-apt="add-room" title="Add a room by its size">${svg('<path d="M4 5h16v14H4zM12 9v6M9 12h6"/>')}<span>Size</span></button>
          <button type="button" class="apt-tool" data-apt="image" title="Floor plan image">${svg('<rect x="3" y="4" width="18" height="16" rx="2"/><path d="m3 16 5-5 4 4 3-3 6 6"/>')}<span>Image</span></button>
        </div>
        <div class="apt-tools" data-for="3d">
          <button type="button" class="apt-tool" data-apt="cutaway" title="Lower the walls to look inside">${svg('<path d="M4 20V10l8-6 8 6v10"/><path d="M4 14h16" stroke-dasharray="2 2"/>')}<span>Cut walls</span></button>
          <button type="button" class="apt-tool" data-apt="frame" title="Reset the camera">${svg('<path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/>')}<span>Reset view</span></button>
        </div>
        <span class="apt-spacer"></span>
        <div class="apt-tools" data-for="edit">
          <button type="button" class="apt-tool icon" data-apt="undo" title="Undo" aria-label="Undo">${svg('<path d="M9 14 4 9l5-5"/><path d="M4 9h11a5 5 0 0 1 0 10h-3"/>')}</button>
          <button type="button" class="apt-tool icon" data-apt="redo" title="Redo" aria-label="Redo">${svg('<path d="m15 14 5-5-5-5"/><path d="M20 9H9a5 5 0 0 0 0 10h3"/>')}</button>
        </div>
        <button type="button" class="apt-tool icon" data-apt="fit" data-for="2d" title="Show everything" aria-label="Show everything">${svg('<path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/>')}</button>
      </div>
      <div class="apt-stage">
        <canvas class="apt-canvas" aria-label="Floor plan editor"></canvas>
        <div class="apt-3d"></div>
        <div class="apt-hint" hidden></div>
        <div class="apt-empty" hidden></div>
        <div class="apt-drop" hidden><div>Drop the floor plan image here</div></div>
        <div class="apt-panel" hidden></div>
      </div>
      <input type="file" accept="image/png,image/jpeg,image/webp,image/gif" class="apt-file" hidden>
    </div>`;

  const $ = (sel) => root.querySelector(sel);
  const apt = $('.apt');
  const stage = $('.apt-stage');
  const panel = $('.apt-panel');
  const hint = $('.apt-hint');
  const fileInput = $('.apt-file');

  const editor = new PlanEditor($('.apt-canvas'), {
    readOnly: !canEdit,
    onCommit: (next) => commit(next),
    onSelect: () => renderPanel(),
    onTool: () => renderChrome(),
    onCalibrate: (p, q) => askCalibration(p, q),
  });
  editor.setLayout(layout);
  loadImage();

  // Fill the screen below the header.
  const place = () => {
    const header = document.querySelector('.top');
    apt.style.top = `${header ? header.getBoundingClientRect().bottom : 0}px`;
  };
  place();
  window.addEventListener('resize', place);

  // ---- layout changes -----------------------------------------------------

  function commit(next) {
    const json = JSON.stringify(next);
    if (json === committed) return;
    undo.push(committed);
    if (undo.length > 100) undo.shift();
    redo.length = 0;
    committed = json;
    layout = next;
    changed();
  }

  function changed() {
    dirty = true;
    viewer?.setLayout(layout);
    renderPanel();
    renderChrome();
    clearTimeout(saveTimer);
    saveTimer = setTimeout(save, 500);
  }

  function replaceLayout(next) {
    layout = next;
    editor.setLayout(layout);
    viewer?.setLayout(layout);
    renderPanel();
    renderChrome();
  }

  function step(from, to) {
    if (!from.length) return;
    to.push(committed);
    committed = from.pop();
    replaceLayout(JSON.parse(committed));
    changed();
  }

  async function save() {
    if (saving || !dirty) return;
    saving = true;
    dirty = false;
    let data = null;
    try {
      data = await api(`/lists/${list.id}/layout`, { method: 'PUT', body: layout });
    } catch (err) {
      toast(`Couldn’t save the layout: ${err.message}`, { error: true });
      dirty = true;
    }
    saving = false;
    if (data) ctx.applyList(data);
    if (dirty) saveTimer = setTimeout(save, 1500);
  }

  // A fresh copy of the plan came in (our own save, or someone else's edit).
  function update(nextList, nextCanEdit) {
    list = nextList;
    canEdit = nextCanEdit;
    const incoming = list.layout ?? emptyLayout();
    const json = JSON.stringify(incoming);
    if (json === serverJson) return;
    serverJson = json;
    loadImage();
    if (dirty || saving || editor.gesture?.snapshot) return; // ours is newer; it'll be saved over this
    if (json === JSON.stringify(layout)) return;
    committed = json;
    replaceLayout(structuredClone(incoming));
  }

  function loadImage() {
    const bg = (list.layout ?? layout).background;
    const v = bg?.v ?? null;
    if (v === imageVersion) return;
    imageVersion = v;
    if (!v) return editor.setImage(null);
    const img = new Image();
    img.onload = () => imageVersion === v && editor.setImage(img);
    img.src = `/api/lists/${list.id}/layout/image?v=${v}`;
  }

  // ---- chrome -------------------------------------------------------------

  function renderChrome() {
    apt.dataset.mode = mode;
    apt.classList.toggle('can-edit', canEdit);
    for (const b of root.querySelectorAll('[data-apt="mode"]')) b.setAttribute('aria-selected', b.dataset.value === mode);
    for (const b of root.querySelectorAll('[data-apt="tool"]')) b.setAttribute('aria-pressed', b.dataset.value === editor.tool);
    root.querySelector('[data-apt="cutaway"]').setAttribute('aria-pressed', cutaway);
    root.querySelector('[data-apt="undo"]').disabled = !undo.length;
    root.querySelector('[data-apt="redo"]').disabled = !redo.length;

    const text = mode === '2d' && HINTS[editor.tool];
    hint.hidden = !text;
    if (text) {
      hint.innerHTML = `<span>${esc(text)}</span><button type="button" class="btn small" data-apt="tool" data-value="select">${editor.tool === 'image' ? 'Done' : 'Cancel'}</button>`;
    }

    const empty = !layout.walls.length && !layout.rooms.length && !layout.background;
    const emptyEl = $('.apt-empty');
    emptyEl.hidden = !empty || editor.tool !== 'select';
    emptyEl.innerHTML = canEdit
      ? `<div class="card">
          <h2>Build your new apartment</h2>
          <p>Start from a floor plan picture, type in room sizes, or draw the walls yourself. You can mix all three.</p>
          <button type="button" class="btn primary block" data-apt="upload">Use a floor plan image</button>
          <button type="button" class="btn block" data-apt="add-room">Add a room by its size</button>
          <button type="button" class="btn ghost block" data-apt="tool" data-value="wall">Draw walls</button>
          <p class="hint">Tip: you can also drop or paste an image here.</p>
        </div>`
      : '<div class="card"><p>No apartment layout yet.</p></div>';
  }

  function field(label, name, value, { unit = '', step = 'any', type = 'number', min, max } = {}) {
    const attrs = type === 'number' ? `inputmode="decimal" step="${step}" ${min != null ? `min="${min}"` : ''} ${max != null ? `max="${max}"` : ''}` : 'maxlength="60"';
    return `<label class="apt-field"><span>${label}</span>
      <span class="apt-input"><input type="${type}" name="${name}" value="${esc(value)}" ${attrs} ${canEdit ? '' : 'readonly'}>${unit ? `<i>${unit}</i>` : ''}</span></label>`;
  }

  const cm = (m) => Math.round(m * 1000) / 10;

  function renderPanel() {
    const sel = editor.selection;
    const item = editor.selected();
    let html = '';
    if (!item) {
      const area = layout.rooms.reduce((sum, r) => sum + polygonArea(r.points), 0);
      if (!layout.walls.length && !layout.rooms.length) {
        panel.hidden = true;
        editor.insetBottom = 0;
        return;
      }
      html = `<div class="apt-summary">
        ${layout.rooms.length ? `<span><b>${formatArea(area)}</b> in ${layout.rooms.length} room${layout.rooms.length === 1 ? '' : 's'}</span>` : ''}
        <span>${layout.walls.length} wall${layout.walls.length === 1 ? '' : 's'}</span>
        ${field('Ceiling', 'height', layout.height, { unit: 'm', step: 0.05, min: 1.5, max: 8 })}
      </div>`;
    } else if (sel.type === 'wall') {
      html = `<div class="apt-row">
        <strong>Wall</strong>
        ${field('Length', 'length', Math.round(wallLength(item) * 1000) / 1000, { unit: 'm', step: 0.01, min: 0.05 })}
        ${field('Thickness', 'thickness', cm(item.t), { unit: 'cm', step: 1, min: 2, max: 150 })}
      </div>
      ${canEdit ? `<div class="apt-actions">
        <button type="button" class="btn small" data-apt="add-opening" data-value="door">+ Door</button>
        <button type="button" class="btn small" data-apt="add-opening" data-value="window">+ Window</button>
        <span class="apt-spacer"></span>
        <button type="button" class="btn small danger" data-apt="delete">Delete</button>
      </div>` : ''}`;
    } else if (sel.type === 'opening') {
      const wall = layout.walls.find((w) => w.id === item.wall);
      const door = item.kind === 'door';
      html = `<div class="apt-row">
        <strong>${door ? 'Door' : 'Window'}</strong>
        ${field('Width', 'w', cm(item.w), { unit: 'cm', step: 1, min: 10 })}
        ${field('Height', 'h', cm(item.h), { unit: 'cm', step: 1, min: 10 })}
        ${door ? '' : field('Sill', 'sill', cm(item.sill), { unit: 'cm', step: 1, min: 0 })}
        ${field('From corner', 'at', Math.round((item.at - item.w / 2) * 100) / 100, { unit: 'm', step: 0.01, min: 0 })}
      </div>
      ${canEdit ? `<div class="apt-actions">
        <button type="button" class="btn small" data-apt="kind">${door ? 'Make it a window' : 'Make it a door'}</button>
        ${door ? '<button type="button" class="btn small" data-apt="flip">Flip swing</button>' : ''}
        <span class="apt-spacer"></span>
        <button type="button" class="btn small danger" data-apt="delete">Delete</button>
      </div>` : ''}
      ${wall ? `<p class="apt-note">In a ${formatLength(wallLength(wall))} wall</p>` : ''}`;
    } else if (sel.type === 'room') {
      html = `<div class="apt-row">
        ${field('Room', 'name', item.name, { type: 'text' })}
        <span class="apt-area">${formatArea(polygonArea(item.points))}</span>
      </div>
      ${canEdit ? `<div class="apt-actions">
        <span class="apt-spacer"></span>
        <button type="button" class="btn small danger" data-apt="delete">Delete room</button>
      </div>` : ''}`;
    }
    // Don't wipe an input someone is typing in.
    const focused = panel.contains(document.activeElement) && document.activeElement.name;
    panel.hidden = false;
    panel.innerHTML = html;
    editor.insetBottom = panel.offsetHeight + 10;
    if (focused) {
      const input = panel.querySelector(`[name="${focused}"]`);
      input?.focus();
    }
  }

  // Panel inputs: apply on change (enter / leaving the field).
  panel.addEventListener('change', (e) => {
    if (!canEdit) return;
    const { name } = e.target;
    const raw = e.target.value.trim();
    const value = Number(raw.replace(',', '.'));
    const next = editor.layout;
    const item = editor.selected();
    const bad = () => {
      toast('That’s not a valid number', { error: true });
      renderPanel();
    };
    if (name === 'name') {
      item.name = raw.slice(0, 60);
      return editor.commit();
    }
    if (!Number.isFinite(value)) return bad();
    if (name === 'height') {
      next.height = clamp(value, 1.5, 8);
      for (const o of next.openings) {
        o.h = Math.min(o.h, next.height);
        o.sill = Math.min(o.sill, next.height - o.h);
      }
    } else if (name === 'length') {
      if (value < 0.05) return bad();
      // Keep the start, move the end (and whatever is joined to it).
      const { dx, dy } = wallFrame(item);
      const target = [item.a[0] + dx * value, item.a[1] + dy * value].map((v) => Math.round(v * 1000) / 1000);
      for (const p of editor.joinedAt(item.b)) {
        p[0] = target[0];
        p[1] = target[1];
      }
      for (const o of next.openings.filter((o) => o.wall === item.id)) {
        o.w = Math.min(o.w, value);
        o.at = clamp(o.at, o.w / 2, value - o.w / 2);
      }
    } else if (name === 'thickness') {
      item.t = clamp(value / 100, 0.02, 1.5);
    } else if (sel('opening')) {
      const wall = next.walls.find((w) => w.id === item.wall);
      const len = wallLength(wall);
      if (name === 'w') item.w = clamp(value / 100, 0.1, len);
      if (name === 'h') item.h = clamp(value / 100, 0.1, next.height);
      if (name === 'sill') item.sill = clamp(value / 100, 0, next.height - item.h);
      if (name === 'at') item.at = value + item.w / 2;
      item.at = clamp(item.at, item.w / 2, len - item.w / 2);
      item.sill = Math.min(item.sill, next.height - item.h);
    }
    editor.commit();
  });
  panel.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') e.target.blur?.();
  });
  const sel = (type) => editor.selection?.type === type;

  // ---- actions ------------------------------------------------------------

  const actions = {
    mode: (el) => setMode(el.dataset.value),
    tool: (el) => {
      if (mode !== '2d') setMode('2d');
      editor.setTool(el.dataset.value);
    },
    undo: () => step(undo, redo),
    redo: () => step(redo, undo),
    fit: () => editor.fit(),
    frame: () => viewer?.frame(),
    cutaway: () => {
      cutaway = !cutaway;
      viewer?.setCutaway(cutaway);
      renderChrome();
    },
    delete: () => editor.deleteSelected(),
    'add-opening': (el) => {
      const wall = editor.selected();
      const kind = el.dataset.value;
      const len = wallLength(wall);
      const def = DEFAULTS[kind];
      const w = Math.min(def.w, Math.max(len - 0.1, 0.3));
      const o = { id: newLocalId(), wall: wall.id, kind, at: len / 2, w, h: Math.min(def.h, layout.height - 0.1), sill: def.sill, flip: 0 };
      editor.layout.openings.push(o);
      editor.select({ type: 'opening', id: o.id });
      editor.commit();
    },
    kind: () => {
      const o = editor.selected();
      o.kind = o.kind === 'door' ? 'window' : 'door';
      Object.assign(o, { h: Math.min(DEFAULTS[o.kind].h, layout.height - 0.1), sill: DEFAULTS[o.kind].sill });
      editor.commit();
    },
    flip: () => {
      const o = editor.selected();
      o.flip = (o.flip + 1) % 4;
      editor.commit();
    },
    'add-room': () => openRoomSheet(),
    image: () => openImageSheet(),
    upload: () => fileInput.click(),
  };

  root.addEventListener('click', (e) => {
    const el = e.target.closest('[data-apt]');
    if (!el || !actions[el.dataset.apt] || el.disabled) return;
    e.preventDefault();
    actions[el.dataset.apt](el);
  });

  function onKey(e) {
    if (!canEdit || e.target.closest?.('input, textarea, select') || ctx.sheetOpen()) return;
    const mod = e.metaKey || e.ctrlKey;
    if (mod && e.key.toLowerCase() === 'z') {
      e.preventDefault();
      step(e.shiftKey ? redo : undo, e.shiftKey ? undo : redo);
    } else if (mod && e.key.toLowerCase() === 'y') {
      e.preventDefault();
      step(redo, undo);
    }
  }
  window.addEventListener('keydown', onKey);

  async function setMode(next) {
    mode = next === '3d' ? '3d' : '2d';
    try {
      localStorage.setItem(MODE_KEY, mode);
    } catch {
      // fine
    }
    renderChrome();
    if (mode === '3d') {
      if (editor.tool !== 'select') editor.setTool('select');
      await ensureViewer();
    }
  }

  function ensureViewer() {
    viewerLoading ??= import('./view3d.js')
      .then(({ PlanViewer }) => {
        viewer = new PlanViewer($('.apt-3d'));
        viewer.setCutaway(cutaway);
        viewer.setLayout(layout);
      })
      .catch((err) => {
        viewerLoading = null;
        toast(`Couldn’t start the 3D view (${err.message})`, { error: true });
      });
    return viewerLoading;
  }

  // ---- add a room by size -------------------------------------------------

  function openRoomSheet() {
    ctx.openSheet(
      `<h2>Add a room by its size</h2>
      <p class="hint">Walls are added around it. Drag it into place afterwards, its corners snap to other walls.</p>
      <label class="field"><span>Name</span><input name="name" maxlength="60" placeholder="e.g. Living room"></label>
      <div class="row">
        <label class="field grow"><span>Width (m)</span><input name="w" inputmode="decimal" required placeholder="e.g. 4.2"></label>
        <label class="field grow"><span>Length (m)</span><input name="d" inputmode="decimal" required placeholder="e.g. 3.5"></label>
      </div>
      <div class="actions"><span class="spacer"></span>
        <button type="button" class="btn ghost" data-action="close-sheet">Cancel</button>
        <button class="btn primary">Add room</button></div>`,
      async (data) => {
        const w = Number(String(data.w).replace(',', '.'));
        const d = Number(String(data.d).replace(',', '.'));
        if (!(w >= 0.3 && w <= 100 && d >= 0.3 && d <= 100)) {
          toast('Give a width and length between 0.3 and 100 metres', { error: true });
          return false;
        }
        if (mode !== '2d') await setMode('2d');
        editor.setTool('select');
        // Next to what's already there, sharing its top edge.
        const b = bounds(editor.layout);
        const x = b ? b.maxX : 0;
        const y = b ? b.minY : 0;
        const c = [[x, y], [x + w, y], [x + w, y + d], [x, y + d]].map((p) => p.map((v) => Math.round(v * 1000) / 1000));
        const room = { id: newLocalId(), name: data.name.trim().slice(0, 60), points: c };
        editor.layout.rooms.push(room);
        editor.addWallsAlong([...c, c[0]]);
        editor.select({ type: 'room', id: room.id });
        editor.commit();
        editor.fit();
        return true;
      },
    ).elements.name.focus();
  }

  // ---- floor plan image ---------------------------------------------------

  function openImageSheet() {
    const bg = layout.background;
    if (!bg) return fileInput.click();
    const form = ctx.openSheet(
      `<h2>Floor plan image</h2>
      <label class="field"><span>Visibility</span>
        <input type="range" name="opacity" min="0" max="1" step="0.05" value="${bg.opacity}"></label>
      <div class="apt-sheet-buttons">
        <button type="button" class="btn" data-apt-sheet="calibrate">📏 Measure scale</button>
        <button type="button" class="btn" data-apt-sheet="detect">✨ Find walls</button>
        <button type="button" class="btn" data-apt-sheet="move">✋ Move image</button>
        <button type="button" class="btn" data-apt-sheet="replace">Replace image</button>
        <button type="button" class="btn danger" data-apt-sheet="remove">Remove image</button>
      </div>
      <p class="hint">Measure the scale first: tap both ends of a wall whose length you know. Then let ✨ find the walls, or trace them with the Wall tool.</p>
      <div class="actions"><span class="spacer"></span><button class="btn primary">Done</button></div>`,
      async () => true,
    );
    form.elements.opacity.addEventListener('input', (e) => {
      editor.layout.background.opacity = Number(e.target.value);
      editor.draw();
    });
    form.elements.opacity.addEventListener('change', () => editor.commit());
    form.addEventListener('click', async (e) => {
      const action = e.target.closest('[data-apt-sheet]')?.dataset.aptSheet;
      if (!action) return;
      ctx.closeSheet();
      if (mode !== '2d') await setMode('2d');
      if (action === 'calibrate') editor.setTool('calibrate');
      if (action === 'move') editor.setTool('image');
      if (action === 'detect') findWalls();
      if (action === 'replace') fileInput.click();
      if (action === 'remove' && confirm('Remove the floor plan image? Your walls and rooms stay.')) removeImage();
    });
  }

  fileInput.addEventListener('change', () => {
    const file = fileInput.files[0];
    fileInput.value = '';
    if (file) uploadImage(file);
  });

  // Drag & drop and paste.
  let dragDepth = 0;
  const hasFiles = (e) => [...(e.dataTransfer?.types ?? [])].includes('Files');
  stage.addEventListener('dragenter', (e) => {
    if (!canEdit || !hasFiles(e)) return;
    e.preventDefault();
    dragDepth++;
    $('.apt-drop').hidden = false;
  });
  stage.addEventListener('dragover', (e) => canEdit && hasFiles(e) && e.preventDefault());
  stage.addEventListener('dragleave', () => {
    if (--dragDepth <= 0) {
      dragDepth = 0;
      $('.apt-drop').hidden = true;
    }
  });
  stage.addEventListener('drop', (e) => {
    if (!canEdit) return;
    e.preventDefault();
    dragDepth = 0;
    $('.apt-drop').hidden = true;
    const file = [...e.dataTransfer.files].find((f) => f.type.startsWith('image/'));
    if (file) uploadImage(file);
    else toast('Drop an image file (PNG, JPEG or WebP)', { error: true });
  });
  function onPaste(e) {
    if (!canEdit || ctx.sheetOpen() || e.target.closest?.('input, textarea')) return;
    const file = [...(e.clipboardData?.files ?? [])].find((f) => f.type.startsWith('image/'));
    if (!file) return;
    e.preventDefault();
    uploadImage(file);
  }
  window.addEventListener('paste', onPaste);

  // Big photos get shrunk before upload; plans don't need more than ~2400 px.
  async function prepareImage(file) {
    const bitmap = await createImageBitmap(file);
    const { width, height } = bitmap;
    const factor = Math.min(1, MAX_UPLOAD_SIDE / Math.max(width, height));
    if (factor === 1 && file.size <= 4 * 1024 * 1024 && /^image\/(png|jpeg|webp|gif)$/.test(file.type)) {
      bitmap.close?.();
      return { blob: file, width, height };
    }
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(width * factor);
    canvas.height = Math.round(height * factor);
    const c2 = canvas.getContext('2d');
    c2.fillStyle = '#fff';
    c2.fillRect(0, 0, canvas.width, canvas.height);
    c2.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    bitmap.close?.();
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.9));
    return { blob, width: canvas.width, height: canvas.height };
  }

  async function uploadImage(file) {
    toast('Uploading floor plan…');
    try {
      const { blob, width, height } = await prepareImage(file);
      // First guess: the drawing is about 12 m wide. Measuring fixes it.
      const b = bounds(editor.layout);
      const scale = b ? Math.max(b.maxX - b.minX, 3) / width : 12 / Math.max(width, height);
      const params = new URLSearchParams({ x: b ? b.minX : 0, y: b ? b.minY : 0, scale: scale.toPrecision(6) });
      const res = await fetch(`/api/lists/${list.id}/layout/image?${params}`, {
        method: 'PUT',
        headers: { 'content-type': blob.type || 'application/octet-stream', 'x-edit-key': ctx.key() },
        body: blob,
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || `Upload failed (${res.status})`);
      // Take the new image placement into our copy, whatever else is pending.
      editor.layout.background = data.list.layout.background;
      layout = editor.layout;
      committed = JSON.stringify(layout);
      ctx.applyList(data);
      loadImage();
      if (mode !== '2d') await setMode('2d');
      editor.fitted = false;
      editor.fit();
      editor.setTool('calibrate');
      toast('Now measure: tap both ends of a wall you know the length of');
    } catch (err) {
      toast(err.message, { error: true });
    }
  }

  async function removeImage() {
    try {
      const data = await api(`/lists/${list.id}/layout/image`, { method: 'DELETE' });
      editor.layout.background = null;
      layout = editor.layout;
      committed = JSON.stringify(layout);
      ctx.applyList(data);
      loadImage();
      renderChrome();
    } catch (err) {
      toast(err.message, { error: true });
    }
  }

  function askCalibration(p, q) {
    const measured = Math.hypot(q[0] - p[0], q[1] - p[1]);
    if (measured < 1e-4) return;
    const hasDrawing = editor.layout.walls.length || editor.layout.rooms.length;
    const form = ctx.openSheet(
      `<h2>How long is that?</h2>
      <p class="hint">It measures ${formatLength(measured)} right now.</p>
      <label class="field"><span>Real length (m)</span>
        <input name="real" inputmode="decimal" required placeholder="e.g. 4.5"></label>
      ${hasDrawing ? '<label class="apt-check"><input type="checkbox" name="all" checked> Also resize the walls and rooms</label>' : ''}
      <div class="actions"><span class="spacer"></span>
        <button type="button" class="btn ghost" data-action="close-sheet">Cancel</button>
        <button class="btn primary">Set scale</button></div>`,
      async (data) => {
        const real = Number(String(data.real).replace(',', '.'));
        if (!(real > 0.05 && real < 500)) {
          toast('Enter the length in metres, like 4.5', { error: true });
          return false;
        }
        const f = real / measured;
        const L = editor.layout;
        const about = (v, o) => Math.round((o + (v - o) * f) * 1000) / 1000;
        if (L.background) {
          L.background.x = about(L.background.x, p[0]);
          L.background.y = about(L.background.y, p[1]);
          L.background.scale = Number((L.background.scale * f).toPrecision(6));
        }
        if (data.all) {
          for (const pt of editor.allPoints()) {
            pt[0] = about(pt[0], p[0]);
            pt[1] = about(pt[1], p[1]);
          }
          for (const o of L.openings) o.at = Math.round(o.at * f * 1000) / 1000;
        }
        editor.commit();
        editor.fit();
        if (!L.walls.length) offerDetection();
        return true;
      },
    );
    form.elements.real.focus();
  }

  function offerDetection() {
    setTimeout(() => {
      ctx.openSheet(
        `<h2>Find the walls?</h2>
        <p class="hint">PlanTogether can look for the thick dark lines in your image and turn them into walls. Works best on clean, straight plans. You can fix anything afterwards.</p>
        <div class="actions"><span class="spacer"></span>
          <button type="button" class="btn ghost" data-action="close-sheet">I’ll draw them</button>
          <button class="btn primary">✨ Find walls</button></div>`,
        async () => {
          setTimeout(findWalls, 50);
          return true;
        },
      );
    }, 250);
  }

  function findWalls() {
    const img = editor.image;
    const bg = editor.layout.background;
    if (!img || !bg) return toast('Add a floor plan image first', { error: true });
    if (editor.layout.walls.length && !confirm('Replace the walls you have with the ones found in the image?')) return;
    toast('Looking for walls…');
    setTimeout(() => {
      const factor = Math.min(1, 2000 / Math.max(img.naturalWidth, img.naturalHeight));
      const canvas = document.createElement('canvas');
      canvas.width = Math.round(img.naturalWidth * factor);
      canvas.height = Math.round(img.naturalHeight * factor);
      const c2 = canvas.getContext('2d', { willReadFrequently: true });
      c2.fillStyle = '#fff';
      c2.fillRect(0, 0, canvas.width, canvas.height);
      c2.drawImage(img, 0, 0, canvas.width, canvas.height);
      const { walls } = detectWalls(c2.getImageData(0, 0, canvas.width, canvas.height));
      const m = bg.scale / factor; // metres per detection pixel
      const toWorld = ([px, py]) => [Math.round((bg.x + px * m) * 1000) / 1000, Math.round((bg.y + py * m) * 1000) / 1000];
      const found = walls
        .map((w) => ({ id: newLocalId(), a: toWorld(w.a), b: toWorld(w.b), t: clamp(Math.round(w.t * m * 100) / 100, 0.05, 0.5) }))
        .filter((w) => wallLength(w) >= 0.1);
      if (!found.length) return toast('Couldn’t find walls in this image. Trace them with the Wall tool instead.', { error: true });
      const L = editor.layout;
      L.walls = found;
      L.openings = [];
      editor.select(null);
      editor.commit();
      toast(`Found ${found.length} walls. Tap one to adjust it, then add doors, windows and rooms.`);
    }, 30);
  }

  renderChrome();
  renderPanel();
  if (mode === '3d') ensureViewer();

  return {
    update,
    destroy() {
      clearTimeout(saveTimer);
      if (dirty) save();
      editor.destroy();
      viewer?.destroy();
      window.removeEventListener('resize', place);
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('paste', onPaste);
    },
  };
}
