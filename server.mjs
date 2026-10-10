import http from 'node:http';
import { randomBytes, scryptSync, scrypt, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';

const derive = promisify(scrypt);
const SESSION_TTL = 12 * 60 * 60 * 1000;
const ASSETS = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
  ['/style.css', ['style.css', 'text/css; charset=utf-8']],
].map(([path, [file, type]]) => [path, { type, body: readFileSync(new URL(`./public/${file}`, import.meta.url)) }]));

function secret(env, name) {
  if (env[name] && env[`${name}_FILE`]) throw new Error(`Choose ${name} or ${name}_FILE, not both`);
  return env[`${name}_FILE`] ? readFileSync(env[`${name}_FILE`], 'utf8').trimEnd() : env[name];
}

export function loadConfig(env = process.env) {
  const password = secret(env, 'VIEWER_PASSWORD');
  const qbitPassword = secret(env, 'QBIT_PASSWORD');
  if (!password || password.length < 16 || password.length > 1024 || password.startsWith('CHANGE_ME')) {
    throw new Error('VIEWER_PASSWORD must be a unique password of 16–1024 characters');
  }
  if (!env.QBIT_URL || !env.QBIT_USERNAME || !qbitPassword) throw new Error('QBIT_URL, QBIT_USERNAME and QBIT_PASSWORD are required');
  const upstream = new URL(env.QBIT_URL);
  if (!['http:', 'https:'].includes(upstream.protocol) || upstream.username || upstream.password || upstream.search || upstream.hash) {
    throw new Error('QBIT_URL must be an HTTP(S) URL without credentials, query or fragment');
  }
  const origin = new URL(env.PUBLIC_ORIGIN || 'https://downloads.example.invalid');
  if (!env.PUBLIC_ORIGIN || !['http:', 'https:'].includes(origin.protocol) || origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash) {
    throw new Error('PUBLIC_ORIGIN must be the exact public origin, e.g. https://suivi.example.com');
  }
  if (origin.protocol === 'http:' && env.COOKIE_SECURE !== 'false') throw new Error('HTTP testing requires COOKIE_SECURE=false; use HTTPS in production');
  if (origin.protocol === 'https:' && env.COOKIE_SECURE === 'false') throw new Error('Secure cookies are required for HTTPS');
  const port = Number(env.PORT || 5080);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid PORT');
  let categories = null;
  if (env.QBIT_CATEGORIES?.trim()) {
    categories = JSON.parse(env.QBIT_CATEGORIES);
    if (!Array.isArray(categories) || categories.length === 0 || categories.some(c => typeof c !== 'string')) {
      throw new Error('QBIT_CATEGORIES must be a nonempty JSON array of category names');
    }
  }
  return {
    password, username: env.VIEWER_USERNAME || 'ami', port,
    host: env.HOST || '0.0.0.0', origin: origin.origin,
    secure: origin.protocol === 'https:',
    qbitUrl: upstream.href.replace(/\/$/, ''), qbitUsername: env.QBIT_USERNAME, qbitPassword,
    categories,
  };
}

async function limitedText(response, max = 8 * 1024 * 1024) {
  if (!response.body) return '';
  const reader = response.body.getReader();
  let size = 0;
  const chunks = [];
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > max) throw new Error('Response too large');
      chunks.push(Buffer.from(value));
    }
    return Buffer.concat(chunks).toString('utf8');
  } finally { await reader.cancel().catch(() => {}); }
}

const number = (v, fallback = 0) => typeof v === 'number' && Number.isFinite(v) ? Math.max(0, v) : fallback;
const count = v => typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.floor(v) : null;
const label = (v, max = 500) => typeof v === 'string' ? v.slice(0, max) : '';
const STATES = new Set(['error', 'missingFiles', 'uploading', 'pausedUP', 'stoppedUP', 'queuedUP', 'stalledUP', 'checkingUP', 'forcedUP', 'allocating', 'downloading', 'metaDL', 'forcedMetaDL', 'pausedDL', 'stoppedDL', 'queuedDL', 'stalledDL', 'checkingDL', 'forcedDL', 'checkingResumeData', 'moving', 'unknown']);

// Explicit projection: no hashes, paths, magnets, trackers, peer IPs or upstream preferences.
export function projectTorrent(t) {
  const eta = count(t.eta);
  return {
    name: label(t.name), category: label(t.category, 100),
    state: STATES.has(t.state) ? t.state : 'unknown',
    progress: Math.min(1, number(t.progress)), size: number(t.size),
    downloaded: number(t.completed), uploaded: number(t.uploaded),
    downloadSpeed: number(t.dlspeed), uploadSpeed: number(t.upspeed),
    eta: eta === null || eta >= 8640000 ? null : eta,
    seedsConnected: count(t.num_seeds), seedsTotal: count(t.num_complete),
    peersConnected: count(t.num_leechs), peersTotal: count(t.num_incomplete),
    ratio: number(t.ratio),
  };
}

export function createQbitClient(config) {
  let sid = '';
  let cache = null;
  let expires = 0;
  let failedUntil = 0;
  let inFlight;
  async function request(path, init = {}) {
    return fetch(`${config.qbitUrl}/api/v2/${path}`, {
      ...init, redirect: 'error', signal: AbortSignal.timeout(8000),
      headers: { Referer: `${config.qbitUrl}/`, ...(sid ? { Cookie: sid } : {}), ...init.headers },
    });
  }
  async function login() {
    const response = await request('auth/login', {
      method: 'POST',
      body: new URLSearchParams({ username: config.qbitUsername, password: config.qbitPassword }),
    });
    if (!response.ok || (await limitedText(response, 4096)).trim() !== 'Ok.') throw new Error('qBittorrent authentication failed');
    const cookie = response.headers.getSetCookie().find(c => c.startsWith('SID='));
    const value = cookie?.split(';', 1)[0];
    if (!value || !/^SID=[A-Za-z0-9_-]+$/.test(value)) throw new Error('qBittorrent did not return a session; disable authentication bypass for this client');
    sid = value;
  }
  async function refresh() {
    if (!sid) await login();
    let response = await request('torrents/info');
    if (response.status === 401 || response.status === 403) {
      await response.body?.cancel();
      sid = '';
      await login();
      response = await request('torrents/info');
    }
    if (!response.ok) { await response.body?.cancel(); throw new Error('qBittorrent unavailable'); }
    const raw = JSON.parse(await limitedText(response));
    if (!Array.isArray(raw) || raw.length > 20000 || raw.some(t => !t || typeof t !== 'object')) throw new Error('Invalid torrent list');
    const torrents = raw.filter(t => !config.categories || config.categories.includes(t.category)).map(projectTorrent);
    cache = { updatedAt: new Date().toISOString(), torrents };
    expires = Date.now() + 5000;
    return cache;
  }
  return {
    getSnapshot() {
      if (cache && Date.now() < expires) return Promise.resolve(cache);
      if (Date.now() < failedUntil) return Promise.reject(new Error('qBittorrent unavailable'));
      if (!inFlight) inFlight = refresh().catch(error => { failedUntil = Date.now() + 5000; throw error; }).finally(() => { inFlight = null; });
      return inFlight;
    },
  };
}

async function bodyJSON(req) {
  let bytes = 0;
  const chunks = [];
  if (!/^application\/json(?:;|$)/i.test(req.headers['content-type'] || '')) throw new Error('Invalid content type');
  for await (const chunk of req) {
    bytes += chunk.length;
    if (bytes > 4096) throw new Error('Body too large');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

export function createApp(config, qbit = createQbitClient(config)) {
  const salt = randomBytes(32);
  const expected = scryptSync(config.password, salt, 64);
  const sessions = new Map();
  const attempts = new Map();
  let globalAttempts = [];
  let passwordChecks = 0;
  let lastPrune = 0;
  const cookieName = config.secure ? '__Host-tw_session' : 'tw_session';
  const cookie = (token, age = SESSION_TTL / 1000) => `${cookieName}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${age}${config.secure ? '; Secure' : ''}`;
  function send(res, code, data) {
    res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(data));
  }
  const server = http.createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    try {
      const now = Date.now();
      if (now - lastPrune > 60000) {
        for (const [token, until] of sessions) if (until <= now) sessions.delete(token);
        for (const [ip, record] of attempts) if (record.until <= now) attempts.delete(ip);
        lastPrune = now;
      }
      const path = new URL(req.url, 'http://localhost').pathname;
      if (req.method === 'GET' && path === '/healthz') return send(res, 200, { status: 'ok' });
      if (req.headers['sec-fetch-site'] === 'cross-site' || (req.headers.origin && req.headers.origin !== config.origin)) {
        return send(res, 403, { error: 'Origine non autorisée.' });
      }
      // Require an exact configured browser origin on all state-changing requests.
      if (req.method === 'POST' && req.headers.origin !== config.origin) return send(res, 403, { error: 'Origine non autorisée.' });
      if (req.method === 'POST' && path === '/api/login') {
        // Use the socket address, never an untrusted forwarded header. Behind Caddy,
        // this deliberately shares the login budget across viewers (see README).
        const ip = req.socket.remoteAddress;
        let record = attempts.get(ip);
        if (!record || record.until <= now) record = { count: 0, until: now + 15 * 60000 };
        globalAttempts = globalAttempts.filter(t => now - t < 60000);
        if (record.count >= 10 || globalAttempts.length >= 20 || attempts.size > 10000) {
          res.setHeader('Retry-After', '900');
          return send(res, 429, { error: 'Trop de tentatives. Réessaie dans 15 minutes.' });
        }
        record.count++;
        attempts.set(ip, record);
        globalAttempts.push(now);
        let input;
        try { input = await bodyJSON(req); } catch { return send(res, 400, { error: 'Requête invalide.' }); }
        if (!input || typeof input.password !== 'string' || input.password.length > 1024 || typeof input.username !== 'string') return send(res, 400, { error: 'Requête invalide.' });
        if (passwordChecks >= 2) return send(res, 429, { error: 'Connexion occupée. Réessaie dans quelques secondes.' });
        let actual;
        passwordChecks++;
        try { actual = await derive(input.password, salt, 64); }
        finally { passwordChecks--; }
        if (!timingSafeEqual(expected, actual) || input.username !== config.username) return send(res, 401, { error: 'Identifiant ou mot de passe incorrect.' });
        if (sessions.size >= 10000) return send(res, 503, { error: 'Réessaie plus tard.' });
        attempts.delete(ip);
        const token = randomBytes(32).toString('hex');
        sessions.set(token, now + SESSION_TTL);
        res.setHeader('Set-Cookie', cookie(token));
        return send(res, 200, { authenticated: true });
      }
      const token = (req.headers.cookie || '').split(';').map(s => s.trim()).find(s => s.startsWith(`${cookieName}=`))?.slice(cookieName.length + 1);
      const authenticated = !!token && (sessions.get(token) || 0) > now;
      if (path.startsWith('/api/')) {
        if (!authenticated) return send(res, 401, { error: 'Connexion nécessaire.' });
        if (req.method === 'GET' && path === '/api/session') return send(res, 200, { authenticated: true });
        if (req.method === 'POST' && path === '/api/logout') {
          sessions.delete(token);
          res.setHeader('Set-Cookie', cookie('', 0));
          return send(res, 200, { authenticated: false });
        }
        if (req.method === 'GET' && path === '/api/torrents') {
          try { return send(res, 200, await qbit.getSnapshot()); }
          catch { return send(res, 502, { error: 'qBittorrent est momentanément inaccessible. Les dernières données affichées ne sont plus à jour.' }); }
        }
        return send(res, 404, { error: 'Route inconnue.' });
      }
      const asset = ASSETS.get(path);
      if (req.method === 'GET' && asset) {
        res.writeHead(200, { 'Content-Type': asset.type });
        return res.end(asset.body);
      }
      return send(res, 404, { error: 'Route inconnue.' });
    } catch { if (!res.headersSent) send(res, 500, { error: 'Erreur interne.' }); else res.end(); }
  });
  server.requestTimeout = 15000;
  server.headersTimeout = 10000;
  server.keepAliveTimeout = 5000;
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const config = loadConfig();
    const server = createApp(config);
    server.listen(config.port, config.host, () => console.log(`Torrent Watch listening on port ${config.port}`));
    for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => server.close(() => process.exit(0)));
  } catch { console.error('Startup failed. Check required variables, secret files, PUBLIC_ORIGIN and QBIT_CATEGORIES (see README).'); process.exit(1); }
}
