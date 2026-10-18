// Conversion between GPS coordinates and the school model.
//
// Model plan coordinates are Blender X (east-ish) and Y (north-ish). The GLB is exported
// Y-up, so in three.js a Blender point (X, Y, Z) sits at (x = X, y = Z, z = -Y).
// Within a school-sized area a local flat-earth (east/north metres) projection is accurate
// to well under a centimetre, so no map projection library is needed.

const EARTH_RADIUS = 6378137;
const DEG = Math.PI / 180;

export function toEnu(lat0, lon0, lat, lon) {
  return {
    e: (lon - lon0) * DEG * EARTH_RADIUS * Math.cos(lat0 * DEG),
    n: (lat - lat0) * DEG * EARTH_RADIUS,
  };
}

export function fromEnu(lat0, lon0, e, n) {
  return {
    lat: lat0 + n / EARTH_RADIUS / DEG,
    lon: lon0 + e / (EARTH_RADIUS * Math.cos(lat0 * DEG)) / DEG,
  };
}

export function distanceMeters(a, b) {
  const { e, n } = toEnu(a.lat, a.lon, b.lat, b.lon);
  return Math.hypot(e, n);
}

export class Georef {
  constructor(config) {
    this.set(config);
  }

  set(config) {
    this.originLat = config.originLat;
    this.originLon = config.originLon;
    this.metersPerUnit = config.metersPerUnit;
    this.rotationDeg = config.rotationDeg ?? 0;
    this.groundHeight = config.groundHeight ?? 0;
  }

  toJSON() {
    return {
      version: 1,
      originLat: round(this.originLat, 8),
      originLon: round(this.originLon, 8),
      metersPerUnit: round(this.metersPerUnit, 5),
      rotationDeg: round(this.rotationDeg, 3),
      groundHeight: this.groundHeight,
    };
  }

  /** GPS -> three.js world position on the ground plane ({x, z}). */
  toWorld(lat, lon) {
    const { e, n } = toEnu(this.originLat, this.originLon, lat, lon);
    const r = this.rotationDeg * DEG;
    const s = this.metersPerUnit;
    const X = (e * Math.cos(r) - n * Math.sin(r)) / s;
    const Y = (e * Math.sin(r) + n * Math.cos(r)) / s;
    return { x: X, z: -Y };
  }

  /** three.js world position -> GPS. */
  toLatLon(x, z) {
    const r = this.rotationDeg * DEG;
    const s = this.metersPerUnit;
    const X = x * s;
    const Y = -z * s;
    const e = X * Math.cos(r) + Y * Math.sin(r);
    const n = -X * Math.sin(r) + Y * Math.cos(r);
    return fromEnu(this.originLat, this.originLon, e, n);
  }

  /** Unit vectors of true north and east in three.js world space ({x, z}). */
  axes() {
    const r = this.rotationDeg * DEG;
    return {
      north: { x: -Math.sin(r), z: -Math.cos(r) },
      east: { x: Math.cos(r), z: -Math.sin(r) },
    };
  }
}

/**
 * Fit the model-to-GPS transform from control points.
 * Each point is { world: {x, z}, lat, lon }.
 * One point only moves the model; two or more also solve scale and rotation (least squares).
 * Returns the new config plus the remaining error of every point in metres.
 */
export function solveGeoref(points, current) {
  if (!points.length) throw new Error('보정 지점이 없습니다.');
  const lat0 = current.originLat;
  const lon0 = current.originLon;
  // Model plan coordinates P = X + iY, ground truth Q = e + i n (metres around the current origin).
  const P = points.map((p) => ({ re: p.world.x, im: -p.world.z }));
  const Q = points.map((p) => {
    const { e, n } = toEnu(lat0, lon0, p.lat, p.lon);
    return { re: e, im: n };
  });

  // Q = a * P + b, with a = s * e^(-i * rotation).
  let a;
  if (points.length === 1) {
    const r = current.rotationDeg * DEG;
    a = { re: current.metersPerUnit * Math.cos(-r), im: current.metersPerUnit * Math.sin(-r) };
  } else {
    const pm = mean(P);
    const qm = mean(Q);
    let num = { re: 0, im: 0 };
    let den = 0;
    P.forEach((p, i) => {
      const dp = sub(p, pm);
      const dq = sub(Q[i], qm);
      num = add(num, mul(conj(dp), dq));
      den += dp.re * dp.re + dp.im * dp.im;
    });
    if (den < 25) throw new Error('보정 지점들이 너무 가깝습니다. 서로 멀리 떨어진 지점을 고르세요.');
    a = { re: num.re / den, im: num.im / den };
  }
  const b = mean(Q.map((q, i) => sub(q, mul(a, P[i]))));
  const metersPerUnit = Math.hypot(a.re, a.im);
  const rotationDeg = -Math.atan2(a.im, a.re) / DEG;
  const origin = fromEnu(lat0, lon0, b.re, b.im);
  const residuals = P.map((p, i) => {
    const fit = add(mul(a, p), b);
    return Math.hypot(fit.re - Q[i].re, fit.im - Q[i].im);
  });
  return {
    config: {
      originLat: origin.lat,
      originLon: origin.lon,
      metersPerUnit,
      rotationDeg,
      groundHeight: current.groundHeight,
    },
    residuals,
  };
}

const add = (a, b) => ({ re: a.re + b.re, im: a.im + b.im });
const sub = (a, b) => ({ re: a.re - b.re, im: a.im - b.im });
const mul = (a, b) => ({ re: a.re * b.re - a.im * b.im, im: a.re * b.im + a.im * b.re });
const conj = (a) => ({ re: a.re, im: -a.im });
const mean = (list) => {
  const s = list.reduce(add, { re: 0, im: 0 });
  return { re: s.re / list.length, im: s.im / list.length };
};
const round = (v, d) => Math.round(v * 10 ** d) / 10 ** d;
