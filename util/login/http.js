// SPDX-License-Identifier: GPL-3.0-only
// A deliberately separate client: login needs response headers and must never
// share a cookie jar with another account or the legacy business API client.
const ALLOWED_HOSTS = new Set([
  'ssl.ptlogin2.qq.com',
  'ssl.ptlogin2.graph.qq.com',
  'graph.qq.com',
  'y.qq.com',
  'u.y.qq.com',
  'open.weixin.qq.com',
  'lp.open.weixin.qq.com',
]);

class LoginError extends Error {
  constructor(kind = 'protocol') {
    super(`QQ login ${kind}`);
    this.kind = kind;
  }
}

function allowedUrl(value) {
  let url;
  try { url = new URL(value); } catch { throw new LoginError(); }
  if (url.protocol !== 'https:' || !ALLOWED_HOSTS.has(url.hostname) ||
      url.username || url.password || (url.port && url.port !== '443')) {
    throw new LoginError();
  }
  return url;
}

class CookieJar {
  constructor() { this.cookies = new Map(); }

  absorb(url, headers) {
    const source = allowedUrl(url);
    // Node 22 Headers.getSetCookie preserves separate Set-Cookie values.
    for (const line of headers.getSetCookie()) {
      const [pair, ...attributes] = line.split(';');
      const match = /^\s*([!#$%&'*+.^_`|~\w-]+)=([^\r\n;]*)$/.exec(pair);
      if (!match) continue;
      const attrs = Object.create(null);
      for (const attr of attributes) {
        const split = attr.indexOf('=');
        attrs[(split < 0 ? attr : attr.slice(0, split)).trim().toLowerCase()] =
          split < 0 ? true : attr.slice(split + 1).trim();
      }
      const domain = attrs.domain ? String(attrs.domain).replace(/^\./, '').toLowerCase() : source.hostname;
      // qq.com is the only supported registrable parent, never a public suffix.
      if (!(domain === 'qq.com' || domain.endsWith('.qq.com')) ||
          !(source.hostname === domain || source.hostname.endsWith(`.${domain}`))) continue;
      const defaultPath = source.pathname.slice(0, source.pathname.lastIndexOf('/') + 1) || '/';
      const path = typeof attrs.path === 'string' && attrs.path.startsWith('/') ? attrs.path : defaultPath;
      const key = `${domain}\n${path}\n${match[1]}`;
      let expiresAt = Infinity;
      if (typeof attrs.expires === 'string') {
        const parsed = Date.parse(attrs.expires);
        if (!Number.isNaN(parsed)) expiresAt = parsed;
      }
      if (typeof attrs['max-age'] === 'string' && /^-?\d+$/.test(attrs['max-age'])) {
        expiresAt = Date.now() + Number(attrs['max-age']) * 1000;
      }
      if (expiresAt <= Date.now()) this.cookies.delete(key);
      else this.cookies.set(key, {
        name: match[1], value: match[2], domain, path,
        hostOnly: !attrs.domain, expiresAt,
      });
    }
  }

  entries(url) {
    const target = allowedUrl(url);
    return [...this.cookies.values()].filter(c => c.expiresAt > Date.now() &&
      (c.hostOnly ? target.hostname === c.domain :
        target.hostname === c.domain || target.hostname.endsWith(`.${c.domain}`)) &&
      (target.pathname === c.path || target.pathname.startsWith(c.path.endsWith('/') ? c.path : `${c.path}/`)))
      .sort((a, b) => b.path.length - a.path.length);
  }

  header(url) { return this.entries(url).map(c => `${c.name}=${c.value}`).join('; '); }
  get(url, name) { return this.entries(url).find(c => c.name === name)?.value; }
  clear() { this.cookies.clear(); }
}

class LoginHttpClient {
  constructor({fetchImpl = globalThis.fetch, timeoutMs = 10000} = {}) {
    this.fetchImpl = fetchImpl;
    this.timeoutMs = timeoutMs;
  }

  async request(value, {jar, signal, method = 'GET', body, headers = {}, cookie, timeoutMs = this.timeoutMs} = {}) {
    const url = allowedUrl(value);
    const combined = signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) :
      AbortSignal.timeout(timeoutMs);
    try {
      const cookieHeader = cookie === undefined ? jar?.header(url) : cookie;
      const response = await this.fetchImpl(url.toString(), {
        method, body, redirect: 'manual', signal: combined,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
          Referer: 'https://y.qq.com/',
          ...headers,
          ...(cookieHeader ? {Cookie: cookieHeader} : {}),
        },
      });
      if (response.status < 200 || response.status >= 400) throw new LoginError('network');
      // Consume the body within the same timeout and cap upstream response size.
      const chunks = [];
      let size = 0;
      if (response.body) {
        for await (const chunk of response.body) {
          size += chunk.length;
          if (size > 1024 * 1024) throw new LoginError();
          chunks.push(Buffer.from(chunk));
        }
      }
      jar?.absorb(url, response.headers);
      return {status: response.status, headers: response.headers, body: Buffer.concat(chunks)};
    } catch (err) {
      if (err instanceof LoginError) throw err;
      // Never retain an upstream URL, body, token, or nested fetch error.
      throw new LoginError(signal?.aborted ? 'cancelled' : combined.aborted ? 'timeout' : 'network');
    }
  }
}

module.exports = {LoginError, LoginHttpClient, CookieJar, allowedUrl};
