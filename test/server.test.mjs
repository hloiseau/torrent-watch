import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createApp, createQbitClient, loadConfig, projectTorrent } from '../server.mjs';
import { createPlexClient, PlexDenied } from '../plex.mjs';

const base = {
  PLEX_SERVER_ID: 'my-server-identifier', QBIT_URL: 'http://127.0.0.1:8080',
  QBIT_USERNAME: 'admin', QBIT_PASSWORD: 'upstream-test-secret', PUBLIC_ORIGIN: 'http://localhost:5080', COOKIE_SECURE: 'false',
};
function fakePlex(overrides = {}) {
  return { createPin: async () => ({ id: 123, code: 'strongpincode', clientId: 'test-client', expires: Date.now() + 300000 }),
    checkPin: async () => 'private-plex-token', verifyAccess: async () => ({ name: 'Friend' }), ...overrides };
}
async function start(server, t) {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  return `http://127.0.0.1:${server.address().port}`;
}
async function app(t, options = {}, plex = fakePlex(), clock = Date.now) {
  const config = loadConfig({ ...base, ...options });
  const server = createApp(config, { getSnapshot: async () => ({ updatedAt: '2026-10-10T10:00:00Z', torrents: [{ name: 'Ubuntu' }] }) }, plex, clock);
  return { url: await start(server, t), config };
}
function post(url, config, path, cookie = '', body = {}) {
  return fetch(`${url}${path}`, { method: 'POST', headers: { Origin: config.origin, Cookie: cookie, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
}
const getCookie = response => response.headers.getSetCookie()[0].split(';')[0];
async function login(url, config) {
  const start = await post(url, config, '/api/auth/plex/start');
  assert.equal(start.status, 200);
  return post(url, config, '/api/auth/plex/status', getCookie(start));
}

test('configuration requires an exact Plex server ID and fails closed', () => {
  for (const overrides of [{ PLEX_SERVER_ID: '' }, { PLEX_SERVER_ID: 'CHANGE_ME_PLEX_MACHINE_IDENTIFIER' }, { PLEX_SERVER_ID: 'server name' }, { QBIT_PASSWORD: '' }, { PUBLIC_ORIGIN: '' }, { PUBLIC_ORIGIN: 'https://example.com/path' }, { QBIT_URL: 'file:///etc/passwd' }, { QBIT_URL: 'http://admin:secret@host' }, { QBIT_CATEGORIES: 'sonarr' }, { QBIT_CATEGORIES: '[]' }, { COOKIE_SECURE: 'true' }]) assert.throws(() => loadConfig({ ...base, ...overrides }));
  assert.deepEqual(loadConfig({ ...base, QBIT_CATEGORIES: '["sonarr",""]' }).categories, ['sonarr', '']);
});

test('anonymous clients cannot read data; public shell permits the Plex return', async t => {
  const { url, config } = await app(t);
  for (const path of ['/api/torrents', '/api/session']) assert.equal((await fetch(`${url}${path}`)).status, 401);
  assert.equal((await post(url, config, '/api/login', '', { username: 'ami', password: 'old-password' })).status, 401);
  const shell = await fetch(url, { headers: { 'Sec-Fetch-Site': 'cross-site' } });
  assert.equal(shell.status, 200);
  assert.match(shell.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  assert.equal(shell.headers.get('cache-control'), 'no-store');
  assert.doesNotMatch(await shell.text(), /upstream-test-secret|private-plex-token/);
});

test('Plex login, read-only routes, logout and invalidated session', async t => {
  const { url, config } = await app(t);
  const response = await login(url, config);
  assert.equal(response.status, 200);
  const cookie = getCookie(response);
  assert.match(response.headers.get('set-cookie'), /HttpOnly; SameSite=Strict/);
  assert.doesNotMatch(await response.text(), /private-plex-token|test-client|strongpincode/);
  const snapshot = await fetch(`${url}/api/torrents`, { headers: { Cookie: cookie } });
  assert.equal(snapshot.status, 200);
  assert.equal((await snapshot.json()).torrents[0].name, 'Ubuntu');
  for (const path of ['/api/torrents', '/api/v2/torrents/delete', '/api/proxy', '/api/settings']) assert.equal((await post(url, config, path, cookie)).status, 404);
  assert.equal((await post(url, config, '/api/logout', cookie)).status, 200);
  assert.equal((await fetch(`${url}/api/torrents`, { headers: { Cookie: cookie } })).status, 401);
});

test('HTTPS cookies are secure, host-scoped and pending flow uses Lax', async t => {
  const { url, config } = await app(t, { PUBLIC_ORIGIN: 'https://suivi.example.com', COOKIE_SECURE: 'true' });
  const response = await post(url, config, '/api/auth/plex/start');
  assert.match(response.headers.get('set-cookie'), /^__Host-tw_plex=.+SameSite=Lax; Max-Age=300; Secure$/);
  const authUrl = new URL((await response.json()).authUrl);
  assert.equal(authUrl.origin, 'https://app.plex.tv');
  assert.equal(new URLSearchParams(authUrl.hash.slice(2)).get('forwardUrl'), config.origin + '/?plex=return');
  const session = await post(url, config, '/api/auth/plex/status', getCookie(response));
  assert.match(session.headers.getSetCookie()[0], /^__Host-tw_session=.+; Secure$/);
});

test('PIN is bound to the initiating browser, single use and no client PIN/token is trusted', async t => {
  let checks = 0;
  const { url, config } = await app(t, {}, fakePlex({ checkPin: async pin => { checks++; assert.equal(pin.id, 123); return 'private-token'; } }));
  const begin = await post(url, config, '/api/auth/plex/start', '', { forwardUrl: 'https://evil.example' });
  assert.equal((await post(url, config, '/api/auth/plex/status', '', { pinId: 123, authToken: 'attacker' })).status, 401);
  assert.equal(checks, 0);
  const cookie = getCookie(begin);
  assert.equal((await post(url, config, '/api/auth/plex/status', cookie, { pinId: 999 })).status, 200);
  assert.equal((await post(url, config, '/api/auth/plex/status', cookie)).status, 401);
  assert.equal(checks, 1);
});

test('cross-origin, missing Origin and oversized login requests are rejected', async t => {
  const { url, config } = await app(t);
  for (const origin of [undefined, 'https://evil.example']) assert.equal((await fetch(`${url}/api/auth/plex/start`, { method: 'POST', headers: origin ? { Origin: origin } : {} })).status, 403);
  assert.equal((await fetch(`${url}/api/torrents`, { headers: { Origin: 'https://evil.example' } })).status, 403);
  assert.equal((await post(url, config, '/api/auth/plex/start', '', { huge: 'a'.repeat(5000) })).status, 400);
});

test('login rate limiting ignores spoofed forwarded addresses', async t => {
  const { url, config } = await app(t);
  for (let i = 0; i < 10; i++) assert.equal((await post(url, config, '/api/auth/plex/start')).status, 200);
  const blocked = await fetch(`${url}/api/auth/plex/start`, { method: 'POST', headers: { Origin: config.origin, 'Content-Type': 'application/json', 'X-Forwarded-For': '203.0.113.123' }, body: '{}' });
  assert.equal(blocked.status, 429);
  assert.equal(blocked.headers.get('retry-after'), '900');
});

test('Plex client checks exact server membership, user token, and sanitizes identity', async () => {
  const config = loadConfig(base);
  for (const resource of [
    { clientIdentifier: base.PLEX_SERVER_ID, provides: 'server', owned: true },
    { clientIdentifier: base.PLEX_SERVER_ID, provides: 'server', accessToken: 'shared-server-token' },
    { clientIdentifier: 'other-server', provides: 'server', owned: true },
    { clientIdentifier: base.PLEX_SERVER_ID, provides: 'player', owned: true },
    { clientIdentifier: base.PLEX_SERVER_ID, provides: 'server', owned: false, accessToken: null },
  ]) {
    const client = createPlexClient(config, async (url, init) => {
      assert.equal(init.headers['X-Plex-Token'], 'my-user-token');
      assert.equal(init.redirect, 'error');
      return Response.json(url.endsWith('/user') ? { id: 42, username: 'Friend', email: 'private-email', authToken: 'secret' } : [resource]);
    });
    if (resource.clientIdentifier === base.PLEX_SERVER_ID && resource.provides === 'server' && (resource.owned || resource.accessToken)) assert.deepEqual(await client.verifyAccess('my-user-token', 'client'), { name: 'Friend' });
    else await assert.rejects(client.verifyAccess('my-user-token', 'client'), PlexDenied);
  }
});

test('real Plex client constructs a strong PIN and checks the stored ID and code', async () => {
  let calls = 0; let clientId;
  const client = createPlexClient(loadConfig(base), async (url, init) => {
    calls++;
    if (calls === 1) {
      assert.equal(url, 'https://plex.tv/api/v2/pins?strong=true'); assert.equal(init.method, 'POST');
      clientId = init.headers['X-Plex-Client-Identifier'];
      return Response.json({ id: 123, code: 'strongpincode', expiresIn: 1800 });
    }
    assert.equal(init.headers['X-Plex-Client-Identifier'], clientId);
    assert.equal(url, 'https://plex.tv/api/v2/pins/123?code=strongpincode');
    return Response.json({ id: calls === 3 ? 999 : 123, code: 'strongpincode', authToken: 'private-token' });
  });
  const pin = await client.createPin();
  assert.ok(pin.expires <= Date.now() + 300000);
  assert.equal(await client.checkPin(pin), 'private-token');
  await assert.rejects(client.checkPin(pin), PlexDenied);
});

test('revoked sharing removes an active session after at most five minutes', async t => {
  let now = Date.now(); let checks = 0; let revoked = false;
  const { url, config } = await app(t, {}, fakePlex({ verifyAccess: async () => { checks++; if (revoked) throw new PlexDenied(); return { name: 'Friend' }; } }), () => now);
  const cookie = getCookie(await login(url, config));
  revoked = true;
  now += 299000;
  assert.equal((await fetch(`${url}/api/torrents`, { headers: { Cookie: cookie } })).status, 200);
  assert.equal(checks, 1);
  now += 1001;
  assert.equal((await fetch(`${url}/api/torrents`, { headers: { Cookie: cookie } })).status, 403);
  assert.equal((await fetch(`${url}/api/torrents`, { headers: { Cookie: cookie } })).status, 401);
});

test('Plex outages fail closed with backoff and recover; logout works during outage', async t => {
  let now = Date.now(); let offline = false; let checks = 0;
  const { url, config } = await app(t, {}, fakePlex({ verifyAccess: async () => { checks++; if (offline) throw new Error('SECRET upstream'); return { name: 'Friend' }; } }), () => now);
  const cookie = getCookie(await login(url, config));
  now += 300001; offline = true;
  for (let i = 0; i < 2; i++) {
    const response = await fetch(`${url}/api/torrents`, { headers: { Cookie: cookie } });
    assert.equal(response.status, 503); assert.doesNotMatch(await response.text(), /Ubuntu|SECRET|private-token/);
  }
  assert.equal(checks, 2);
  offline = false; now += 10001;
  assert.equal((await fetch(`${url}/api/torrents`, { headers: { Cookie: cookie } })).status, 200);
  offline = true; now += 300001;
  assert.equal((await post(url, config, '/api/logout', cookie)).status, 200);
});

test('expired PIN, denied membership and pending PIN never produce sessions', async t => {
  let now = Date.now(); let pending = true;
  const { url, config } = await app(t, {}, fakePlex({ checkPin: async () => pending ? null : 'token', verifyAccess: async () => { throw new PlexDenied(); } }), () => now);
  const cookie = getCookie(await post(url, config, '/api/auth/plex/start'));
  assert.equal((await post(url, config, '/api/auth/plex/status', cookie)).status, 202);
  pending = false; now += 2001;
  const denied = await post(url, config, '/api/auth/plex/status', cookie);
  assert.equal(denied.status, 403); assert.equal(denied.headers.get('set-cookie'), null);
  const expired = getCookie(await post(url, config, '/api/auth/plex/start'));
  now += 300001;
  assert.equal((await post(url, config, '/api/auth/plex/status', expired)).status, 401);
});

test('projection strips secrets, handles unknown counts and unlimited ETA', () => {
  const projected = projectTorrent({ name: '<img src=x onerror=alert(1)>', hash: 'private-hash', save_path: '/private', magnet_uri: 'magnet:', tracker: 'https://tracker/passkey', state: 'downloading', progress: 3, num_complete: -1, num_seeds: 2, num_leechs: 0, num_incomplete: -1, eta: 8640000, dlspeed: -5 });
  assert.equal(projected.progress, 1);
  assert.equal(projected.seedsConnected, 2);
  assert.equal(projected.seedsTotal, null);
  assert.equal(projected.eta, null);
  assert.equal(projected.downloadSpeed, 0);
  assert.doesNotMatch(JSON.stringify(projected), /private-hash|\/private|passkey|magnet_uri/);
});

test('qBittorrent login, expiry recovery, category filtering and shared cache', async t => {
  const calls = [];
  let logins = 0;
  const fake = http.createServer(async (req, res) => {
    calls.push([req.method, req.url]);
    if (req.url === '/api/v2/auth/login') {
      let body = ''; for await (const chunk of req) body += chunk;
      assert.equal(new URLSearchParams(body).get('password'), base.QBIT_PASSWORD);
      logins++;
      res.setHeader('Set-Cookie', `SID=session${logins}; HttpOnly; Path=/`);
      return res.end('Ok.');
    }
    if (req.url === '/api/v2/torrents/info') {
      if (req.headers.cookie === 'SID=session1') { res.writeHead(403); return res.end(); }
      res.setHeader('Content-Type', 'application/json');
      return res.end(JSON.stringify([{ name: 'Allowed', category: 'radarr', num_seeds: 3 }, { name: 'Hidden', category: 'private' }]));
    }
    assert.fail('Unexpected upstream call');
  });
  const upstream = await start(fake, t);
  const config = loadConfig({ ...base, QBIT_URL: upstream, QBIT_CATEGORIES: '["radarr"]' });
  const qbit = createQbitClient(config);
  const [one, two] = await Promise.all([qbit.getSnapshot(), qbit.getSnapshot()]);
  assert.equal(one, two);
  assert.equal(one.torrents.length, 1);
  assert.equal(one.torrents[0].name, 'Allowed');
  await qbit.getSnapshot();
  assert.deepEqual(calls, [['POST', '/api/v2/auth/login'], ['GET', '/api/v2/torrents/info'], ['POST', '/api/v2/auth/login'], ['GET', '/api/v2/torrents/info']]);
});

test('upstream errors are sanitized and outages are cached briefly', async t => {
  let calls = 0;
  const upstream = await start(http.createServer((req, res) => { calls++; res.writeHead(500); res.end('SECRET password tracker /mnt/private'); }), t);
  const config = loadConfig({ ...base, QBIT_URL: upstream });
  const qbit = createQbitClient(config);
  const url = await start(createApp(config, qbit, fakePlex()), t);
  const response = await login(url, config);
  const cookie = response.headers.get('set-cookie').split(';')[0];
  for (let i = 0; i < 2; i++) {
    const result = await fetch(`${url}/api/torrents`, { headers: { Cookie: cookie } });
    assert.equal(result.status, 502);
    assert.doesNotMatch(await result.text(), /SECRET|tracker|\/mnt/);
  }
  assert.equal(calls, 1);
});

test('upstream redirects never receive credentials at another origin', async t => {
  let leaked = 0;
  const other = await start(http.createServer((req, res) => { leaked++; res.end('bad'); }), t);
  const upstream = await start(http.createServer((req, res) => { res.writeHead(307, { Location: other }); res.end(); }), t);
  const client = createQbitClient(loadConfig({ ...base, QBIT_URL: upstream }));
  await assert.rejects(client.getSnapshot());
  assert.equal(leaked, 0);
});
