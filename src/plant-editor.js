import * as THREE from 'three';
import { api } from './api.js';
import { PLANT_KINDS, pinTexture, placeModel } from './plants.js';

const PHOTO_MAX_SIDE = 1600;
const PHOTO_QUALITY = 0.85;
const FIX_MAX_AGE_MS = 30000;
const WAIT_FOR_FIX_MS = 20000;

/**
 * Admin flow for adding a plant:
 * 1. find the admin's GPS position, 2. pick a spot on the map within radiusM of it,
 * 3. fill in photo, name, description and model, 4. save to the server.
 * Without a usable GPS fix the admin can choose to pick anywhere on the map instead.
 */
export class PlantEditor {
  constructor({ viewer, georef, gps, layer, admin, toast, bar, form, radiusM, onSaved, onModeChange }) {
    Object.assign(this, { viewer, georef, gps, layer, admin, toast, bar, radiusM, onSaved, onModeChange });
    this.sheet = form;
    this.form = form.querySelector('form');
    this.state = 'idle'; // idle | locating | picking | form | saving
    this.anchor = null; // world position of the admin when the spot is limited by GPS
    this.point = null; // chosen world position
    this.photoData = null;
    this.preview = null;

    this.overlay = new THREE.Group();
    this.overlay.name = 'plant-editor';
    viewer.scene.add(this.overlay);
    this.ring = buildRadiusRing();
    this.pin = new THREE.Sprite(
      new THREE.SpriteMaterial({ map: pinTexture('#d93025'), sizeAttenuation: false, depthTest: false, depthWrite: false }),
    );
    this.pin.center.set(0.5, 0.04);
    this.pin.scale.setScalar(0.052);
    this.pin.renderOrder = 15;
    this.overlay.add(this.ring, this.pin);
    this.overlay.visible = false;

    this.buildKindChoices();
    this.bindUi();
  }

  get active() {
    return this.state !== 'idle';
  }

  // ---------------------------------------------------------------- flow

  async start() {
    if (this.active) return;
    if (!this.admin.isAdmin) {
      const ok = await this.admin.openLogin({ message: '식물을 추가하려면 관리자 비밀번호를 입력하세요.' });
      if (!ok) return;
    }
    this.resetForm();
    this.setState('locating');
    const fix = await this.waitForFix();
    if (this.state !== 'locating') return; // cancelled, or switched to picking without GPS
    this.useFix(fix);
  }

  waitForFix() {
    const f = this.gps.fix;
    if (f && Date.now() - f.time < FIX_MAX_AGE_MS) return Promise.resolve(f);
    this.showBar('내 위치를 찾는 중입니다… 위치 권한을 허용해 주세요.', { free: true, next: false });
    if (!this.gps.tracking) this.gps.start();
    return new Promise((resolve) => {
      const done = (value) => {
        clearTimeout(timer);
        this.gps.removeEventListener('position', onPos);
        this.gps.removeEventListener('status', onStatus);
        this.stopWaiting = null;
        resolve(value);
      };
      const onPos = (e) => done(e.detail);
      const onStatus = (e) => {
        if (e.detail.state === 'error' && e.detail.code !== 'timeout') done(null);
      };
      const timer = setTimeout(() => done(null), WAIT_FOR_FIX_MS);
      this.gps.addEventListener('position', onPos);
      this.gps.addEventListener('status', onStatus);
      this.stopWaiting = () => done(null);
    });
  }

  useFix(fix) {
    if (!fix) {
      this.showBar('위치를 찾지 못했습니다. 실외에서 다시 시도하거나, 지도에서 직접 고르세요.', { free: true, next: false });
      return;
    }
    if (!this.gps.group.visible || !this.gps.isOnMap()) {
      this.showBar('지금 위치가 학교 지도 밖입니다. 학교 안에서 다시 시도하거나, 지도에서 직접 고르세요.', { free: true, next: false });
      return;
    }
    this.anchor = this.gps.worldPos.clone();
    this.enterPicking();
  }

  enterPicking({ free = false } = {}) {
    this.stopWaiting?.();
    if (free) this.anchor = null;
    this.setState('picking');
    this.overlay.visible = true;
    const north = this.georef.axes().north;
    if (this.anchor) {
      const r = this.radiusUnits();
      this.ring.position.set(this.anchor.x, this.anchor.y + 0.25, this.anchor.z);
      this.ring.scale.setScalar(r);
      this.ring.visible = true;
      if (!this.point) this.setPoint(this.anchor.clone(), { quiet: true });
      this.viewer.overhead(this.anchor, north, Math.max(160, r * 4.4));
    } else {
      this.ring.visible = false;
      this.viewer.overhead(this.viewer.controls.target.clone(), north, 320);
    }
    this.updatePickBar();
  }

  handleTap(clientX, clientY) {
    if (this.state === 'idle') return false;
    if (this.state !== 'picking') return true; // ignore map taps while the form is open
    const hit = this.viewer.pick(clientX, clientY);
    if (!hit) {
      this.toast('학교 지도 위를 눌러 주세요.');
      return true;
    }
    if (this.anchor) {
      const r = this.radiusUnits();
      const d = Math.hypot(hit.x - this.anchor.x, hit.z - this.anchor.z);
      if (d > r) {
        hit.x = this.anchor.x + ((hit.x - this.anchor.x) / d) * r;
        hit.z = this.anchor.z + ((hit.z - this.anchor.z) / d) * r;
        this.toast('내 위치에서 ' + this.radiusM + ' m 안쪽으로 맞췄습니다.');
      }
    }
    hit.y = this.viewer.groundHeightAt(hit.x, hit.z, this.georef.groundHeight);
    this.setPoint(hit);
    return true;
  }

  setPoint(point, { quiet = false } = {}) {
    this.point = point;
    this.updatePreview();
    if (!quiet) this.updatePickBar();
  }

  openForm() {
    if (!this.point) return;
    this.setState('form');
    this.bar.hidden = true;
    this.sheet.hidden = false;
    this.sheet.scrollTop = 0;
    // On phones the sheet covers the lower half, so keep the chosen spot in the upper part.
    const narrow = window.matchMedia('(max-width: 640px)').matches;
    this.viewer.centerOn(this.point, { duration: 600, screenY: narrow ? 0.22 : 0.5 });
  }

  backToPicking() {
    this.sheet.hidden = true;
    this.enterPicking({ free: !this.anchor });
  }

  async cancel() {
    if (this.state === 'saving') return;
    const touched = this.photoData || this.form.elements.name.value.trim() || this.form.elements.description.value.trim();
    if (touched && !confirm('입력한 내용을 버리고 식물 추가를 그만둘까요?')) return;
    this.finish();
  }

  finish() {
    this.stopWaiting?.();
    this.setState('idle');
    this.bar.hidden = true;
    this.sheet.hidden = true;
    this.overlay.visible = false;
    this.clearPreview();
    this.point = null;
    this.anchor = null;
  }

  async save() {
    if (this.state !== 'form') return;
    const el = this.form.elements;
    const name = el.name.value.trim();
    const kind = el.kind.value;
    const problems = [];
    if (!this.photoData) problems.push('사진');
    if (!name) problems.push('이름');
    if (!kind) problems.push('모델');
    if (problems.length) {
      this.setError(problems.join(', ') + '을(를) 채워 주세요.');
      return;
    }
    const { lat, lon } = this.georef.toLatLon(this.point.x, this.point.z);
    const payload = { name, description: el.description.value, kind, lat, lon, photo: this.photoData };
    this.setState('saving');
    this.setError('');
    try {
      const plant = await api.createPlant(payload);
      this.finish();
      this.layer.add(plant);
      this.onSaved?.(plant);
    } catch (err) {
      this.setState('form');
      if (err.status === 401) {
        this.admin.expired();
        const ok = await this.admin.openLogin({ message: '로그인이 만료되었습니다. 다시 로그인하면 이어서 저장합니다.' });
        if (ok) return this.save();
      }
      this.setError(err.message);
    }
  }

  // ---------------------------------------------------------------- helpers

  radiusUnits() {
    return this.radiusM / this.georef.metersPerUnit;
  }

  setState(state) {
    this.state = state;
    document.body.classList.toggle('placing', state === 'locating' || state === 'picking');
    document.body.classList.toggle('editing', state === 'form' || state === 'saving');
    const submit = this.form.querySelector('button[type="submit"]');
    submit.disabled = state === 'saving';
    submit.textContent = state === 'saving' ? '저장 중…' : '저장';
    this.onModeChange?.(state !== 'idle');
  }

  showBar(message, { free, next }) {
    this.bar.hidden = false;
    this.bar.querySelector('.msg').textContent = message;
    this.bar.querySelector('[data-act="free"]').hidden = !free;
    const nextBtn = this.bar.querySelector('[data-act="next"]');
    nextBtn.hidden = next === false;
    nextBtn.disabled = !next;
  }

  updatePickBar() {
    let msg;
    if (this.anchor) {
      msg = '식물을 심을 곳을 지도에서 누르세요. 파란 점(내 위치) 반경 ' + this.radiusM + ' m 안에서 고를 수 있습니다.';
      if (this.point) {
        const d = Math.hypot(this.point.x - this.anchor.x, this.point.z - this.anchor.z) * this.georef.metersPerUnit;
        msg += d < 1 ? ' 지금은 내가 선 자리로 되어 있습니다.' : ' 고른 곳: 내 위치에서 약 ' + Math.round(d) + ' m.';
      }
    } else {
      msg = this.point ? '이 자리에 심습니다. 다른 곳을 누르면 옮겨집니다.' : 'GPS 없이 고르는 중입니다. 식물을 심을 곳을 지도에서 누르세요.';
    }
    this.showBar(msg, { free: false, next: Boolean(this.point) });
  }

  updatePreview() {
    this.clearPreview();
    if (!this.point) return;
    const kind = this.form.elements.kind.value;
    let top = 0;
    if (kind) {
      this.preview = this.layer.createModel(kind);
      placeModel(this.preview, this.point.x, this.point.y, this.point.z, 1 / this.georef.metersPerUnit, 'preview');
      this.overlay.add(this.preview);
      top = this.layer.heightUnits(kind);
    }
    this.pin.position.set(this.point.x, this.point.y + top + 0.6, this.point.z);
    this.pin.visible = true;
  }

  clearPreview() {
    if (this.preview) this.overlay.remove(this.preview);
    this.preview = null;
    this.pin.visible = false;
  }

  setError(message) {
    this.form.querySelector('.form-error').textContent = message;
  }

  resetForm() {
    this.form.reset();
    this.photoData = null;
    const pick = this.form.querySelector('.photo-pick');
    pick.classList.remove('has-photo', 'busy');
    pick.querySelector('img').removeAttribute('src');
    this.setError('');
  }

  buildKindChoices() {
    const box = this.form.querySelector('.kinds .choices');
    box.replaceChildren(
      ...PLANT_KINDS.map((k) => {
        const label = document.createElement('label');
        label.className = 'kind-choice';
        const input = Object.assign(document.createElement('input'), { type: 'radio', name: 'kind', value: k.id, required: true });
        const img = Object.assign(document.createElement('img'), { src: k.thumb, alt: '', loading: 'lazy' });
        const title = Object.assign(document.createElement('strong'), { textContent: k.label });
        const hint = Object.assign(document.createElement('small'), { textContent: k.hint });
        label.append(input, img, title, hint);
        return label;
      }),
    );
  }

  bindUi() {
    this.bar.addEventListener('click', (e) => {
      const act = e.target.closest('button')?.dataset.act;
      if (act === 'cancel') this.cancel();
      else if (act === 'free') this.enterPicking({ free: true });
      else if (act === 'next') this.openForm();
    });
    this.form.addEventListener('submit', (e) => {
      e.preventDefault();
      this.save();
    });
    this.form.addEventListener('click', (e) => {
      const act = e.target.closest('button')?.dataset.act;
      if (act === 'cancel') this.cancel();
      else if (act === 'repick') this.backToPicking();
    });
    this.form.addEventListener('change', (e) => {
      if (e.target.name === 'kind') this.updatePreview();
      if (e.target.name === 'photo') this.loadPhoto(e.target.files[0]);
    });
    this.sheet.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') this.cancel();
    });
  }

  async loadPhoto(file) {
    if (!file) return;
    const pick = this.form.querySelector('.photo-pick');
    pick.classList.add('busy');
    this.setError('');
    try {
      this.photoData = await preparePhoto(file);
      pick.querySelector('img').src = this.photoData;
      pick.classList.add('has-photo');
    } catch (err) {
      this.setError(err.message);
    } finally {
      pick.classList.remove('busy');
    }
  }
}

/**
 * Shrink a camera photo to at most 1600 px and re-encode it as JPEG. This keeps uploads small
 * and drops EXIF data such as the GPS position where the photo was taken.
 */
export async function preparePhoto(file) {
  if (!file.type.startsWith('image/')) throw new Error('사진 파일만 올릴 수 있습니다.');
  let source;
  let url;
  try {
    source = await createImageBitmap(file, { imageOrientation: 'from-image' });
  } catch {
    url = URL.createObjectURL(file);
    source = await new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error('사진을 열 수 없습니다. JPG나 PNG 사진을 골라 주세요.'));
      img.src = url;
    });
  }
  try {
    const w = source.naturalWidth || source.width;
    const h = source.naturalHeight || source.height;
    const s = Math.min(1, PHOTO_MAX_SIDE / Math.max(w, h));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(w * s));
    canvas.height = Math.max(1, Math.round(h * s));
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(source, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL('image/jpeg', PHOTO_QUALITY);
  } finally {
    source.close?.();
    if (url) URL.revokeObjectURL(url);
  }
}

function buildRadiusRing() {
  const group = new THREE.Group();
  const mat = (opacity) =>
    new THREE.MeshBasicMaterial({ color: 0x16a34a, transparent: true, opacity, depthTest: false, depthWrite: false });
  const disc = new THREE.Mesh(new THREE.CircleGeometry(1, 72).rotateX(-Math.PI / 2), mat(0.12));
  const edge = new THREE.Mesh(new THREE.RingGeometry(0.975, 1, 120).rotateX(-Math.PI / 2), mat(0.75));
  disc.renderOrder = edge.renderOrder = 9;
  group.add(disc, edge);
  return group;
}
