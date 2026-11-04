// Docker's single public entry point. Node built-ins only (node:20-alpine).
const http = require('node:http');
const https = require('node:https');
const net = require('node:net');
const tls = require('node:tls');
const { randomBytes, createCipheriv, createDecipheriv } = require('node:crypto');

const API_PREFIXES = [
  '/auth/v1/', '/rest/v1/', '/storage/v1/',
  '/functions/v1/', '/realtime/v1/', '/graphql/v1/',
];
const HOP_BY_HOP = [
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
  'proxy-connection', 'te', 'trailer', 'transfer-encoding', 'upgrade',
];

/** Check the raw request target before any URL normalization can hide traversal. */
function isAllowedApiPath(target) {
  if (typeof target !== 'string') return false;
  const pathname = target.split('?')[0];
  if (!API_PREFIXES.some((prefix) => pathname.startsWith(prefix))) return false;
  if (/[\\#\x00-\x20\x7f]/.test(pathname)) return false;
  // Reject encoded separators and nested encodings of traversal characters.
  if (/%(?:2f|5c|25(?:25)*(?:2e|2f|5c))/i.test(pathname)) return false;
  try {
    return !decodeURIComponent(pathname).split('/').some((part) => part === '.' || part === '..');
  } catch {
    return false;
  }
}

// API data and redirects must not become a browser/CDN redirect cache.
// Keep upstream status, Location and cookies intact: GoTrue OAuth uses redirects.
// Storage objects retain their own download/cache/range policy.
function apiResponseHeaders(url, headers) {
  return /^\/(?:auth|rest|functions|graphql)\/v1\//.test(url)
    ? { ...headers, 'cache-control': 'no-store' }
    : headers;
}

// Stored objects keep whatever content-type the uploader sent, and the proxy
// serves them from the app's own origin. Raster images and PDFs display inline;
// anything else (HTML, SVG, XML…) downloads inside a sandbox, so an uploaded file
// can never run script as LIVO. Same rule as the cloud Worker (worker/src/storage.ts).
const INLINE_SAFE_TYPE = /^(image\/(png|jpe?g|gif|webp|avif|bmp|x-icon|vnd\.microsoft\.icon)|application\/pdf)\s*(;|$)/i;
function storageObjectHeaders(url, headers) {
  if (!url.startsWith('/storage/v1/object/')) return headers;
  const out = { ...headers, 'x-content-type-options': 'nosniff' };
  if (!INLINE_SAFE_TYPE.test(String(headers['content-type'] || ''))) {
    out['content-security-policy'] = "default-src 'none'; sandbox";
    out['content-disposition'] = 'attachment';
  }
  return out;
}

function endToEndHeaders(headers) {
  const blocked = new Set(HOP_BY_HOP);
  for (const name of (headers.connection || '').split(',')) blocked.add(name.trim().toLowerCase());
  return Object.fromEntries(Object.entries(headers).filter(([name]) => !blocked.has(name.toLowerCase())));
}

function forwardedHeaders(req) {
  const headers = endToEndHeaders(req.headers);
  const previous = req.headers['x-forwarded-for'];
  headers['x-forwarded-for'] = [previous, req.socket.remoteAddress].filter(Boolean).join(', ');
  // The front proxy must overwrite forwarded headers (cloudflared does so for
  // X-Forwarded-Proto). Accept only a scheme, never arbitrary header contents.
  const proto = (req.headers['x-forwarded-proto'] || '').split(',')[0].trim().toLowerCase();
  headers['x-forwarded-proto'] = /^(http|https)$/.test(proto) ? proto : (req.socket.encrypted ? 'https' : 'http');
  headers['x-forwarded-host'] = req.headers.host || '';
  return headers;
}

const BAD_GATEWAY = JSON.stringify({ error: 'Bad gateway' });
const LEGACY_TASK_IMAGES = '/storage/v1/object/public/task-images/';
const AUTH_TASK_IMAGES = '/storage/v1/object/authenticated/task-images/';
const TASK_IMAGE_SESSION = '/storage/v1/livo-task-image-session';
const TASK_IMAGE_COOKIE = 'livo_task_image_session';
const TASK_IMAGE_TTL = 5 * 60 * 1000;
const TASK_IMAGE_MAX_BEARER_LENGTH = 2700;

function taskImageCookie(req) {
  const entry = String(req.headers.cookie || '').split(';')
    .map(part => part.trim()).find(part => part.startsWith(TASK_IMAGE_COOKIE + '='));
  return entry?.slice(TASK_IMAGE_COOKIE.length + 1) || '';
}

function assetCookieHeader(headers, value, seconds) {
  const security = headers['x-forwarded-proto'] === 'https' ? '; Secure' : '';
  return `${TASK_IMAGE_COOKIE}=${value}; Path=/storage/v1/; Max-Age=${seconds}; HttpOnly; SameSite=Strict${security}`;
}

function sameOriginBrowserRequest(req, headers) {
  if (req.headers['sec-fetch-site'] === 'same-origin') return true;
  try {
    const origin = new URL(req.headers.origin);
    return origin.host === req.headers.host && origin.protocol === headers['x-forwarded-proto'] + ':';
  } catch {
    return false;
  }
}

function logError(kind, error) {
  const code = /^[A-Z0-9_]+$/.test(error?.code || '') ? error.code : 'UPSTREAM_ERROR';
  console.error(`[api-proxy] ${kind} ${code}`);
}

function createApiProxy(rawUpstream) {
  let upstream;
  try { upstream = new URL(rawUpstream); } catch { /* handled below */ }
  if (!upstream || !['http:', 'https:'].includes(upstream.protocol) ||
      upstream.username || upstream.password || upstream.pathname !== '/' || upstream.search || upstream.hash) {
    throw new Error('LIVO_API_UPSTREAM must be an http(s) origin without credentials or a path');
  }
  const secure = upstream.protocol === 'https:';
  const hostname = upstream.hostname.replace(/^\[|\]$/g, '');
  const port = Number(upstream.port) || (secure ? 443 : 80);
  // Only this proxy process can decrypt the cookie. It cannot authorize
  // general API requests and expires after five minutes.
  // Storage checks live internal membership for every legacy object read.
  const taskImageKey = randomBytes(32);
  function encodeAssetSession(bearer) {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', taskImageKey, iv);
    const expires = Date.now() + TASK_IMAGE_TTL;
    const encrypted = Buffer.concat([cipher.update(`${expires} ${bearer}`, 'utf8'), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString('base64url');
  }
  function decodeAssetSession(ticket) {
    if (!/^[A-Za-z0-9_-]{48,3800}$/.test(ticket)) return null;
    try {
      const bytes = Buffer.from(ticket, 'base64url');
      const decipher = createDecipheriv('aes-256-gcm', taskImageKey, bytes.subarray(0, 12));
      decipher.setAuthTag(bytes.subarray(12, 28));
      const decoded = Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString('utf8');
      const separator = decoded.indexOf(' ');
      return Number(decoded.slice(0, separator)) > Date.now() ? decoded.slice(separator + 1) : null;
    } catch {
      return null;
    }
  }

  function assetSessionReply(req, res, headers) {
    if (req.method !== 'POST' || !sameOriginBrowserRequest(req, headers)) {
      res.writeHead(403, { 'Cache-Control': 'no-store' });
      res.end();
      return;
    }
    const bearer = String(headers.authorization || '');
    const ticket = bearer.length <= TASK_IMAGE_MAX_BEARER_LENGTH && /^Bearer [A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(bearer)
      ? encodeAssetSession(bearer) : '';
    res.writeHead(204, {
      'Cache-Control': 'no-store',
      'Set-Cookie': assetCookieHeader(headers, ticket, ticket ? TASK_IMAGE_TTL / 1000 : 0),
    });
    res.end();
  }

  function proxyHttp(req, res) {
    const headers = forwardedHeaders(req);
    if (req.url === TASK_IMAGE_SESSION) return assetSessionReply(req, res, headers);
    let path = req.url;
    const isLegacyTaskImage = path.startsWith(LEGACY_TASK_IMAGES) &&
      (req.method === 'GET' || req.method === 'HEAD');
    if (isLegacyTaskImage) {
      const bearer = decodeAssetSession(taskImageCookie(req));
      if (!bearer) {
        res.writeHead(404, { 'Cache-Control': 'private, no-store' });
        res.end();
        return;
      }
      path = AUTH_TASK_IMAGES + path.slice(LEGACY_TASK_IMAGES.length);
      headers.authorization = bearer;
    }
    // The cookie is scoped to the proxy and never forwarded to upstream Storage.
    if (path.startsWith('/storage/v1/')) delete headers.cookie;
    let response;
    let failed = false;
    const request = (secure ? https : http).request({
      hostname, port, method: req.method, path,
      headers, agent: false,
    });
    const stop = () => { request.destroy(); response?.destroy(); };
    const fail = (error) => {
      if (failed || res.destroyed) return;
      failed = true;
      logError('http', error);
      if (res.headersSent) res.destroy();
      else {
        res.writeHead(502, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        res.end(BAD_GATEWAY);
      }
      stop();
    };
    // No upload/response deadline: pipe supplies backpressure for large files.
    req.setTimeout(0);
    request.setTimeout(0);
    req.on('aborted', stop);
    req.on('error', stop);
    res.on('close', stop);
    request.on('error', fail);
    request.on('response', (incoming) => {
      response = incoming;
      incoming.on('error', fail);
      const out = apiResponseHeaders(req.url, storageObjectHeaders(req.url, endToEndHeaders(incoming.headers)));
      if (isLegacyTaskImage || path.startsWith(AUTH_TASK_IMAGES)) out['cache-control'] = 'private, no-store';
      if (req.method === 'POST' && req.url.split('?')[0] === '/auth/v1/logout') {
        out['set-cookie'] = [...(out['set-cookie'] || []), assetCookieHeader(headers, '', 0)];
      }
      res.writeHead(incoming.statusCode, out);
      incoming.pipe(res);
    });
    req.pipe(request);
  }

  function proxyUpgrade(req, socket, head) {
    if (!isAllowedApiPath(req.url) || !req.url.startsWith('/realtime/v1/') ||
        req.method !== 'GET' || req.headers.upgrade?.toLowerCase() !== 'websocket') {
      socket.end('HTTP/1.1 404 Not Found\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
      return;
    }
    socket.pause();
    socket.setTimeout(0);
    const remote = secure ? tls.connect({ host: hostname, port, servername: hostname }) : net.connect({ host: hostname, port });
    let responded = false;
    let failed = false;
    remote.on('data', () => { responded = true; });
    remote.on('error', (error) => {
      if (failed || socket.destroyed) return;
      failed = true;
      logError('websocket', error);
      if (responded) socket.destroy();
      else socket.end(`HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\nContent-Type: application/json\r\nCache-Control: no-store\r\nContent-Length: ${Buffer.byteLength(BAD_GATEWAY)}\r\n\r\n${BAD_GATEWAY}`);
    });
    socket.on('error', () => remote.destroy());
    socket.on('close', () => remote.destroy());
    remote.on('close', () => { if (!socket.destroyed) socket.end(); });
    remote.once(secure ? 'secureConnect' : 'connect', () => {
      const headers = { ...forwardedHeaders(req), connection: 'Upgrade', upgrade: 'websocket' };
      const lines = [`${req.method} ${req.url} HTTP/${req.httpVersion}`];
      for (const [name, value] of Object.entries(headers)) {
        for (const item of Array.isArray(value) ? value : [value]) lines.push(`${name}: ${item}`);
      }
      remote.write(lines.join('\r\n') + '\r\n\r\n');
      if (head.length) remote.write(head);
      socket.pipe(remote).pipe(socket);
    });
  }

  return { proxyHttp, proxyUpgrade };
}

module.exports = { isAllowedApiPath, createApiProxy, storageObjectHeaders };
