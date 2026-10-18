// Eco map API server.
//   node server/index.js            API only on 127.0.0.1:5192 (Vite proxies /api and /uploads to it)
//   node server/index.js --static   API plus the built site from dist/ on 0.0.0.0:5191 (production)
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { ADMIN_FILE, DATA_DIR, DIST_DIR, PLANTS_FILE, UPLOAD_DIR } from './paths.js';
import { checkToken, createAdminRecord, issueToken, LoginLimiter, readAdminRecord, verifyPassword } from './auth.js';

const SERVE_STATIC = process.argv.includes('--static');
const HOST = process.env.HOST || (SERVE_STATIC ? '0.0.0.0' : '127.0.0.1');
const PORT = Number(process.env.PORT || (SERVE_STATIC ? 5191 : 5192));
// Set TRUST_PROXY=1 behind Cloudflare / reverse proxies so login limits count real visitor addresses.
const TRUST_PROXY = /^(1|true|yes)$/i.test(process.env.TRUST_PROXY || '');
// Set LOG_REQUESTS=1 to print one access-log line per request.
const LOG_REQUESTS = /^(1|true|yes)$/i.test(process.env.LOG_REQUESTS || '');

const KINDS = new Set(['tree_large', 'tree_medium', 'grass_small']);
const SCHOOL = { lat: 37.5039279, lon: 126.9644627 };
const MAX_DISTANCE_FROM_SCHOOL_M = 3000;
const MAX_BODY_BYTES = 12 * 1024 * 1024;
const MAX_PHOTO_BYTES = 8 * 1024 * 1024;
const NAME_MAX = 40;
const DESCRIPTION_MAX = 1000;
const ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const limiter = new LoginLimiter();

class HttpError extends Error {
  constructor(status, message, headers) {
    super(message);
    this.status = status;
    this.headers = headers;
  }
}

// ------------------------------------------------------------------ plant storage

let plantsCache = null;
let writeQueue = Promise.resolve();

async function loadPlants() {
  if (plantsCache) return plantsCache;
  try {
    plantsCache = JSON.parse(await fs.readFile(PLANTS_FILE, 'utf8'));
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
    plantsCache = { version: 1, plants: [] };
  }
  return plantsCache;
}

async function writeAtomic(file, text) {
  const tmp = file + '.' + process.pid + '.tmp';
  await fs.writeFile(tmp, text);
  await fs.rename(tmp, file);
}

/** Run fn on a copy of the data, save it, and only then make it the live copy. Calls run one at a time. */
function mutatePlants(fn) {
  const run = writeQueue.then(async () => {
    const next = structuredClone(await loadPlants());
    const result = await fn(next);
    await writeAtomic(PLANTS_FILE, JSON.stringify(next, null, 2) + '\n');
    plantsCache = next;
    return result;
  });
  writeQueue = run.catch(() => {});
  return run;
}

// ------------------------------------------------------------------ validation

function cleanText(value, max, { label, emptyMessage }) {
  if (value === undefined || value === null) value = '';
  if (typeof value !== 'string') throw new HttpError(400, label + ' 형식이 잘못되었습니다.');
  // Drop control characters except line breaks and tabs, normalise line endings.
  const text = value.replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '').trim();
  if (emptyMessage && !text) throw new HttpError(400, emptyMessage);
  if ([...text].length > max) throw new HttpError(400, label + ' 글자 수는 ' + max + '자까지입니다.');
  return text;
}

function distanceMeters(a, b) {
  const R = 6378137;
  const rad = Math.PI / 180;
  const e = (b.lon - a.lon) * rad * R * Math.cos(a.lat * rad);
  const n = (b.lat - a.lat) * rad * R;
  return Math.hypot(e, n);
}

function decodePhoto(dataUrl) {
  if (typeof dataUrl !== 'string') throw new HttpError(400, '사진을 첨부하세요.');
  const m = /^data:image\/(jpeg|png|webp);base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl);
  if (!m) throw new HttpError(400, '사진은 JPG, PNG, WebP만 올릴 수 있습니다.');
  const buf = Buffer.from(m[2], 'base64');
  if (!buf.length) throw new HttpError(400, '사진 파일이 비어 있습니다.');
  if (buf.length > MAX_PHOTO_BYTES) throw new HttpError(413, '사진이 너무 큽니다 (최대 8 MB).');
  // Trust the bytes, not the declared type.
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return { buf, ext: 'jpg' };
  if (buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return { buf, ext: 'png' };
  if (buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') return { buf, ext: 'webp' };
  throw new HttpError(400, '사진 파일을 읽을 수 없습니다.');
}

function validatePlant(body) {
  if (!body || typeof body !== 'object') throw new HttpError(400, '요청 형식이 잘못되었습니다.');
  const name = cleanText(body.name, NAME_MAX, { label: '이름', emptyMessage: '식물 이름을 입력하세요.' });
  const description = cleanText(body.description, DESCRIPTION_MAX, { label: '설명' });
  if (!KINDS.has(body.kind)) throw new HttpError(400, '식물 모델을 골라 주세요.');
  const lat = Number(body.lat);
  const lon = Number(body.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) {
    throw new HttpError(400, '위치가 올바르지 않습니다.');
  }
  if (distanceMeters(SCHOOL, { lat, lon }) > MAX_DISTANCE_FROM_SCHOOL_M) {
    throw new HttpError(400, '학교에서 너무 먼 위치입니다.');
  }
  const photo = decodePhoto(body.photo);
  return { name, description, kind: body.kind, lat: Math.round(lat * 1e8) / 1e8, lon: Math.round(lon * 1e8) / 1e8, photo };
}

// ------------------------------------------------------------------ http helpers

function send(res, status, body, headers = {}) {
  const data = body === undefined ? '' : JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    ...headers,
  });
  res.end(data);
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers['content-length'] || 0);
    if (declared > MAX_BODY_BYTES) return reject(new HttpError(413, '보내는 데이터가 너무 큽니다.'));
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new HttpError(413, '보내는 데이터가 너무 큽니다.'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try {
        resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {});
      } catch {
        reject(new HttpError(400, '요청 형식이 잘못되었습니다.'));
      }
    });
    req.on('error', reject);
  });
}

function clientKey(req) {
  const remote = req.socket.remoteAddress || '';
  if (TRUST_PROXY) {
    // Cloudflare (including Cloudflare Tunnel) sets CF-Connecting-IP to the visitor's address.
    const forwarded = String(req.headers['cf-connecting-ip'] || req.headers['x-real-ip'] || '').trim();
    if (forwarded) return forwarded;
  }
  const loopback = remote === '127.0.0.1' || remote === '::1' || remote === '::ffff:127.0.0.1';
  // Behind the Vite dev proxy every request comes from loopback; trust its forwarded address only then.
  const forwarded = loopback ? String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() : '';
  return forwarded || remote;
}

async function requireAdmin(req) {
  const record = await readAdminRecord(ADMIN_FILE);
  const auth = String(req.headers.authorization || '');
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  if (!checkToken(token, record)) throw new HttpError(401, '관리자 로그인이 필요합니다.');
}

const toPublic = (p) => ({
  id: p.id,
  name: p.name,
  description: p.description,
  kind: p.kind,
  lat: p.lat,
  lon: p.lon,
  photo: 'uploads/' + p.photoFile,
  createdAt: p.createdAt,
});

// ------------------------------------------------------------------ routes

async function login(req, res) {
  const key = clientKey(req);
  const wait = limiter.retryAfterMs(key);
  if (wait > 0) {
    const minutes = Math.ceil(wait / 60000);
    throw new HttpError(429, '비밀번호를 여러 번 틀렸습니다. ' + minutes + '분 뒤에 다시 시도하세요.', {
      'retry-after': String(Math.ceil(wait / 1000)),
    });
  }
  const body = await readJson(req);
  const record = await readAdminRecord(ADMIN_FILE);
  if (!record) throw new HttpError(503, '관리자 비밀번호가 아직 설정되지 않았습니다. 서버에서 npm run set-password 를 실행하세요.');
  if (!(await verifyPassword(body.password, record))) {
    limiter.fail(key);
    await new Promise((r) => setTimeout(r, 400));
    throw new HttpError(401, '비밀번호가 맞지 않습니다.');
  }
  limiter.succeed(key);
  send(res, 200, issueToken(record));
}

async function createPlant(req, res) {
  await requireAdmin(req);
  const input = validatePlant(await readJson(req));
  const id = crypto.randomUUID();
  const photoFile = id + '.' + input.photo.ext;
  await fs.mkdir(UPLOAD_DIR, { recursive: true });
  await fs.writeFile(path.join(UPLOAD_DIR, photoFile), input.photo.buf);
  const plant = {
    id,
    name: input.name,
    description: input.description,
    kind: input.kind,
    lat: input.lat,
    lon: input.lon,
    photoFile,
    createdAt: new Date().toISOString(),
  };
  try {
    await mutatePlants((data) => {
      data.plants.push(plant);
    });
  } catch (err) {
    await fs.rm(path.join(UPLOAD_DIR, photoFile), { force: true });
    throw err;
  }
  send(res, 201, { plant: toPublic(plant) });
}

async function deletePlant(req, res, id) {
  await requireAdmin(req);
  const removed = await mutatePlants((data) => {
    const i = data.plants.findIndex((p) => p.id === id);
    return i < 0 ? null : data.plants.splice(i, 1)[0];
  });
  if (!removed) throw new HttpError(404, '이미 삭제된 식물입니다.');
  await fs.rm(path.join(UPLOAD_DIR, removed.photoFile), { force: true });
  send(res, 200, { ok: true });
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.glb': 'model/gltf-binary',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

async function sendFile(req, res, file, cacheControl) {
  let stat;
  try {
    stat = await fs.stat(file);
  } catch {
    return false;
  }
  if (!stat.isFile()) return false;
  const etag = 'W/"' + stat.size.toString(16) + '-' + Math.floor(stat.mtimeMs).toString(16) + '"';
  if (req.headers['if-none-match'] === etag) {
    res.writeHead(304, { etag, 'cache-control': cacheControl });
    res.end();
    return true;
  }
  res.writeHead(200, {
    'content-type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
    'content-length': stat.size,
    'cache-control': cacheControl,
    etag,
    'last-modified': stat.mtime.toUTCString(),
    'x-content-type-options': 'nosniff',
  });
  if (req.method === 'HEAD') res.end();
  else createReadStream(file).pipe(res);
  return true;
}

async function serveStatic(req, res, pathname) {
  const rel = decodeURIComponent(pathname).replace(/^\/+/, '') || 'index.html';
  const file = path.resolve(DIST_DIR, rel);
  if (!file.startsWith(DIST_DIR + path.sep)) return false;
  const immutable = rel.startsWith('assets/');
  return sendFile(req, res, file, immutable ? 'public, max-age=31536000, immutable' : 'no-cache');
}

async function handle(req, res) {
  const { pathname } = new URL(req.url, 'http://localhost');
  const method = req.method;

  if (pathname === '/api/plants' && method === 'GET') {
    const data = await loadPlants();
    return send(res, 200, { plants: data.plants.map(toPublic) });
  }
  if (pathname === '/api/plants' && method === 'POST') return createPlant(req, res);
  if (pathname === '/api/login' && method === 'POST') return login(req, res);
  if (pathname === '/api/session' && method === 'GET') {
    await requireAdmin(req);
    return send(res, 200, { ok: true });
  }
  const plantPath = /^\/api\/plants\/([^/]+)$/.exec(pathname);
  if (plantPath && method === 'DELETE') {
    if (!ID_RE.test(plantPath[1])) throw new HttpError(404, '식물을 찾을 수 없습니다.');
    return deletePlant(req, res, plantPath[1]);
  }
  if (pathname.startsWith('/api/')) throw new HttpError(404, '없는 주소입니다.');

  const upload = /^\/uploads\/([0-9a-f-]{36}\.(?:jpg|png|webp))$/.exec(pathname);
  if (upload && (method === 'GET' || method === 'HEAD')) {
    if (await sendFile(req, res, path.join(UPLOAD_DIR, upload[1]), 'public, max-age=31536000, immutable')) return;
    throw new HttpError(404, '사진이 없습니다.');
  }
  if (SERVE_STATIC && (method === 'GET' || method === 'HEAD') && (await serveStatic(req, res, pathname))) return;
  throw new HttpError(404, '없는 주소입니다.');
}

const server = http.createServer((req, res) => {
  if (LOG_REQUESTS) {
    const t0 = Date.now();
    res.on('finish', () => {
      console.log('[req] ' + req.method + ' ' + req.url + ' ' + res.statusCode + ' ' + (Date.now() - t0) + 'ms host=' + req.headers.host + ' from=' + req.socket.remoteAddress);
    });
  }
  handle(req, res).catch((err) => {
    if (!(err instanceof HttpError)) console.error(err);
    if (res.headersSent) return res.end();
    const status = err instanceof HttpError ? err.status : 500;
    send(res, status, { error: err instanceof HttpError ? err.message : '서버 오류가 났습니다.' }, err.headers);
  });
});
server.on('clientError', (err, socket) => {
  console.warn('[biomemap] 잘못된 HTTP 요청: ' + (err.code || '') + ' ' + err.message);
  if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
  else socket.destroy();
});

await fs.mkdir(UPLOAD_DIR, { recursive: true });

// On servers the admin password can come from the BIOMEMAP_ADMIN_PASSWORD environment variable.
// When it is set it wins: changing it and restarting changes the password (and logs everyone out).
const envPassword = process.env.BIOMEMAP_ADMIN_PASSWORD;
const existingAdmin = await readAdminRecord(ADMIN_FILE);
if (envPassword && !(existingAdmin && (await verifyPassword(envPassword, existingAdmin)))) {
  await fs.writeFile(ADMIN_FILE, JSON.stringify(await createAdminRecord(envPassword), null, 2) + '\n', { mode: 0o600 });
  console.log('[biomemap] 관리자 비밀번호를 BIOMEMAP_ADMIN_PASSWORD 환경 변수 값으로 설정했습니다.');
} else if (!existingAdmin) {
  console.warn('[biomemap] 관리자 비밀번호가 없습니다. "npm run set-password" 로 설정하세요.');
}

/** Resolves once the server is listening (scripts/dev.mjs waits for it before starting Vite). */
export const ready = new Promise((resolve) => {
  server.once('error', (err) => {
    console.error(
      err.code === 'EADDRINUSE'
        ? '[biomemap] 포트 ' + PORT + '을(를) 이미 다른 프로그램이 쓰고 있습니다. 먼저 켜 둔 서버를 끄고 다시 실행하세요.'
        : '[biomemap] 서버를 시작하지 못했습니다: ' + err.message,
    );
    process.exit(1);
  });
  server.listen(PORT, HOST, () => {
    console.log('[biomemap] API ' + (SERVE_STATIC ? '+ site ' : '') + 'http://' + HOST + ':' + PORT + '  data: ' + DATA_DIR);
    resolve();
  });
});
