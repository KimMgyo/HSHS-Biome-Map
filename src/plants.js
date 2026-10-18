import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { assetUrl } from './api.js';

export const PLANT_KINDS = [
  { id: 'tree_large', label: '큰 나무', hint: '키 약 11 m', color: '#2e7d32' },
  { id: 'tree_medium', label: '중간 나무', hint: '키 약 5 m', color: '#00796b' },
  { id: 'grass_small', label: '작은 풀', hint: '키 약 1.6 m', color: '#7cb342' },
].map((k) => ({ ...k, model: assetUrl('models/plants/' + k.id + '.glb'), thumb: assetUrl('models/plants/thumbs/' + k.id + '.png') }));

export const kindInfo = (id) => PLANT_KINDS.find((k) => k.id === id) || PLANT_KINDS[0];

const PIN_SCALE = 0.04;
const PIN_SCALE_SELECTED = 0.056;

/** Draws every saved plant on the map as its 3D model plus a tappable pin. */
export class PlantLayer {
  constructor(viewer, georef) {
    this.viewer = viewer;
    this.georef = georef;
    this.items = new Map(); // id -> { plant, model, pin }
    this.templates = new Map(); // kind -> { root, height }
    this.group = new THREE.Group();
    this.group.name = 'plants';
    this.pins = new THREE.Group();
    this.pins.name = 'plant-pins';
    viewer.scene.add(this.group, this.pins);
    this.selectedId = null;
    this.raycaster = new THREE.Raycaster();
    this.ready = this.loadTemplates();
  }

  async loadTemplates() {
    const loader = new GLTFLoader();
    await Promise.all(
      PLANT_KINDS.map(async (kind) => {
        const gltf = await loader.loadAsync(kind.model);
        const root = gltf.scene;
        root.traverse((o) => {
          if (o.isMesh) {
            o.castShadow = true;
            o.receiveShadow = true;
            o.material.side = THREE.DoubleSide;
          }
        });
        // Stand the model on its lowest point so edits in Blender never leave it floating or buried.
        const box = new THREE.Box3().setFromObject(root);
        const wrapper = new THREE.Group();
        root.position.y -= box.min.y;
        wrapper.add(root);
        this.templates.set(kind.id, { root: wrapper, height: box.max.y - box.min.y });
      }),
    );
  }

  /** A fresh copy of a plant model in metres (shares geometry and materials with the template). */
  createModel(kind) {
    const t = this.templates.get(kind);
    return t ? t.root.clone(true) : new THREE.Group();
  }

  heightUnits(kind) {
    return (this.templates.get(kind)?.height ?? 1) / this.georef.metersPerUnit;
  }

  setPlants(list) {
    const keep = new Set(list.map((p) => p.id));
    for (const id of [...this.items.keys()]) if (!keep.has(id)) this.remove(id);
    for (const p of list) if (!this.items.has(p.id)) this.add(p);
  }

  add(plant) {
    if (this.items.has(plant.id)) this.remove(plant.id);
    const model = this.createModel(plant.kind);
    model.userData.plantId = plant.id;
    model.traverse((o) => (o.userData.plantId = plant.id));
    const pin = new THREE.Sprite(
      new THREE.SpriteMaterial({ map: pinTexture(kindInfo(plant.kind).color), sizeAttenuation: false, depthTest: false, depthWrite: false }),
    );
    pin.center.set(0.5, 0.04);
    pin.scale.setScalar(PIN_SCALE);
    pin.renderOrder = 14;
    pin.userData.plantId = plant.id;
    const item = { plant, model, pin };
    this.items.set(plant.id, item);
    this.group.add(model);
    this.pins.add(pin);
    this.place(item);
    return item;
  }

  remove(id) {
    const item = this.items.get(id);
    if (!item) return;
    this.group.remove(item.model);
    this.pins.remove(item.pin);
    item.pin.material.dispose();
    this.items.delete(id);
    if (this.selectedId === id) this.selectedId = null;
  }

  place(item) {
    const { x, z } = this.georef.toWorld(item.plant.lat, item.plant.lon);
    const y = this.viewer.groundHeightAt(x, z, this.georef.groundHeight);
    placeModel(item.model, x, y, z, 1 / this.georef.metersPerUnit, item.plant.id);
    item.pin.position.set(x, y + this.heightUnits(item.plant.kind) + 0.6, z);
    item.world = new THREE.Vector3(x, y, z);
  }

  /** Re-project every plant, e.g. after the GPS calibration changed. */
  relayout() {
    for (const item of this.items.values()) this.place(item);
  }

  select(id) {
    this.selectedId = id;
    for (const [key, item] of this.items) item.pin.scale.setScalar(key === id ? PIN_SCALE_SELECTED : PIN_SCALE);
  }

  /** Plant under a screen point (pins first, then the 3D models), or null. */
  pickAt(clientX, clientY) {
    if (!this.items.size) return null;
    const rect = this.viewer.canvas.getBoundingClientRect();
    const ndc = new THREE.Vector2(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1);
    this.raycaster.setFromCamera(ndc, this.viewer.camera);
    const hit = this.raycaster.intersectObjects(this.pins.children, false)[0] || this.raycaster.intersectObject(this.group, true)[0];
    const id = hit?.object.userData.plantId;
    return id ? this.items.get(id).plant : null;
  }
}

/** Put a metre-sized model on the ground at a world position; the yaw is stable per plant. */
export function placeModel(model, x, y, z, scale, seed = '') {
  model.position.set(x, y, z);
  model.scale.setScalar(scale);
  let h = 2166136261;
  for (const ch of seed) h = Math.imul(h ^ ch.charCodeAt(0), 16777619);
  model.rotation.y = ((h >>> 0) / 4294967296) * Math.PI * 2;
}

const pinCache = new Map();
export function pinTexture(color) {
  if (pinCache.has(color)) return pinCache.get(color);
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d');
  // Teardrop pin whose tip is at the bottom centre.
  const pin = () => {
    g.beginPath();
    g.moveTo(64, 124);
    g.bezierCurveTo(52, 100, 22, 84, 22, 52);
    g.arc(64, 52, 42, Math.PI, 0);
    g.bezierCurveTo(106, 84, 76, 100, 64, 124);
    g.closePath();
  };
  g.save();
  g.translate(0, 3);
  g.fillStyle = 'rgba(0,0,0,0.22)';
  pin();
  g.fill();
  g.restore();
  g.fillStyle = color;
  pin();
  g.fill();
  g.lineWidth = 6;
  g.strokeStyle = '#ffffff';
  g.stroke();
  // Leaf glyph.
  g.fillStyle = '#ffffff';
  g.beginPath();
  g.moveTo(44, 72);
  g.bezierCurveTo(42, 46, 60, 30, 86, 30);
  g.bezierCurveTo(86, 56, 70, 72, 44, 72);
  g.fill();
  g.strokeStyle = color;
  g.lineWidth = 4;
  g.beginPath();
  g.moveTo(48, 68);
  g.lineTo(76, 42);
  g.stroke();
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  pinCache.set(color, tex);
  return tex;
}
