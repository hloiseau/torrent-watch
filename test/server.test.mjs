import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createApp, createQbitClient, loadConfig, projectTorrent } from '../server.mjs';

const base = {
  VIEWER_PASSWORD: 'test-only-password-long-enough', QBIT_URL: 'http://127.0.0.1:8080',
  QBIT_USERNAME: 'admin', QBIT_PASSWORD: 'upstream-test-secret', PUBLIC_ORIGIN: 'http://localhost:5080', COOKIE_SECURE: 'false',
};
async function start(server, t) {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  return `http://127.0.0.1:${server.address().port}`;
}
async function app(t, options = {}) {
  const config = loadConfig({ ...base, ...options });
  const server = createApp(config, { getSnapshot: async () => ({ updatedAt: '2026-10-10T10:00:00Z', torrents: [{ name: 'Ubuntu' }] }) });
  const url = await start(server, t);
  return { url, config };
}
async function login(url, config, overrides = {}) {
  return fetch(`${url}/api/login`, {
    method: 'POST', headers: { Origin: config.origin, 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'ami', password: base.VIEWER_PASSWORD, ...overrides }),
  });
}

test('configuration fails closed and filters must be explicit JSON', () => {
  for (const overrides of [{ VIEWER_PASSWORD: '' }, { VIEWER_PASSWORD: 'short' }, { QBIT_PASSWORD: '' }, { PUBLIC_ORIGIN: '' }, { PUBLIC_ORIGIN: 'https://example.com/path' }, { QBIT_URL: 'file:///etc/passwd' }, { QBIT_URL: 'http://admin:secret@host' }, { QBIT_CATEGORIES: 'sonarr' }, { QBIT_CATEGORIES: '[]' }, { COOKIE_SECURE: 'true' }]) {
    assert.throws(() => loadConfig({ ...base, ...overrides }));
  }
  assert.deepEqual(loadConfig({ ...base, QBIT_CATEGORIES: '["sonarr",""]' }).categories, ['sonarr', '']);
});

test('anonymous clients cannot read torrents; static shell has no private data', async t => {
  const { url } = await app(t);
  assert.equal((await fetch(`${url}/api/torrents`)).status, 401);
  assert.equal((await fetch(`${url}/api/session`)).status, 401);
  const shell = await fetch(url);
  assert.equal(shell.status, 200);
  assert.match(shell.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  assert.equal(shell.headers.get('cache-control'), 'no-store');
  assert.doesNotMatch(await shell.text(), /upstream-test-secret|test-only-password/);
});

test('login, read-only routes, logout and invalidated session', async t => {
  const { url, config } = await app(t);
  assert.equal((await login(url, config, { password: 'wrong' })).status, 401);
  const response = await login(url, config);
  assert.equal(response.status, 200);
  const cookie = response.headers.get('set-cookie').split(';')[0];
  assert.match(response.headers.get('set-cookie'), /HttpOnly; SameSite=Strict/);
  const snapshot = await fetch(`${url}/api/torrents`, { headers: { Cookie: cookie } });
  assert.equal(snapshot.status, 200);
  assert.equal((await snapshot.json()).torrents[0].name, 'Ubuntu');
  for (const path of ['/api/torrents', '/api/v2/torrents/delete', '/api/proxy', '/api/settings']) {
    assert.equal((await fetch(`${url}${path}`, { method: 'POST', headers: { Cookie: cookie, Origin: config.origin } })).status, 404);
  }
  assert.equal((await fetch(`${url}/api/logout`, { method: 'POST', headers: { Cookie: cookie, Origin: config.origin } })).status, 200);
  assert.equal((await fetch(`${url}/api/torrents`, { headers: { Cookie: cookie } })).status, 401);
});

test('HTTPS sessions are secure and host-scoped', async t => {
  const { url, config } = await app(t, { PUBLIC_ORIGIN: 'https://suivi.example.com', COOKIE_SECURE: 'true' });
  const response = await login(url, config);
  assert.equal(response.status, 200);
  assert.match(response.headers.get('set-cookie'), /^__Host-tw_session=.+; Secure$/);
});

test('cross-origin, missing Origin and oversized login requests are rejected', async t => {
  const { url, config } = await app(t);
  for (const origin of [undefined, 'https://evil.example']) {
    assert.equal((await fetch(`${url}/api/login`, { method: 'POST', headers: origin ? { Origin: origin } : {} })).status, 403);
  }
  assert.equal((await fetch(`${url}/api/torrents`, { headers: { Origin: 'https://evil.example' } })).status, 403);
  const huge = await fetch(`${url}/api/login`, { method: 'POST', headers: { Origin: config.origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ password: 'a'.repeat(5000) }) });
  assert.equal(huge.status, 400);
});

test('brute-force protection ignores spoofed forwarded addresses', async t => {
  const { url, config } = await app(t);
  for (let i = 0; i < 10; i++) assert.equal((await login(url, config, { password: 'wrong' })).status, 401);
  const blocked = await fetch(`${url}/api/login`, { method: 'POST', headers: { Origin: config.origin, 'Content-Type': 'application/json', 'X-Forwarded-For': '203.0.113.123' }, body: JSON.stringify({ username: 'ami', password: base.VIEWER_PASSWORD }) });
  assert.equal(blocked.status, 429);
  assert.equal(blocked.headers.get('retry-after'), '900');
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
  const url = await start(createApp(config, qbit), t);
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
