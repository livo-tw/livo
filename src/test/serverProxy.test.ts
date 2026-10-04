// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import http from 'node:http';
import net from 'node:net';
import { createHash } from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { isAllowedApiPath, storageObjectHeaders } = require('../../server-proxy.cjs');
const appRoot = fileURLToPath(new URL('../../', import.meta.url));

describe('proxy path allow-list', () => {
  it.each(['auth', 'rest', 'storage', 'functions', 'realtime', 'graphql'])('allows only the versioned %s API prefix', (name) => {
    expect(isAllowedApiPath(`/${name}/v1/`)).toBe(true);
    expect(isAllowedApiPath(`/${name}/v1/example%20file?filter=a%2Fb`)).toBe(true);
  });
  it.each([
    '/', '/pg/meta', '/analytics/', '/studio/', '/auth/v1x', '/auth/v1',
    '/../rest/v1/', '//rest/v1/', '/REST/v1/', '/rest/v1/../../pg/meta',
    '/rest/v1/%2e%2e/pg/meta', '/rest/v1/%252e%252e/pg/meta',
    '/rest/v1/%2f..%2fpg/meta', '/rest/v1/..\\pg/meta', '/rest/v1/%zz',
    'http://example.com/rest/v1/', '/rest/v1/#fragment',
  ])('rejects %s without normalizing it into an allowed route', (target) => {
    expect(isAllowedApiPath(target)).toBe(false);
  });
});

type RunningServer = { child: ChildProcess; port: number; errors: () => string };
let fixture: string;
const children: RunningServer[] = [];
const sockets = new Set<net.Socket>();
let upstream: http.Server;
let proxy: RunningServer;
let staticServer: RunningServer;
let rootServer: RunningServer;
let upstreamCalls = 0;
let firstChunk: (() => void) | undefined;
let pendingStarted: (() => void) | undefined;
let pendingClosed: (() => void) | undefined;
let websocketHeaders: http.IncomingHttpHeaders;

async function startServer(name: string, upstreamOrigin?: string, appAtRoot = false): Promise<RunningServer> {
  const dir = path.join(fixture, name);
  mkdirSync(path.join(dir, 'deploy-local', 'demo'), { recursive: true });
  copyFileSync(path.join(appRoot, 'server.cjs'), path.join(dir, 'server.cjs'));
  if (upstreamOrigin) copyFileSync(path.join(appRoot, 'server-proxy.cjs'), path.join(dir, 'server-proxy.cjs'));
  writeFileSync(path.join(dir, 'deploy-local', 'index.html'), '<h1>Website</h1>');
  writeFileSync(path.join(dir, 'deploy-local', 'demo', 'index.html'), '<h1>App</h1>');
  writeFileSync(path.join(dir, 'deploy-local', 'demo', 'app.js'), 'window.example = true;');
  writeFileSync(path.join(dir, 'deploy-local', 'demo', 'favicon.ico'), 'example-icon');
  const child = spawn(process.execPath, [path.join(dir, 'server.cjs')], {
    env: { ...process.env, PORT: '0', LIVO_API_UPSTREAM: upstreamOrigin || '', LIVO_APP_AT_ROOT: appAtRoot ? '1' : '' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let errors = '';
  child.stderr!.on('data', (data) => { errors += data.toString(); });
  const running = { child, port: 0, errors: () => errors };
  children.push(running);
  running.port = await new Promise<number>((resolve, reject) => {
    let output = '';
    child.once('error', reject);
    child.once('exit', () => reject(new Error('Static server exited before listening')));
    child.stdout!.on('data', (data) => {
      output += data.toString();
      const match = /(?:Website|LIVO App):\s+http:\/\/localhost:(\d+)/.exec(output);
      if (match) resolve(Number(match[1]));
    });
  });
  return running;
}

function request(port: number, target: string, options: http.RequestOptions = {}, body?: string) {
  return new Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }>((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port, path: target, agent: false, ...options }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode!, headers: res.headers, body: Buffer.concat(chunks).toString() }));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.end(body);
  });
}

// A small masked client text frame; no additional WebSocket dependency needed.
function clientFrame(text: string) {
  const data = Buffer.from(text);
  const mask = Buffer.from([1, 2, 3, 4]);
  return Buffer.concat([Buffer.from([0x81, 0x80 | data.length]), mask, Buffer.from(data.map((value, i) => value ^ mask[i % 4]))]);
}

async function websocketRequest(port: number, target: string) {
  const socket = net.connect(port, '127.0.0.1');
  try {
    return await new Promise<{ status: number; text: string }>((resolve, reject) => {
      let received = Buffer.alloc(0);
      socket.setTimeout(5000, () => reject(new Error('WebSocket fixture timed out')));
      socket.on('error', reject);
      socket.on('data', (data) => {
        received = Buffer.concat([received, data]);
        const boundary = received.indexOf('\r\n\r\n');
        if (boundary < 0) return;
        const status = Number(received.toString('utf8', 0, boundary).split(' ')[1]);
        const body = received.subarray(boundary + 4);
        if (status !== 101) { resolve({ status, text: body.toString() }); return; }
        if (body.length >= 2 && body.length >= 2 + (body[1] & 127)) {
          resolve({ status, text: body.subarray(2, 2 + (body[1] & 127)).toString() });
        }
      });
      socket.once('connect', () => {
        const headers = [
          `GET ${target} HTTP/1.1`, 'Host: livo.example.com',
          'Connection: Upgrade, x-client-hop', 'Upgrade: websocket',
          'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==', 'Sec-WebSocket-Version: 13',
          'Authorization: Bearer example-token', 'apikey: example-key',
          'X-Forwarded-Proto: https', 'X-Client-Hop: remove-me', '', '',
        ].join('\r\n');
        // Coalesce the handshake and frame to exercise Node's upgrade `head`.
        socket.write(Buffer.concat([Buffer.from(headers), clientFrame('hello realtime')]));
      });
    });
  } finally { socket.destroy(); }
}

beforeAll(async () => {
  fixture = mkdtempSync(path.join(tmpdir(), 'livo-proxy-'));
  upstream = http.createServer((req, res) => {
    upstreamCalls++;
    if (req.url === '/functions/v1/pending') {
      res.once('close', () => pendingClosed?.());
      pendingStarted?.();
      return;
    }
    const chunks: Buffer[] = [];
    const hash = createHash('sha256');
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      hash.update(chunk);
      firstChunk?.();
      if (req.url !== '/storage/v1/stream') chunks.push(chunk);
    });
    req.on('end', () => {
      res.writeHead(200, {
        'content-type': 'application/json', 'set-cookie': ['one=1', 'two=2'],
        connection: 'keep-alive, x-upstream-hop', 'x-upstream-hop': 'remove-me',
        'x-response-example': 'preserved',
      });
      res.end(JSON.stringify({ method: req.method, url: req.url, headers: req.headers,
        body: Buffer.concat(chunks).toString(), size, sha256: hash.digest('hex') }));
    });
  });
  upstream.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  upstream.on('upgrade', (req, socket, head) => {
    upstreamCalls++;
    websocketHeaders = req.headers;
    const accept = createHash('sha1').update(req.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    let buffered = Buffer.alloc(0);
    const echo = (chunk: Buffer) => {
      buffered = Buffer.concat([buffered, chunk]);
      if (buffered.length < 6) return;
      const length = buffered[1] & 127;
      if (buffered.length < length + 6) return;
      const data = Buffer.from(buffered.subarray(6, length + 6));
      for (let i = 0; i < data.length; i++) data[i] ^= buffered[2 + i % 4];
      socket.write(Buffer.concat([Buffer.from([0x81, data.length]), data]));
      buffered = buffered.subarray(length + 6);
    };
    socket.on('error', () => {});
    socket.on('data', echo);
    if (head.length) echo(head);
  });
  upstream.listen(0, '127.0.0.1');
  await once(upstream, 'listening');
  const port = (upstream.address() as net.AddressInfo).port;
  proxy = await startServer('proxy', `http://127.0.0.1:${port}`);
  staticServer = await startServer('static');
  rootServer = await startServer('root', `http://127.0.0.1:${port}`, true);
}, 15000);

afterAll(async () => {
  for (const running of children) {
    if (running.child.exitCode === null) {
      const exited = once(running.child, 'exit');
      running.child.kill();
      await exited;
    }
  }
  for (const socket of sockets) socket.destroy();
  if (upstream?.listening) await new Promise<void>((resolve) => upstream.close(() => resolve()));
  if (fixture && path.resolve(fixture).startsWith(path.join(tmpdir(), 'livo-proxy-'))) rmSync(fixture, { recursive: true, force: true });
});

describe('stored objects served through the proxy', () => {
  const served = (url: string, type: string) => storageObjectHeaders(url, { 'content-type': type, etag: 'x' });
  it.each(['image/png', 'image/jpeg', 'image/webp', 'application/pdf', 'image/png; charset=binary'])('shows %s inline with nosniff', (type) => {
    expect(served('/storage/v1/object/public/task-images/a/b', type)).toEqual({ 'content-type': type, etag: 'x', 'x-content-type-options': 'nosniff' });
  });
  it.each(['text/html', 'image/svg+xml', 'application/xml', 'text/javascript', ''])('downloads %s in a sandbox, so an upload cannot run script as LIVO', (type) => {
    expect(served('/storage/v1/object/public/task-images/x/evil', type)).toMatchObject({
      'x-content-type-options': 'nosniff', 'content-security-policy': "default-src 'none'; sandbox", 'content-disposition': 'attachment' });
  });
  it('leaves other API responses unchanged', () => {
    expect(served('/rest/v1/tasks', 'text/html')).toEqual({ 'content-type': 'text/html', etag: 'x' });
    expect(served('/storage/v1/bucket', 'text/html')).toEqual({ 'content-type': 'text/html', etag: 'x' });
  });
});

describe('server.cjs proxy integration', () => {
  it.each(['GET', 'POST'])('streams %s with the original target and end-to-end headers', async (method) => {
    const target = '/rest/v1/tasks?name=eq.example%20task&select=id%2Cname';
    const result = await request(proxy.port, target, { method, headers: {
      host: 'livo.example.com:8443', authorization: 'Bearer example-token', apikey: 'example-key',
      'content-type': 'text/plain', connection: 'keep-alive, x-client-hop',
      'x-client-hop': 'remove-me', 'x-forwarded-proto': 'https', 'x-forwarded-for': '192.0.2.1',
    } }, method === 'POST' ? 'example body' : undefined);
    expect(result.status).toBe(200);
    const received = JSON.parse(result.body);
    expect(received).toMatchObject({ method, url: target, body: method === 'POST' ? 'example body' : '' });
    expect(received.headers).toMatchObject({ authorization: 'Bearer example-token', apikey: 'example-key',
      'content-type': 'text/plain', 'x-forwarded-proto': 'https', 'x-forwarded-host': 'livo.example.com:8443' });
    expect(received.headers['x-forwarded-for']).toMatch(/^192\.0\.2\.1, .*127\.0\.0\.1$/);
    expect(received.headers['x-client-hop']).toBeUndefined();
    expect(result.headers['x-upstream-hop']).toBeUndefined();
    expect(result.headers['x-response-example']).toBe('preserved');
    expect(result.headers['set-cookie']).toEqual(['one=1', 'two=2']);
  });

  it('uses http when no trusted front-proxy scheme is supplied', async () => {
    const result = await request(proxy.port, '/auth/v1/user');
    expect(JSON.parse(result.body).headers['x-forwarded-proto']).toBe('http');
  });

  it('delivers a 5 MiB upload intact and forwards the first chunk before the upload ends', async () => {
    const chunk = Buffer.alloc(64 * 1024, 'x');
    const expectedHash = createHash('sha256');
    const arrived = new Promise<void>((resolve) => { firstChunk = resolve; });
    let req: http.ClientRequest;
    const completed = new Promise<string>((resolve, reject) => {
      req = http.request({ hostname: '127.0.0.1', port: proxy.port, path: '/storage/v1/stream', method: 'POST',
        headers: { 'content-length': 5 * 1024 * 1024 }, agent: false }, (res) => {
        let body = '';
        res.on('data', (data) => { body += data.toString(); });
        res.on('end', () => resolve(body));
        res.on('error', reject);
      });
      req.on('error', reject);
    });
    try {
      req!.write(chunk);
      expectedHash.update(chunk);
      await arrived;
      for (let i = 1; i < 80; i++) {
        expectedHash.update(chunk);
        if (!req!.write(chunk)) await once(req!, 'drain');
      }
      req!.end();
      expect(JSON.parse(await completed)).toMatchObject({ size: 5 * 1024 * 1024, sha256: expectedHash.digest('hex') });
    } finally { firstChunk = undefined; req!.destroy(); }
  });

  it('returns 404 for blocked routes without reaching Kong', async () => {
    const before = upstreamCalls;
    for (const target of ['/pg/meta', '/analytics/', '/studio/', '/auth/v1x', '/../rest/v1/', '/rest/v1/../../server.cjs', '/demo/%zz']) {
      expect((await request(proxy.port, target)).status).toBe(404);
    }
    expect(upstreamCalls).toBe(before);
  });

  it('keeps static files and the app SPA working; unset upstream keeps the original website fallback', async () => {
    for (const running of [proxy, staticServer]) {
      expect((await request(running.port, '/')).body).toBe('<h1>Website</h1>');
      expect((await request(running.port, '/demo/tasks/example')).body).toBe('<h1>App</h1>');
      expect((await request(running.port, '/demo/app.js')).headers['content-type']).toBe('application/javascript');
    }
    expect((await request(staticServer.port, '/pricing')).body).toBe('<h1>Website</h1>');
  });

  it('serves the app icon at /favicon.ico, e.g. for an attachment image opened in its own tab', async () => {
    const before = upstreamCalls;
    for (const running of [proxy, staticServer]) {
      const icon = await request(running.port, '/favicon.ico');
      expect(icon.status).toBe(200);
      expect(icon.headers['content-type']).toBe('image/x-icon');
      expect(icon.body).toBe('example-icon');
    }
    expect(upstreamCalls).toBe(before);
    expect((await request(staticServer.port, '/rest/v1/tasks')).body).toBe('<h1>Website</h1>');
  });

  describe('Docker package: app at the site root', () => {
    const page = { headers: { accept: 'text/html,application/xhtml+xml' } };

    it('serves the app, its files and client-side routes at /', async () => {
      expect((await request(rootServer.port, '/')).body).toBe('<h1>App</h1>');
      expect((await request(rootServer.port, '/auth', page)).body).toBe('<h1>App</h1>');
      expect((await request(rootServer.port, '/set-password?token_hash=example', page)).body).toBe('<h1>App</h1>');
      const script = await request(rootServer.port, '/app.js');
      expect(script.headers['content-type']).toBe('application/javascript');
      expect(script.body).toBe('window.example = true;');
      expect((await request(rootServer.port, '/favicon.ico')).body).toBe('example-icon');
    });

    it('redirects old /demo/ links to the same page at the root', async () => {
      for (const [from, to] of [
        ['/demo', '/'], ['/demo/', '/'], ['/demo?task=ABC-1', '/?task=ABC-1'], ['/demo/?task=ABC-1', '/?task=ABC-1'],
        ['/demo/auth', '/auth'], ['/demo/set-password?token_hash=a%2Fb&type=recovery', '/set-password?token_hash=a%2Fb&type=recovery'],
        ['/demo//example.com', '/example.com'], ['/demo///example.com/x', '/example.com/x'],
      ]) {
        const result = await request(rootServer.port, from, page);
        expect(result.status, from).toBe(302);
        expect(result.headers.location, from).toBe(to);
      }
    });

    it('returns 404 for missing files, non-page requests, traversal and other Kong routes', async () => {
      const before = upstreamCalls;
      for (const target of ['/missing.js', '/pg/meta', '/analytics/', '/demox', '/demo/%5Cexample.com', '/demo/%zz', '/../server.cjs']) {
        expect((await request(rootServer.port, target)).status, target).toBe(404);
      }
      // Only the files under the app folder are served, never the server itself
      // or the old website next to it.
      expect((await request(rootServer.port, '/server.cjs')).status).toBe(404);
      expect((await request(rootServer.port, '/server.cjs', page)).body).toBe('<h1>App</h1>');
      expect((await request(rootServer.port, '/', page)).body).not.toContain('Website');
      expect((await request(rootServer.port, '/auth', { method: 'POST', ...page })).status).toBe(404);
      expect(upstreamCalls).toBe(before);
    });

    it('still proxies the API', async () => {
      const result = await request(rootServer.port, '/rest/v1/tasks?select=id');
      expect(result.status).toBe(200);
      expect(JSON.parse(result.body)).toMatchObject({ method: 'GET', url: '/rest/v1/tasks?select=id' });
    });
  });

  it('closes the upstream request when the client disconnects', async () => {
    const started = new Promise<void>((resolve) => { pendingStarted = resolve; });
    const closed = new Promise<void>((resolve) => { pendingClosed = resolve; });
    const req = http.get({ hostname: '127.0.0.1', port: proxy.port, path: '/functions/v1/pending', agent: false });
    req.on('error', () => {});
    await started;
    req.destroy();
    await closed;
    pendingStarted = pendingClosed = undefined;
  });

  it('echoes a real WebSocket message and forwards upgrade headers', async () => {
    expect(await websocketRequest(proxy.port, '/realtime/v1/websocket?apikey=example-key')).toEqual({ status: 101, text: 'hello realtime' });
    expect(websocketHeaders).toMatchObject({ authorization: 'Bearer example-token', apikey: 'example-key',
      'x-forwarded-proto': 'https', 'x-forwarded-host': 'livo.example.com', upgrade: 'websocket' });
    expect(websocketHeaders['x-client-hop']).toBeUndefined();
  });

  it('rejects upgrades outside Realtime without reaching Kong', async () => {
    const before = upstreamCalls;
    expect((await websocketRequest(proxy.port, '/pg/meta')).status).toBe(404);
    expect((await websocketRequest(proxy.port, '/rest/v1/tasks')).status).toBe(404);
    expect(upstreamCalls).toBe(before);
  });

  it('returns JSON 502 for HTTP and WebSocket when the upstream is down; logs no credentials', async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
    const result = await request(proxy.port, '/auth/v1/user', { headers: { authorization: 'Bearer example-token' } });
    expect(result.status).toBe(502);
    expect(result.headers['content-type']).toBe('application/json');
    expect(JSON.parse(result.body)).toEqual({ error: 'Bad gateway' });
    const upgrade = await websocketRequest(proxy.port, '/realtime/v1/websocket');
    expect(upgrade.status).toBe(502);
    expect(JSON.parse(upgrade.text)).toEqual({ error: 'Bad gateway' });
    // The child's stderr reaches this process asynchronously, possibly after
    // the 502 responses: wait for both log lines before checking them.
    for (const deadline = Date.now() + 2000; proxy.errors().trim().split('\n').filter(Boolean).length < 2 && Date.now() < deadline;) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(proxy.errors()).not.toMatch(/example-token|example-key|authorization|apikey/i);
    expect(proxy.errors().trim().split('\n')).toHaveLength(2);
  });
});
