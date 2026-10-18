import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { MapControls } from 'three/addons/controls/MapControls.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';

// GLTFLoader strips characters such as "." and spaces from node names, so compare loosely.
const looseName = (s) => (s || '').replace(/[\s._:/[\]-]/g, '').toLowerCase();
const easeInOut = (t) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);

export class SchoolViewer {
  constructor(canvas) {
    this.canvas = canvas;
    this.frameCallbacks = new Set();
    this.tween = null;

    const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.05;
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFShadowMap;
    this.renderer = renderer;

    const scene = new THREE.Scene();
    const sky = new THREE.Color(0xdbe8f0);
    scene.background = sky;
    scene.fog = new THREE.Fog(sky, 700, 1800);
    const pmrem = new THREE.PMREMGenerator(renderer);
    scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    scene.environmentIntensity = 0.45;
    // Glass reflects an outdoor sky instead of the neutral studio light used for everything else.
    this.skyEnvironment = pmrem.fromScene(buildSkyScene(), 0).texture;
    pmrem.dispose();
    this.scene = scene;

    scene.add(new THREE.HemisphereLight(0xf2f7ff, 0x6b7a5a, 1.4));
    const sun = new THREE.DirectionalLight(0xfff3df, 2.4);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    sun.shadow.bias = -0.0004;
    sun.shadow.normalBias = 0.6;
    scene.add(sun, sun.target);
    this.sun = sun;

    this.camera = new THREE.PerspectiveCamera(40, 1, 1, 5000);
    const controls = new MapControls(this.camera, canvas);
    controls.enableDamping = true;
    controls.dampingFactor = 0.09;
    controls.maxPolarAngle = THREE.MathUtils.degToRad(80);
    controls.minDistance = 12;
    controls.maxDistance = 1100;
    controls.zoomToCursor = true;
    controls.addEventListener('start', () => {
      this.tween = null;
      this.onUserMove?.();
    });
    this.controls = controls;

    this.raycaster = new THREE.Raycaster();
    this.bindTaps();
    this.resize();
    window.addEventListener('resize', () => this.resize());
    renderer.setAnimationLoop((t) => this.tick(t));
  }

  /** Calls this.onTap(clientX, clientY) for a short single-finger tap or click that did not drag the map. */
  bindTaps() {
    let down = null;
    this.canvas.addEventListener('pointerdown', (e) => {
      down = e.isPrimary ? { x: e.clientX, y: e.clientY, t: performance.now() } : null;
    });
    this.canvas.addEventListener('pointerup', (e) => {
      if (!down || !e.isPrimary || e.button > 0) return;
      const moved = Math.hypot(e.clientX - down.x, e.clientY - down.y);
      const quick = performance.now() - down.t < 700;
      down = null;
      if (moved < 8 && quick) this.onTap?.(e.clientX, e.clientY);
    });
    this.canvas.addEventListener('pointercancel', () => (down = null));
  }

  resize() {
    const w = this.canvas.clientWidth || window.innerWidth;
    const h = this.canvas.clientHeight || window.innerHeight;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  async load(url, onProgress) {
    const gltf = await new GLTFLoader().loadAsync(url, (e) => {
      if (e.lengthComputable && e.total) onProgress?.(e.loaded / e.total);
    });
    const root = gltf.scene;
    this.scene.add(root);
    this.model = root;
    root.updateMatrixWorld(true);

    this.groundMeshes = [];
    this.box = new THREE.Box3();
    this.buildingBox = new THREE.Box3();
    root.traverse((o) => {
      if (!o.isMesh) return;
      o.castShadow = true;
      o.receiveShadow = true;
      this.box.expandByObject(o);
      if (this.isGround(o)) this.groundMeshes.push(o);
      else this.buildingBox.expandByObject(o);
    });
    tuneMaterials(root, this.glassNames, this.skyEnvironment);
    this.fitSunToModel();
    this.limits = this.box.clone().expandByScalar(80);
    this.frameAll(false);
  }

  setGroundNames(names) {
    this.groundNames = new Set(names.map(looseName));
  }

  setGlassMaterials(names) {
    this.glassNames = new Set(names);
  }

  isGround(mesh) {
    for (let o = mesh; o && o !== this.model; o = o.parent) {
      if (this.groundNames?.has(looseName(o.name)) || this.groundNames?.has(looseName(o.userData?.name))) return true;
    }
    return false;
  }

  fitSunToModel() {
    const c = this.box.getCenter(new THREE.Vector3());
    const r = this.box.getSize(new THREE.Vector3()).length() / 2;
    // Afternoon sun from the south-west (three.js: north = -z, east = +x).
    this.sun.position.copy(c).add(new THREE.Vector3(-0.45, 0.8, 0.4).normalize().multiplyScalar(r * 1.6));
    this.sun.target.position.copy(c);
    const cam = this.sun.shadow.camera;
    cam.left = cam.bottom = -r;
    cam.right = cam.top = r;
    cam.near = 1;
    cam.far = r * 3.5;
    cam.updateProjectionMatrix();
  }

  /** Height of the ground (not roofs) at a world x/z position. */
  groundHeightAt(x, z, fallback) {
    if (!this.groundMeshes?.length) return fallback;
    this.raycaster.set(new THREE.Vector3(x, this.box.max.y + 50, z), new THREE.Vector3(0, -1, 0));
    const hit = this.raycaster.intersectObjects(this.groundMeshes, false)[0];
    return hit ? hit.point.y : fallback;
  }

  /** World point under a screen position (client coordinates), or null. */
  pick(clientX, clientY) {
    const rect = this.canvas.getBoundingClientRect();
    const ndc = new THREE.Vector2(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1);
    this.raycaster.setFromCamera(ndc, this.camera);
    const hit = this.raycaster.intersectObject(this.model, true)[0];
    return hit ? hit.point.clone() : null;
  }

  /** Overview of the whole campus, seen from the south-east. */
  frameAll(animate = true) {
    const center = this.buildingBox.getCenter(new THREE.Vector3());
    center.y = this.buildingBox.min.y;
    const size = this.buildingBox.getSize(new THREE.Vector3());
    const dist = Math.max(size.x, size.z) * 1.35 + 60;
    const offset = new THREE.Vector3().setFromSphericalCoords(dist, THREE.MathUtils.degToRad(52), THREE.MathUtils.degToRad(28));
    this.flyTo(center, center.clone().add(offset), animate ? 900 : 0);
  }

  /** Look straight down with true north at the top of the screen. */
  topView(north, animate = true) {
    const target = this.controls.target.clone();
    const dist = Math.min(Math.max(this.camera.position.distanceTo(target), 160), 700);
    const south = new THREE.Vector3(-north.x, 0, -north.z).multiplyScalar(dist * 0.002);
    this.flyTo(target, target.clone().add(new THREE.Vector3(0, dist, 0)).add(south), animate ? 700 : 0);
  }

  /** Rotate around the current target so that north points up the screen, keeping the tilt. */
  faceNorth(north) {
    const target = this.controls.target.clone();
    const offset = this.camera.position.clone().sub(target);
    const horizontal = Math.hypot(offset.x, offset.z);
    const pos = target.clone().add(new THREE.Vector3(-north.x * horizontal, offset.y, -north.z * horizontal));
    this.flyTo(target, pos, 600);
  }

  /** Leave the top view: tilt back to a 3D angle, still facing north. */
  tiltView(north) {
    const target = this.controls.target.clone();
    const dist = this.camera.position.distanceTo(target);
    const tilt = THREE.MathUtils.degToRad(55);
    const pos = target
      .clone()
      .add(new THREE.Vector3(-north.x, 0, -north.z).multiplyScalar(dist * Math.sin(tilt)))
      .add(new THREE.Vector3(0, dist * Math.cos(tilt), 0));
    this.flyTo(target, pos, 700);
  }

  /** True when the camera looks (almost) straight down. */
  isTopView() {
    const offset = this.camera.position.clone().sub(this.controls.target);
    return offset.angleTo(new THREE.Vector3(0, 1, 0)) < THREE.MathUtils.degToRad(8);
  }

  /** Move the camera so that it looks at point, keeping the current viewing angle. */
  centerOn(point, { distance, duration = 800, screenY = 0.5 } = {}) {
    const offset = this.camera.position.clone().sub(this.controls.target);
    if (distance) offset.setLength(distance);
    const target = point.clone();
    if (screenY !== 0.5) {
      // Shift the target toward the camera so the point shows above (or below) the screen centre.
      const forward = new THREE.Vector3(-offset.x, 0, -offset.z);
      const visible = 2 * offset.length() * Math.tan(THREE.MathUtils.degToRad(this.camera.fov / 2));
      if (forward.lengthSq() < 1e-6) forward.set(0, 0, -1);
      target.addScaledVector(forward.normalize(), -(0.5 - screenY) * visible);
    }
    this.flyTo(target, target.clone().add(offset), duration);
  }

  /** Look straight down at point from distance, with true north at the top of the screen. */
  overhead(point, north, distance, duration = 800) {
    const target = point.clone();
    const south = new THREE.Vector3(-north.x, 0, -north.z).multiplyScalar(distance * 0.002);
    this.flyTo(target, target.clone().add(new THREE.Vector3(0, distance, 0)).add(south), duration);
  }

  /** Shift the view so it follows a moving point without changing angle or zoom. */
  follow(point) {
    if (this.tween) return;
    const delta = point.clone().sub(this.controls.target);
    if (delta.lengthSq() < 0.01) return;
    delta.multiplyScalar(0.12);
    this.controls.target.add(delta);
    this.camera.position.add(delta);
  }

  flyTo(target, position, duration) {
    if (!duration) {
      this.controls.target.copy(target);
      this.camera.position.copy(position);
      this.tween = null;
      this.controls.update();
      return;
    }
    this.tween = {
      start: performance.now(),
      duration,
      fromTarget: this.controls.target.clone(),
      fromPos: this.camera.position.clone(),
      toTarget: target,
      toPos: position,
    };
  }

  /** Screen angle (radians, clockwise from up) at which true north currently points. */
  northScreenAngle(north) {
    const t = this.controls.target;
    const a = t.clone().project(this.camera);
    const b = t.clone().add(new THREE.Vector3(north.x, 0, north.z).multiplyScalar(10)).project(this.camera);
    const dx = (b.x - a.x) * this.camera.aspect;
    const dy = b.y - a.y;
    return Math.atan2(dx, dy);
  }

  onFrame(fn) {
    this.frameCallbacks.add(fn);
    return () => this.frameCallbacks.delete(fn);
  }

  tick(time) {
    if (this.tween) {
      const tw = this.tween;
      const k = Math.min((performance.now() - tw.start) / tw.duration, 1);
      const e = easeInOut(k);
      this.controls.target.lerpVectors(tw.fromTarget, tw.toTarget, e);
      this.camera.position.lerpVectors(tw.fromPos, tw.toPos, e);
      if (k >= 1) this.tween = null;
    }
    if (this.limits) {
      // Keep the map from being dragged out of sight.
      const t = this.controls.target;
      const clamped = t.clone().clamp(this.limits.min, this.limits.max);
      if (!clamped.equals(t)) {
        this.camera.position.add(clamped.clone().sub(t));
        t.copy(clamped);
      }
    }
    this.controls.update();
    for (const fn of this.frameCallbacks) fn(time);
    this.renderer.render(this.scene, this.camera);
  }
}

// The model's materials come from Fusion 360 and lost their image textures, so give the
// surfaces plain, readable colours and avoid see-through artefacts.
function tuneMaterials(root, glassNames = new Set(), skyEnvironment = null) {
  const glass = makeGlassMaterial(skyEnvironment);
  const seen = new Set();
  root.traverse((o) => {
    if (!o.isMesh) return;
    if (Array.isArray(o.material)) {
      o.material = o.material.map((m) => (m && glassNames.has(m.name) ? glass : m));
    } else if (o.material && glassNames.has(o.material.name)) {
      o.material = glass;
    }
    for (const m of Array.isArray(o.material) ? o.material : [o.material]) {
      if (!m || m === glass || seen.has(m)) continue;
      seen.add(m);
      m.side = THREE.DoubleSide;
      if (m.transparent && m.opacity > 0.6) {
        m.transparent = false;
        m.opacity = 1;
      }
    }
  });
}

/**
 * Opaque architectural glass: a dark blue-green tint seen face on, with the sky showing up more
 * the more obliquely a window is viewed (Fresnel reflection with a real glass IOR of 1.5).
 * It stays opaque on purpose: the buildings have no modelled interiors to look into.
 */
function makeGlassMaterial(envMap) {
  return new THREE.MeshPhysicalMaterial({
    name: 'web-window-glass',
    color: 0x35505e,
    metalness: 0,
    roughness: 0.08,
    ior: 1.5,
    specularIntensity: 1,
    envMap,
    envMapIntensity: 1.25,
    side: THREE.DoubleSide,
  });
}

/** Gradient sky (zenith blue, pale horizon, darker ground) used only for glass reflections. */
function buildSkyScene() {
  const geometry = new THREE.SphereGeometry(100, 48, 24);
  const zenith = new THREE.Color(0x5d93c9);
  const horizon = new THREE.Color(0xe4eef5);
  const ground = new THREE.Color(0x6f776a);
  const colors = [];
  const pos = geometry.attributes.position;
  const c = new THREE.Color();
  for (let i = 0; i < pos.count; i++) {
    const y = pos.getY(i) / 100;
    if (y >= 0) c.copy(horizon).lerp(zenith, Math.pow(y, 0.6));
    else c.copy(horizon).lerp(ground, Math.min(1, -y * 4));
    colors.push(c.r, c.g, c.b);
  }
  geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  const scene = new THREE.Scene();
  scene.add(new THREE.Mesh(geometry, new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.BackSide })));
  return scene;
}
