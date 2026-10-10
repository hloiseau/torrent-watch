import { randomUUID } from 'node:crypto';

export class PlexDenied extends Error {}
export class PlexUnavailable extends Error {}

// Only fixed Plex endpoints; no upstream URL, token or PIN supplied by a visitor.
export function createPlexClient(config, fetcher = fetch) {
  async function request(path, clientId, token, method = 'GET') {
    const response = await fetcher(`https://plex.tv/api/v2/${path}`, {
      method, redirect: 'error', signal: AbortSignal.timeout(8000),
      headers: { Accept: 'application/json', 'X-Plex-Product': 'Torrent Watch',
        'X-Plex-Version': '0.2.4', 'X-Plex-Client-Identifier': clientId,
        ...(token ? { 'X-Plex-Token': token } : {}) },
    });
    if (!response.ok) {
      await response.body?.cancel();
      if ([401, 403, 404].includes(response.status)) throw new PlexDenied();
      throw new PlexUnavailable();
    }
    const chunks = []; let size = 0;
    for await (const chunk of response.body) {
      size += chunk.length;
      if (size > 2 * 1024 * 1024) throw new PlexUnavailable();
      chunks.push(Buffer.from(chunk));
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  }
  return {
    async createPin() {
      const clientId = `torrent-watch-${randomUUID()}`;
      const pin = await request('pins?strong=true', clientId, null, 'POST');
      if (!Number.isSafeInteger(pin.id) || pin.id <= 0 || typeof pin.code !== 'string' || !/^[A-Za-z0-9_-]{8,256}$/.test(pin.code)) throw new PlexUnavailable();
      const ttl = Math.min(300000, typeof pin.expiresIn === 'number' ? pin.expiresIn * 1000 : 300000);
      if (ttl <= 0) throw new PlexDenied();
      return { id: pin.id, code: pin.code, clientId, expires: Date.now() + ttl };
    },
    async checkPin(pin) {
      const result = await request(`pins/${pin.id}?code=${encodeURIComponent(pin.code)}`, pin.clientId);
      if (result.id !== pin.id || result.code !== pin.code) throw new PlexDenied();
      if (!result.authToken) return null;
      if (typeof result.authToken !== 'string' || result.authToken.length > 8192) throw new PlexUnavailable();
      return result.authToken;
    },
    async verifyAccess(token, clientId) {
      const user = await request('user', clientId, token);
      if (!user.id || user.restricted === true) throw new PlexDenied();
      const resources = await request('resources?includeHttps=1&includeRelay=1', clientId, token);
      if (!Array.isArray(resources)) throw new PlexUnavailable();
      const allowed = resources.some(r => r.clientIdentifier === config.plexServerId &&
        typeof r.provides === 'string' && r.provides.split(',').includes('server') &&
        (r.owned === true || (typeof r.accessToken === 'string' && r.accessToken.length > 0)));
      if (!allowed) throw new PlexDenied();
      return { name: String(user.username || user.title || 'Utilisateur Plex').slice(0, 100) };
    },
  };
}
