// Talks to server/index.js. Paths are relative so the site also works under a sub-path.
const BASE = import.meta.env.BASE_URL;
const TOKEN_KEY = 'biomemap.adminToken';

export class ApiError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

export function getToken() {
  try {
    const saved = JSON.parse(localStorage.getItem(TOKEN_KEY));
    if (saved && saved.expiresAt > Date.now()) return saved.token;
  } catch {
    /* ignore broken storage */
  }
  localStorage.removeItem(TOKEN_KEY);
  return null;
}

export function setToken(session) {
  if (session) localStorage.setItem(TOKEN_KEY, JSON.stringify(session));
  else localStorage.removeItem(TOKEN_KEY);
}

export function assetUrl(relative) {
  return BASE + relative;
}

async function request(path, { method = 'GET', body, auth = false } = {}) {
  const headers = {};
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (auth) {
    const token = getToken();
    if (!token) throw new ApiError('관리자 로그인이 필요합니다.', 401);
    headers.authorization = 'Bearer ' + token;
  }
  let res;
  try {
    res = await fetch(BASE + 'api/' + path, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      cache: 'no-store',
    });
  } catch {
    throw new ApiError('서버에 연결할 수 없습니다. 인터넷 연결을 확인하세요.', 0);
  }
  let data = null;
  try {
    data = await res.json();
  } catch {
    data = null;
  }
  if (!res.ok) {
    if (res.status === 401 && auth) setToken(null);
    throw new ApiError(data?.error || '서버 오류가 났습니다 (' + res.status + ').', res.status);
  }
  return data;
}

export const api = {
  listPlants: () => request('plants').then((d) => d.plants),
  login: (password) => request('login', { method: 'POST', body: { password } }),
  checkSession: () => request('session', { auth: true }),
  createPlant: (plant) => request('plants', { method: 'POST', body: plant, auth: true }).then((d) => d.plant),
  deletePlant: (id) => request('plants/' + encodeURIComponent(id), { method: 'DELETE', auth: true }),
};
