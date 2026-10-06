// 3D view of the layout: walls with real door and window holes, floors per
// room, and an orbit camera (drag to turn, pinch/scroll to zoom, two fingers
// or right-drag to pan). Renders only when something changes.
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/OrbitControls.js';
import { bounds, polygonCentroid, wallEndExtensions, wallFrame, wallPieces } from './model.js';

export class PlanViewer {
  constructor(container) {
    this.container = container;
    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio || 1, 2));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    container.appendChild(this.renderer.domElement);

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(50, 1, 0.05, 500);
    this.camera.position.set(8, 10, 12);
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.maxPolarAngle = Math.PI / 2 - 0.03;
    this.controls.minDistance = 0.5;
    this.controls.maxDistance = 120;
    this.controls.addEventListener('change', () => this.render());

    this.scene.add(new THREE.HemisphereLight(0xffffff, 0x8a8577, 1.6));
    const sun = new THREE.DirectionalLight(0xffffff, 1.6);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    sun.shadow.bias = -0.0004;
    sun.shadow.normalBias = 0.02;
    this.sun = sun;
    this.scene.add(sun, sun.target);

    this.materials = {
      wall: new THREE.MeshStandardMaterial({ color: 0xf3f1ec, roughness: 0.9 }),
      wallTop: new THREE.MeshStandardMaterial({ color: 0x4a4f4d, roughness: 0.9 }),
      floor: new THREE.MeshStandardMaterial({ color: 0xd9bf95, roughness: 0.75 }),
      ground: new THREE.MeshStandardMaterial({ color: 0xe9e6de, roughness: 1 }),
      glass: new THREE.MeshStandardMaterial({ color: 0x9cc7e6, roughness: 0.1, metalness: 0.1, transparent: true, opacity: 0.35 }),
      door: new THREE.MeshStandardMaterial({ color: 0xb08a5a, roughness: 0.7 }),
      frame: new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.6 }),
    };
    this.model = new THREE.Group();
    this.scene.add(this.model);
    this.cutaway = false;
    this.framed = false;
    this.labels = [];
    this.labelLayer = document.createElement('div');
    this.labelLayer.className = 'apt-3d-labels';
    container.appendChild(this.labelLayer);

    this.themeQuery = matchMedia('(prefers-color-scheme: dark)');
    this.themeChange = () => this.applyTheme();
    this.themeQuery.addEventListener('change', this.themeChange);
    this.applyTheme();

    this.observer = new ResizeObserver(() => this.resize());
    this.observer.observe(container);
  }

  applyTheme() {
    const dark = this.themeQuery.matches;
    this.scene.background = new THREE.Color(dark ? 0x161b19 : 0xeef0ec);
    this.materials.ground.color.set(dark ? 0x232a27 : 0xe2e0d8);
    this.render();
  }

  destroy() {
    this.observer.disconnect();
    this.themeQuery.removeEventListener('change', this.themeChange);
    this.controls.dispose();
    this.clear();
    for (const m of Object.values(this.materials)) m.dispose();
    this.renderer.dispose();
    this.renderer.domElement.remove();
    this.labelLayer.remove();
  }

  resize() {
    const { clientWidth: w, clientHeight: h } = this.container;
    if (!w || !h) return;
    this.renderer.setSize(w, h);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.render();
  }

  setCutaway(on) {
    this.cutaway = on;
    if (this.layout) this.build(this.layout);
  }

  clear() {
    this.model.traverse((o) => o.geometry?.dispose());
    this.model.clear();
  }

  // Plan (x, y) maps to world (x, -, y): y in the plan becomes depth.
  setLayout(layout) {
    this.layout = layout;
    this.build(layout);
    if (!this.framed && bounds(layout)) this.frame();
  }

  build(layout) {
    this.clear();
    const H = this.cutaway ? Math.min(1.1, layout.height) : layout.height;
    const b = bounds(layout) ?? { minX: 0, minY: 0, maxX: 6, maxY: 4 };
    const size = Math.max(b.maxX - b.minX, b.maxY - b.minY, 4);
    const cx = (b.minX + b.maxX) / 2;
    const cz = (b.minY + b.maxY) / 2;

    const ground = new THREE.Mesh(new THREE.CircleGeometry(size * 2.5, 64), this.materials.ground);
    ground.rotation.x = -Math.PI / 2;
    ground.position.set(cx, -0.02, cz);
    ground.receiveShadow = true;
    this.model.add(ground);

    // Floors: one per room, or the plan's footprint when there are no rooms.
    const floors = layout.rooms.length
      ? layout.rooms.map((r) => r.points)
      : layout.walls.length
        ? [[[b.minX, b.minY], [b.maxX, b.minY], [b.maxX, b.maxY], [b.minX, b.maxY]]]
        : [];
    for (const pts of floors) {
      // Shape is in the XY plane; rotating -90° about X maps shape y to -z, so flip y.
      const shape = new THREE.Shape(pts.map(([x, y]) => new THREE.Vector2(x, -y)));
      const floor = new THREE.Mesh(new THREE.ShapeGeometry(shape), this.materials.floor);
      floor.rotation.x = -Math.PI / 2;
      floor.position.y = 0.001;
      floor.receiveShadow = true;
      this.model.add(floor);
    }

    const ext = wallEndExtensions(layout.walls);
    for (const wall of layout.walls) {
      const { len, dx, dy } = wallFrame(wall);
      const angle = Math.atan2(dy, dx);
      const [ea, eb] = ext[wall.id];
      for (const piece of wallPieces(wall, layout.openings, layout.height)) {
        const top = Math.min(piece.top, H);
        if (piece.bottom >= top - 1e-6) continue;
        // Full-height pieces at the wall's ends reach into joined corners.
        const from = piece.from <= 1e-6 && piece.bottom <= 1e-6 ? -ea : piece.from;
        const to = piece.to >= len - 1e-6 && piece.bottom <= 1e-6 ? len + eb : piece.to;
        const mid = (from + to) / 2;
        const mesh = this.box(to - from, top - piece.bottom, wall.t, this.wallMaterials(top >= H - 1e-6));
        mesh.position.set(wall.a[0] + dx * mid, piece.bottom + (top - piece.bottom) / 2, wall.a[1] + dy * mid);
        mesh.rotation.y = -angle;
        this.model.add(mesh);
      }
    }

    for (const o of layout.openings) {
      const wall = layout.walls.find((w) => w.id === o.wall);
      if (!wall) continue;
      const { dx, dy, nx, ny } = wallFrame(wall);
      const angle = Math.atan2(dy, dx);
      const c = [wall.a[0] + dx * o.at, wall.a[1] + dy * o.at];
      if (o.kind === 'window') {
        if (o.sill >= H) continue;
        const h = Math.min(o.h, H - o.sill);
        const glass = this.box(o.w, h, 0.02, this.materials.glass, false);
        glass.position.set(c[0], o.sill + h / 2, c[1]);
        glass.rotation.y = -angle;
        this.model.add(glass);
        const sill = this.box(o.w + 0.06, 0.03, wall.t + 0.06, this.materials.frame);
        sill.position.set(c[0], o.sill, c[1]);
        sill.rotation.y = -angle;
        this.model.add(sill);
      } else {
        // An open door leaf, standing at 90° from the wall like in the plan.
        const h = Math.min(o.h, H);
        const hingeSign = o.flip & 1 ? 1 : -1;
        const side = o.flip & 2 ? -1 : 1;
        const hinge = [c[0] + (dx * hingeSign * o.w) / 2, c[1] + (dy * hingeSign * o.w) / 2];
        const leaf = this.box(o.w - 0.02, h - 0.01, 0.04, this.materials.door);
        const along = [nx * side, ny * side];
        leaf.position.set(hinge[0] + (along[0] * o.w) / 2 - dx * hingeSign * 0.02, h / 2, hinge[1] + (along[1] * o.w) / 2 - dy * hingeSign * 0.02);
        leaf.rotation.y = -Math.atan2(along[1], along[0]);
        this.model.add(leaf);
      }
    }

    this.updateSun(cx, cz, size);
    this.layoutLabels = layout.rooms.filter((r) => r.name).map((r) => ({ name: r.name, at: polygonCentroid(r.points) }));
    this.render();
  }

  wallMaterials(capped) {
    if (!capped) return this.materials.wall;
    // BoxGeometry face order: +x, -x, +y (top), -y, +z, -z.
    const m = this.materials;
    return [m.wall, m.wall, m.wallTop, m.wall, m.wall, m.wall];
  }

  box(w, h, d, material, shadows = true) {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), material);
    mesh.castShadow = shadows;
    mesh.receiveShadow = shadows;
    return mesh;
  }

  updateSun(cx, cz, size) {
    this.sun.position.set(cx + size * 0.6, size * 1.6, cz + size * 0.9);
    this.sun.target.position.set(cx, 0, cz);
    const cam = this.sun.shadow.camera;
    cam.left = cam.bottom = -size * 1.2;
    cam.right = cam.top = size * 1.2;
    cam.near = 0.1;
    cam.far = size * 5;
    cam.updateProjectionMatrix();
  }

  // Looks at the whole apartment from above at an angle.
  frame() {
    const b = bounds(this.layout) ?? { minX: 0, minY: 0, maxX: 6, maxY: 4 };
    const cx = (b.minX + b.maxX) / 2;
    const cz = (b.minY + b.maxY) / 2;
    const size = Math.max(b.maxX - b.minX, b.maxY - b.minY, 3);
    this.controls.target.set(cx, 0, cz);
    this.camera.position.set(cx + size * 0.12, size * 0.9, cz + size * 0.8);
    this.controls.update();
    this.framed = true;
    this.render();
  }

  render() {
    if (this.frameRequest) return;
    this.frameRequest = requestAnimationFrame(() => {
      this.frameRequest = null;
      this.renderer.render(this.scene, this.camera);
      this.placeLabels();
    });
  }

  // Room names float over each floor as plain HTML.
  placeLabels() {
    const items = this.layoutLabels ?? [];
    while (this.labels.length < items.length) {
      const el = document.createElement('span');
      this.labelLayer.appendChild(el);
      this.labels.push(el);
    }
    const { clientWidth: w, clientHeight: h } = this.container;
    const v = new THREE.Vector3();
    this.labels.forEach((el, i) => {
      const item = items[i];
      if (!item) return (el.hidden = true);
      v.set(item.at[0], 0.05, item.at[1]).project(this.camera);
      const visible = v.z < 1 && Math.abs(v.x) <= 1.1 && Math.abs(v.y) <= 1.1;
      el.hidden = !visible;
      el.textContent = item.name;
      el.style.transform = `translate(${((v.x + 1) / 2) * w}px, ${((1 - v.y) / 2) * h}px) translate(-50%, -50%)`;
    });
  }
}
