// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import http from 'node:http';

let dir: string, child: ChildProcess, port: number;
const get = (target: string, headers: Record<string, string> = {}, method = 'GET', targetPort = port) => new Promise<{ status: number; location?: string; cacheControl?: string; body: string }>((resolve, reject) => {
  const request = http.request({ host: '127.0.0.1', port: targetPort, path: target, method, headers }, response => {
    let body = ''; response.on('data', value => body += value); response.on('end', () => resolve({ status: response.statusCode || 0, location: response.headers.location, cacheControl: response.headers['cache-control'], body }));
  }); request.on('error', reject); request.end();
});
beforeAll(async () => {
  dir = mkdtempSync(path.join(tmpdir(), 'livo-canonical-'));
  mkdirSync(path.join(dir, 'deploy-local', 'demo'), { recursive: true });
  writeFileSync(path.join(dir, 'deploy-local', 'demo', 'index.html'), '<h1>Example app</h1>');
  copyFileSync(path.resolve('server.cjs'), path.join(dir, 'server.cjs'));
  child = spawn(process.execPath, [path.join(dir, 'server.cjs')], { env: { ...process.env, PORT: '0', LIVO_APP_AT_ROOT: '1', LIVO_API_UPSTREAM: '', APP_BASE_URL: 'https://example.com/' }, stdio: ['ignore', 'pipe', 'pipe'] });
  port = await new Promise<number>((resolve, reject) => {
    let text = ''; child.stdout!.on('data', chunk => { text += chunk; const match = /(?:localhost|127\.0\.0\.1):(\d+)/.exec(text); if (match) resolve(Number(match[1])); });
    child.on('error', reject); child.on('exit', code => reject(new Error(`Example server exited ${code}`)));
  });
});
afterAll(async () => {
  if (child && child.exitCode === null) { child.kill(); await new Promise<void>(resolve => child.once('exit', () => resolve())); }
  const resolved = path.resolve(dir); if (resolved.startsWith(path.resolve(tmpdir()) + path.sep) && path.basename(resolved).startsWith('livo-canonical-')) rmSync(resolved, { recursive: true, force: true });
});
describe('customer canonical entry', () => {
  it('preserves historical task and QA deep links on the configured HTTPS origin', async () => {
    expect(await get('/?task=EXAMPLE-1', { Accept: 'text/html' })).toMatchObject({ status: 302, location: 'https://example.com/?task=EXAMPLE-1', cacheControl: 'no-store' });
    expect(await get('/?qa=example-bug', { Accept: 'text/html' })).toMatchObject({ status: 302, location: 'https://example.com/?qa=example-bug', cacheControl: 'no-store' });
  });
  it('normalizes old app paths and cannot redirect to a URL supplied in the path', async () => {
    expect(await get('/demo/?task=EXAMPLE-1', { Accept: 'text/html' })).toMatchObject({ location: 'https://example.com/?task=EXAMPLE-1' });
    expect(await get('/demo//other.example.com/path', { Accept: 'text/html' })).toMatchObject({ location: 'https://example.com/other.example.com/path' });
  });
  it('rejects malformed or forbidden paths before redirecting and keeps serving requests', async () => {
    for (const target of ['http://[', '//[', '/%ZZ', '/%00', '/demo/%2e%2e/data']) {
      expect(await get(target, { Accept: 'text/html' })).toMatchObject({ status: 404 });
    }
    expect(await get('/?task=EXAMPLE-1', { Accept: 'text/html', Host: 'example.com' })).toMatchObject({ status: 200 });
    expect(await get('/folder%20name/?task=EXAMPLE-1', { Accept: 'text/html' })).toMatchObject({ status: 302, location: 'https://example.com/folder%20name/?task=EXAMPLE-1' });
  });
  it('does not loop when the reverse proxy sends the canonical host', async () => {
    expect(await get('/?task=EXAMPLE-1', { Accept: 'text/html', Host: 'example.com' })).toMatchObject({ status: 200, body: '<h1>Example app</h1>' });
  });
  it('leaves API, health probes, assets and non-navigation writes on their original origin', async () => {
    for (const target of ['/rest/v1/tasks', '/auth/v1/token', '/functions/v1/qa', '/graphql/v1/', '/health', '/healthz', '/ready']) expect((await get(target, { Accept: 'text/html' })).location).toBeUndefined();
    expect((await get('/', { Accept: '*/*' })).location).toBeUndefined();
    expect((await get('/', { Accept: 'text/html' }, 'POST')).location).toBeUndefined();
    expect((await get('/missing.js', { Accept: '*/*' })).location).toBeUndefined();
  });
});

it('keeps the standalone static server within its asset directory and survives invalid paths', async () => {
  writeFileSync(path.join(dir, 'deploy-local', 'index.html'), '<h1>Example website</h1>');
  const outside = path.join(dir, 'fixture-outside');
  mkdirSync(outside);
  writeFileSync(path.join(outside, 'sample.txt'), 'example outside content');
  if (process.platform !== 'win32') symlinkSync(outside, path.join(dir, 'deploy-local', 'linked'), 'dir');
  const standalone = spawn(process.execPath, [path.join(dir, 'server.cjs')], {
    env: { ...process.env, PORT: '0', LIVO_APP_AT_ROOT: '', LIVO_API_UPSTREAM: '', APP_BASE_URL: '' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  try {
    const standalonePort = await new Promise<number>((resolve, reject) => {
      let output = '';
      standalone.stdout.on('data', chunk => {
        output += chunk;
        const match = /localhost:(\d+)/.exec(output);
        if (match) resolve(Number(match[1]));
      });
      standalone.on('error', reject);
      standalone.on('exit', code => reject(new Error(`Example standalone server exited ${code}`)));
    });
    const request = (target: string) => get(target, {}, 'GET', standalonePort);
    for (const target of ['/%2e%2e/fixture-outside/sample.txt', '/%ZZ', '/%00']) {
      expect(await request(target)).toMatchObject({ status: 404, body: 'Not found' });
    }
    if (process.platform !== 'win32') expect((await request('/linked/sample.txt')).body).not.toContain('example outside content');
    expect(await request('/')).toMatchObject({ status: 200, body: '<h1>Example website</h1>' });
    expect(await request('/demo/auth')).toMatchObject({ status: 200, body: '<h1>Example app</h1>' });
  } finally {
    if (standalone.exitCode === null && standalone.signalCode === null) {
      await new Promise<void>(resolve => { standalone.once('exit', () => resolve()); standalone.kill(); });
    }
  }
});
