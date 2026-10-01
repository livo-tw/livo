// Docker's single public entry point. Node built-ins only (node:20-alpine).
const http = require('node:http');
const https = require('node:https');
const net = require('node:net');
const tls = require('node:tls');

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

  function proxyHttp(req, res) {
    let response;
    let failed = false;
    const request = (secure ? https : http).request({
      hostname, port, method: req.method, path: req.url,
      headers: forwardedHeaders(req), agent: false,
    });
    const stop = () => { request.destroy(); response?.destroy(); };
    const fail = (error) => {
      if (failed || res.destroyed) return;
      failed = true;
      logError('http', error);
      if (res.headersSent) res.destroy();
      else {
        res.writeHead(502, { 'Content-Type': 'application/json' });
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
      res.writeHead(incoming.statusCode, endToEndHeaders(incoming.headers));
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
      else socket.end(`HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(BAD_GATEWAY)}\r\n\r\n${BAD_GATEWAY}`);
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

module.exports = { isAllowedApiPath, createApiProxy };
