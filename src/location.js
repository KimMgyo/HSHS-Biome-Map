import * as THREE from 'three';
import { distanceMeters } from './geo.js';

const BLUE = 0x1a73e8;

/** Watches the device GPS (and compass, when available) and draws "you are here" on the map. */
export class LocationLayer extends EventTarget {
  constructor(viewer, georef, { maxDistance }) {
    super();
    this.viewer = viewer;
    this.georef = georef;
    this.maxDistance = maxDistance;
    this.watchId = null;
    this.fix = null; // latest { lat, lon, accuracy, heading, speed, time }
    this.deviceHeading = null;
    this.shownHeading = null;
    this.worldPos = new THREE.Vector3();
    this.group = buildMarker();
    this.group.visible = false;
    viewer.scene.add(this.group);
    viewer.onFrame((t) => this.animate(t));
  }

  get tracking() {
    return this.watchId !== null;
  }

  /** Start GPS. Must be called from a tap/click so that iOS can ask for compass access. */
  start() {
    if (this.tracking) return;
    this.requestCompass();
    if (!window.isSecureContext) {
      this.emitError('insecure');
      return;
    }
    if (!('geolocation' in navigator)) {
      this.emitError('unsupported');
      return;
    }
    this.dispatchEvent(new CustomEvent('status', { detail: { state: 'searching' } }));
    this.watchId = navigator.geolocation.watchPosition(
      (pos) => this.onPosition(pos),
      (err) => this.onError(err),
      { enableHighAccuracy: true, maximumAge: 1000, timeout: 30000 },
    );
  }

  stop() {
    if (this.watchId !== null) navigator.geolocation.clearWatch(this.watchId);
    this.watchId = null;
    this.fix = null;
    this.group.visible = false;
    this.dispatchEvent(new CustomEvent('status', { detail: { state: 'off' } }));
  }

  onPosition(pos) {
    const c = pos.coords;
    this.fix = {
      lat: c.latitude,
      lon: c.longitude,
      accuracy: c.accuracy,
      heading: Number.isFinite(c.heading) && c.speed > 0.6 ? c.heading : null,
      speed: c.speed,
      time: pos.timestamp,
    };
    this.place();
    this.dispatchEvent(new CustomEvent('position', { detail: this.fix }));
  }

  /** Re-project the latest fix, e.g. after the georeference was calibrated. */
  place() {
    const f = this.fix;
    if (!f) return;
    const center = this.schoolCenterLatLon();
    const away = distanceMeters(center, f);
    const { x, z } = this.georef.toWorld(f.lat, f.lon);
    const y = this.viewer.groundHeightAt(x, z, this.georef.groundHeight);
    const firstFix = !this.group.visible;
    this.worldPos.set(x, y, z);
    this.group.visible = away <= this.maxDistance;
    if (firstFix) this.group.position.copy(this.worldPos);
    const accuracyUnits = Math.max(f.accuracy, 1) / this.georef.metersPerUnit;
    this.group.userData.accuracy.scale.setScalar(accuracyUnits);
    this.dispatchEvent(
      new CustomEvent('status', {
        detail: { state: 'ok', accuracy: f.accuracy, away, onMap: this.isOnMap(), visible: this.group.visible },
      }),
    );
  }

  isOnMap() {
    const p = this.worldPos;
    const b = this.viewer.box;
    return p.x >= b.min.x && p.x <= b.max.x && p.z >= b.min.z && p.z <= b.max.z;
  }

  schoolCenterLatLon() {
    const c = this.viewer.buildingBox.getCenter(new THREE.Vector3());
    return this.georef.toLatLon(c.x, c.z);
  }

  onError(err) {
    const code = { 1: 'denied', 2: 'unavailable', 3: 'timeout' }[err.code] || 'unavailable';
    if (code === 'denied') this.stop();
    this.emitError(code);
  }

  emitError(code) {
    this.dispatchEvent(new CustomEvent('status', { detail: { state: 'error', code } }));
  }

  requestCompass() {
    if (this.compassRequested) return;
    this.compassRequested = true;
    const listen = () => {
      const handler = (ev) => {
        let h = null;
        if (typeof ev.webkitCompassHeading === 'number') h = ev.webkitCompassHeading;
        else if (ev.absolute && typeof ev.alpha === 'number') h = 360 - ev.alpha;
        if (h === null) return;
        const screenAngle = screen.orientation?.angle ?? window.orientation ?? 0;
        this.deviceHeading = (((h + screenAngle) % 360) + 360) % 360;
      };
      if ('ondeviceorientationabsolute' in window) window.addEventListener('deviceorientationabsolute', handler);
      else window.addEventListener('deviceorientation', handler);
    };
    const DOE = window.DeviceOrientationEvent;
    if (DOE && typeof DOE.requestPermission === 'function') {
      // iOS: permission has to be requested inside the tap handler.
      DOE.requestPermission()
        .then((res) => res === 'granted' && listen())
        .catch(() => {});
    } else if (DOE) {
      listen();
    }
  }

  animate(time) {
    if (!this.group.visible) return;
    const g = this.group;
    g.position.lerp(this.worldPos, 0.15);

    // Keep the dot and heading cone the same size on screen at every zoom level.
    const dist = this.viewer.camera.position.distanceTo(g.position);
    g.userData.heading.scale.setScalar(dist * 0.075);

    const pulse = (time % 2000) / 2000;
    g.userData.pulse.scale.setScalar(0.05 + pulse * 0.07);
    g.userData.pulse.material.opacity = 0.45 * (1 - pulse);

    const heading = this.deviceHeading ?? this.fix?.heading ?? null;
    const cone = g.userData.heading;
    cone.visible = heading !== null;
    if (heading !== null) {
      this.shownHeading = this.shownHeading === null ? heading : lerpAngle(this.shownHeading, heading, 0.2);
      const { north, east } = this.georef.axes();
      const h = THREE.MathUtils.degToRad(this.shownHeading);
      const dx = north.x * Math.cos(h) + east.x * Math.sin(h);
      const dz = north.z * Math.cos(h) + east.z * Math.sin(h);
      cone.rotation.y = Math.atan2(-dx, -dz);
    }
  }
}

function lerpAngle(a, b, t) {
  const d = ((((b - a) % 360) + 540) % 360) - 180;
  return (a + d * t + 360) % 360;
}

function overlayMaterial(params) {
  return new THREE.MeshBasicMaterial({ transparent: true, depthTest: false, depthWrite: false, ...params });
}

function dotTexture() {
  const size = 128;
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const g = c.getContext('2d');
  const r = size / 2;
  g.fillStyle = 'rgba(0,0,0,0.25)';
  g.beginPath();
  g.arc(r, r + 3, r * 0.62, 0, Math.PI * 2);
  g.fill();
  g.fillStyle = '#ffffff';
  g.beginPath();
  g.arc(r, r, r * 0.62, 0, Math.PI * 2);
  g.fill();
  g.fillStyle = '#1a73e8';
  g.beginPath();
  g.arc(r, r, r * 0.45, 0, Math.PI * 2);
  g.fill();
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

function ringTexture() {
  const size = 128;
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const g = c.getContext('2d');
  g.strokeStyle = '#1a73e8';
  g.lineWidth = 10;
  g.beginPath();
  g.arc(size / 2, size / 2, size / 2 - 8, 0, Math.PI * 2);
  g.stroke();
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

function buildMarker() {
  const group = new THREE.Group();
  group.name = 'gps-marker';

  // Accuracy circle: scaled to the GPS accuracy radius in model units.
  const accuracy = new THREE.Group();
  const disc = new THREE.Mesh(new THREE.CircleGeometry(1, 64).rotateX(-Math.PI / 2), overlayMaterial({ color: BLUE, opacity: 0.13 }));
  const edge = new THREE.Mesh(new THREE.RingGeometry(0.985, 1, 96).rotateX(-Math.PI / 2), overlayMaterial({ color: BLUE, opacity: 0.45 }));
  accuracy.add(disc, edge);
  accuracy.position.y = 0.3;
  accuracy.renderOrder = 10;
  disc.renderOrder = edge.renderOrder = 10;

  // Heading cone, pointing to -z before rotation.
  const spread = THREE.MathUtils.degToRad(32);
  const heading = new THREE.Mesh(
    new THREE.CircleGeometry(1, 24, Math.PI / 2 - spread, spread * 2).rotateX(-Math.PI / 2),
    overlayMaterial({ color: BLUE, opacity: 0.32 }),
  );
  heading.position.y = 0.5;
  heading.renderOrder = 11;
  heading.visible = false;

  // Pulse and dot are sprites with a fixed on-screen size; drawn on top so they stay
  // visible when the person is inside or behind a building.
  const pulse = new THREE.Sprite(
    new THREE.SpriteMaterial({ map: ringTexture(), sizeAttenuation: false, depthTest: false, depthWrite: false, transparent: true }),
  );
  pulse.position.y = 1;
  pulse.renderOrder = 12;
  const dot = new THREE.Sprite(new THREE.SpriteMaterial({ map: dotTexture(), sizeAttenuation: false, depthTest: false, depthWrite: false }));
  dot.scale.setScalar(0.055);
  dot.position.y = 1;
  dot.renderOrder = 13;

  group.add(accuracy, heading, pulse, dot);
  group.userData = { accuracy, heading, pulse, dot };
  return group;
}
