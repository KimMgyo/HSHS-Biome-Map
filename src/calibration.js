import * as THREE from 'three';
import { solveGeoref } from './geo.js';
import { STORAGE_KEYS } from './config.js';

/**
 * On-site calibration (open the site with ?calibrate).
 * Stand on a recognisable spot, tap the same spot on the model, record GPS, repeat.
 * One point shifts the model; two or more points far apart also fix scale and rotation.
 */
export class CalibrationPanel {
  constructor({ root, viewer, georef, location, defaultConfig, toast, onChange }) {
    this.root = root;
    this.viewer = viewer;
    this.georef = georef;
    this.location = location;
    this.defaultConfig = defaultConfig;
    this.toast = toast;
    this.onChange = onChange;
    this.points = loadJSON(STORAGE_KEYS.calibrationPoints) || [];
    this.draft = { world: null, lat: null, lon: null, accuracy: null };
    this.pickMode = false;
    this.markers = new THREE.Group();
    viewer.scene.add(this.markers);
    this.render();
    this.bindPicking();
    location.addEventListener('position', (e) => this.showLive(e.detail));
    root.hidden = false;
  }

  bindPicking() {
    const canvas = this.viewer.canvas;
    let down = null;
    canvas.addEventListener('pointerdown', (e) => (down = { x: e.clientX, y: e.clientY }));
    canvas.addEventListener('pointerup', (e) => {
      if (!this.pickMode || !down || Math.hypot(e.clientX - down.x, e.clientY - down.y) > 6) return;
      const p = this.viewer.pick(e.clientX, e.clientY);
      if (!p) return;
      this.draft.world = { x: round(p.x, 2), z: round(p.z, 2), y: round(p.y, 2) };
      this.pickMode = false;
      this.render();
    });
  }

  async recordGps() {
    if (!this.location.tracking) this.location.start();
    const btn = this.root.querySelector('[data-act="gps"]');
    btn.disabled = true;
    btn.textContent = 'GPS 수집 중… (8초)';
    const fixes = [];
    const onPos = (e) => fixes.push(e.detail);
    this.location.addEventListener('position', onPos);
    await new Promise((r) => setTimeout(r, 8000));
    this.location.removeEventListener('position', onPos);
    btn.disabled = false;
    if (!fixes.length) {
      this.toast('GPS 값을 받지 못했습니다. 위치 권한과 신호를 확인하세요.');
      this.render();
      return;
    }
    // Average the fixes, trusting the more accurate ones more.
    let w = 0, lat = 0, lon = 0;
    for (const f of fixes) {
      const k = 1 / Math.max(f.accuracy, 1) ** 2;
      w += k;
      lat += f.lat * k;
      lon += f.lon * k;
    }
    const best = Math.min(...fixes.map((f) => f.accuracy));
    Object.assign(this.draft, { lat: lat / w, lon: lon / w, accuracy: best });
    this.render();
  }

  addPoint() {
    const typed = this.root.querySelector('#calib-latlon').value.trim();
    if (typed) {
      const m = typed.match(/(-?\d+(?:\.\d+)?)\s*[, ]\s*(-?\d+(?:\.\d+)?)/);
      if (!m) return this.toast('위도, 경도를 "37.50390, 126.96446" 형식으로 입력하세요.');
      Object.assign(this.draft, { lat: Number(m[1]), lon: Number(m[2]), accuracy: null });
    }
    if (!this.draft.world) return this.toast('먼저 지도에서 지점을 찍으세요.');
    if (this.draft.lat === null) return this.toast('GPS를 기록하거나 위도, 경도를 입력하세요.');
    this.points.push({ ...this.draft });
    this.draft = { world: null, lat: null, lon: null, accuracy: null };
    this.root.querySelector('#calib-latlon').value = '';
    this.save();
    this.render();
  }

  apply() {
    try {
      const { config, residuals } = solveGeoref(this.points, this.georef);
      this.georef.set(config);
      localStorage.setItem(STORAGE_KEYS.georef, JSON.stringify(this.georef.toJSON()));
      this.points.forEach((p, i) => (p.residual = residuals[i]));
      this.save();
      this.location.place();
      this.onChange?.();
      this.render();
      this.toast('보정을 적용했습니다. 이 기기에만 저장되어 있으니 georef.json을 받아 사이트에 반영하세요.');
    } catch (err) {
      this.toast(err.message);
    }
  }

  download() {
    const data = { ...this.georef.toJSON(), note: '현장 보정 ' + new Date().toISOString().slice(0, 10) + ', 지점 ' + this.points.length + '개' };
    const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2) + '\n'], { type: 'application/json' }));
    const a = Object.assign(document.createElement('a'), { href: url, download: 'georef.json' });
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  reset() {
    localStorage.removeItem(STORAGE_KEYS.georef);
    this.georef.set(this.defaultConfig);
    this.points.forEach((p) => delete p.residual);
    this.save();
    this.location.place();
    this.onChange?.();
    this.render();
    this.toast('사이트 기본 위치값으로 되돌렸습니다.');
  }

  remove(i) {
    this.points.splice(i, 1);
    this.save();
    this.render();
  }

  save() {
    localStorage.setItem(STORAGE_KEYS.calibrationPoints, JSON.stringify(this.points));
  }

  showLive(fix) {
    const el = this.root.querySelector('#calib-live');
    if (el) el.textContent = '현재 GPS ' + fix.lat.toFixed(6) + ', ' + fix.lon.toFixed(6) + ' (±' + Math.round(fix.accuracy) + ' m)';
  }

  render() {
    const g = this.georef;
    const d = this.draft;
    const list = this.points
      .map(
        (p, i) =>
          '<li><span class="calib-num">' + (i + 1) + '</span><span>' + p.lat.toFixed(6) + ', ' + p.lon.toFixed(6) +
          (p.residual !== undefined ? ' · 오차 ' + p.residual.toFixed(1) + ' m' : '') +
          '</span><button class="link" data-remove="' + i + '">삭제</button></li>',
      )
      .join('');
    this.root.innerHTML =
      '<header><h2>위치 보정</h2><button class="link" data-act="close">닫기</button></header>' +
      '<p class="hint">정문, 건물 모서리처럼 지도와 현장에서 모두 알아보기 쉬운 곳에 서서 ① 지도에서 그 지점을 찍고 ② GPS를 기록한 뒤 지점을 추가하세요. 서로 멀리 떨어진 지점 2곳 이상이면 축척과 방향까지 맞춰집니다.</p>' +
      '<div class="calib-step"><button data-act="pick" class="' + (this.pickMode ? 'active' : '') + '">' +
      (this.pickMode ? '지도에서 지점을 탭하세요' : '① 지도에서 지점 찍기') + '</button><span>' +
      (d.world ? '선택됨' : '미선택') + '</span></div>' +
      '<div class="calib-step"><button data-act="gps">② 현재 GPS 기록</button><span>' +
      (d.lat !== null ? d.lat.toFixed(6) + ', ' + d.lon.toFixed(6) + (d.accuracy ? ' (±' + Math.round(d.accuracy) + ' m)' : '') : '미기록') +
      '</span></div>' +
      '<input id="calib-latlon" inputmode="decimal" placeholder="또는 위도, 경도 직접 입력 (37.50390, 126.96446)" />' +
      '<button data-act="add" class="primary">지점 추가</button>' +
      '<ol class="calib-list">' + list + '</ol>' +
      '<div class="calib-actions"><button data-act="apply" class="primary"' + (this.points.length ? '' : ' disabled') + '>보정 적용</button>' +
      '<button data-act="download">georef.json 받기</button><button data-act="reset">기본값</button></div>' +
      '<p class="calib-meta">축척 ' + g.metersPerUnit.toFixed(4) + ' m/단위 · 회전 ' + g.rotationDeg.toFixed(2) + '° · 원점 ' +
      g.originLat.toFixed(6) + ', ' + g.originLon.toFixed(6) + '</p><p class="calib-meta" id="calib-live"></p>';
    this.root.onclick = (e) => {
      const t = e.target.closest('button');
      if (!t) return;
      if (t.dataset.remove !== undefined) return this.remove(Number(t.dataset.remove));
      const act = t.dataset.act;
      if (act === 'pick') {
        this.pickMode = !this.pickMode;
        this.render();
      } else if (act === 'gps') this.recordGps();
      else if (act === 'add') this.addPoint();
      else if (act === 'apply') this.apply();
      else if (act === 'download') this.download();
      else if (act === 'reset') this.reset();
      else if (act === 'close') this.root.hidden = true;
    };
    this.drawMarkers();
  }

  drawMarkers() {
    this.markers.clear();
    const all = this.points.map((p, i) => ({ world: p.world, label: String(i + 1), color: '#e8710a' }));
    if (this.draft.world) all.push({ world: this.draft.world, label: '+', color: '#d93025' });
    for (const m of all) {
      const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: labelTexture(m.label, m.color), sizeAttenuation: false, depthTest: false }));
      s.scale.setScalar(0.045);
      s.position.set(m.world.x, (m.world.y ?? 0) + 1, m.world.z);
      s.renderOrder = 20;
      this.markers.add(s);
    }
  }
}

function labelTexture(text, color) {
  const c = document.createElement('canvas');
  c.width = c.height = 96;
  const g = c.getContext('2d');
  g.fillStyle = color;
  g.beginPath();
  g.arc(48, 48, 40, 0, Math.PI * 2);
  g.fill();
  g.lineWidth = 6;
  g.strokeStyle = '#fff';
  g.stroke();
  g.fillStyle = '#fff';
  g.font = 'bold 44px system-ui, sans-serif';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillText(text, 48, 50);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

function loadJSON(key) {
  try {
    return JSON.parse(localStorage.getItem(key));
  } catch {
    return null;
  }
}

const round = (v, d) => Math.round(v * 10 ** d) / 10 ** d;
