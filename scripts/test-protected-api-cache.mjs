#!/usr/bin/env node
/**
 * Real Chromium HTTP-cache regression against loopback-only synthetic origins.
 * Run from a non-Git verification copy with TypeScript, Playwright and its pinned
 * Chromium installed. No request routing/interception: Playwright routes disable
 * the browser HTTP cache and would make this test meaningless.
 * The production helper is transpiled in memory, never reimplemented here.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile, mkdir, stat, lstat, realpath } from 'node:fs/promises';
import { createServer } from 'node:http';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isAbsolute, dirname, basename, parse, resolve } from 'node:path';
import ts from 'typescript';
function options() {
  const result = { playwrightModule: 'playwright', reportPath: null, fixtureSelfTest: false };
  const args = process.argv.slice(2);
  while (args.length) {
    const name = args.shift();
    if (name === '--fixture-self-test') { result.fixtureSelfTest = true; continue; }
    const value = args.shift();
    if (!value || !isAbsolute(value)) throw new Error('Arguments require absolute paths');
    if (name === '--playwright-module') result.playwrightModule = pathToFileURL(value).href;
    else if (name === '--report') result.reportPath = value;
    else throw new Error('Unknown argument');
  }
  return result;
}

async function outsideGitReportPath(path) {
  // Resolve the nearest existing ancestor first, including symlinks, then reject
  // every Git working tree ancestor (.git can be a directory or worktree file).
  try {
    if ((await lstat(path)).isSymbolicLink()) throw new Error('Report cannot be a symlink');
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  let parent = dirname(resolve(path));
  const missing = [];
  while (true) {
    try { parent = await realpath(parent); break; }
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
      missing.unshift(basename(parent));
      const next = dirname(parent);
      if (next === parent) throw error;
      parent = next;
    }
  }
  let ancestor = parent;
  while (true) {
    try {
      await stat(resolve(ancestor, '.git'));
      throw new Error('Report path must be outside Git working trees');
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (ancestor === parse(ancestor).root) break;
    ancestor = dirname(ancestor);
  }
  return resolve(parent, ...missing, basename(path));
}

const helperUrl = new URL('../src/lib/protectedApiFetch.ts', import.meta.url);
const reachabilityUrl = new URL('../src/lib/apiReachability.ts', import.meta.url);
const fixtureImports = { '@/lib/apiReachability': '/fixture/api-reachability.js' };
const report = { passed: false, checks: [], stage: 'load_production_helper' };
let browser;
let cli;
let reportPath;
const servers = [];

async function productionFixtureModules() {
  const modules = new Map();
  const hashes = {};
  for (const [path, url, name] of [
    ['/fixture/protected-api-fetch.js', helperUrl, 'helper'],
    ['/fixture/api-reachability.js', reachabilityUrl, 'api_reachability'],
  ]) {
    const source = await readFile(url, 'utf8');
    hashes[`${name}_sha256`] = createHash('sha256').update(source).digest('hex');
    const result = ts.transpileModule(source, {
      fileName: fileURLToPath(url), reportDiagnostics: true,
      compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 },
    });
    assert.equal(result.diagnostics?.some(d => d.category === ts.DiagnosticCategory.Error) ?? false,
      false, 'production fixture transpiles without errors');
    modules.set(path, result.outputText);
  }
  validateFixtureImports(modules, fixtureImports);
  return { modules, hashes };
}

function validateFixtureImports(modules, imports) {
  for (const source of modules.values()) {
    for (const dependency of ts.preProcessFile(source, true, true).importedFiles) {
      assert.equal(modules.has(imports[dependency.fileName]), true,
        'production fixture dependency has an explicit served import-map target');
    }
  }
}

function check(name, condition) {
  assert.equal(condition, true, name);
  report.checks.push(name);
}

async function origin(handler) {
  const server = createServer((req, res) => {
    Promise.resolve(handler(req, res)).catch(() => {
      if (!res.headersSent) res.writeHead(500, { 'Cache-Control': 'no-store' });
      res.end();
    });
  });
  servers.push(server);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return `http://127.0.0.1:${server.address().port}`;
}

function json(res, value, { status = 200, cache = 'no-store', headers = {} } = {}) {
  const body = JSON.stringify(value);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': cache,
    ...headers,
  });
  res.end(body);
}

async function bodyOf(req) {
  let body = '';
  for await (const chunk of req) {
    body += chunk;
    assert.ok(body.length < 8192, 'synthetic request body bounded');
  }
  return body;
}

async function main() {
  report.stage = 'validate_arguments';
  cli = options();
  if (cli.reportPath) reportPath = await outsideGitReportPath(cli.reportPath);
  report.stage = 'transpile_production_fixture_modules';
  const { modules: fixtureModules, hashes } = await productionFixtureModules();
  Object.assign(report, hashes);
  if (cli.fixtureSelfTest) {
    report.mode = 'fixture_source_only_self_test';
    report.browser_executed = false;
    check('actual_helper_import_map_target_is_served', fixtureModules.has(fixtureImports['@/lib/apiReachability']));
    check('actual_helper_keeps_production_dependency_import',
      ts.preProcessFile(fixtureModules.get('/fixture/protected-api-fetch.js'), true, true)
        .importedFiles.some(item => item.fileName === '@/lib/apiReachability'));
    assert.throws(() => validateFixtureImports(fixtureModules, {}),
      { code: 'ERR_ASSERTION' }, 'missing production dependency mapping is refused');
    check('missing_dependency_mapping_is_refused', true);
    report.stage = 'fixture_source_verified';
    report.passed = true;
    return;
  }
  report.mode = 'chromium_http_cache_regression';
  report.stage = 'load_isolated_playwright';
  const { chromium } = await import(cli.playwrightModule);
  const loopPaths = new Map();
  const hits = new Map();
  const hit = (path) => hits.set(path, (hits.get(path) ?? 0) + 1);
  let storageVersion = 1;
  let corsOrigin;
  const writePaths = ['/rest/v1/example_write', '/functions/v1/example_write'];
  const writes = [];
  const redirectWrites = [];
  const appOrigin = await origin(async (req, res) => {
    const path = req.url;
    hit(path);
    if (path === '/') {
      res.writeHead(200, { 'Content-Type': 'text/html', 'Cache-Control': 'no-store' });
      res.end('<!doctype html><title>Isolated API cache fixture</title><link rel="icon" href="data:,">' +
        '<script type="importmap">' + JSON.stringify({ imports: fixtureImports }) + '</script>');
    } else if (fixtureModules.has(path)) {
      res.writeHead(200, { 'Content-Type': 'text/javascript', 'Cache-Control': 'no-store' });
      res.end(fixtureModules.get(path));
    } else if (loopPaths.has(path)) {
      if (loopPaths.get(path) === 'loop') {
        res.writeHead(308, {
          Location: path,
          'Cache-Control': 'public, max-age=3600',
          'Content-Length': '0',
        });
        res.end();
      } else json(res, { fixture: 'repaired', path });
    } else if (writePaths.includes(path)) {
      writes.push({ path, method: req.method, headers: req.headers, body: await bodyOf(req) });
      // A 503 must be returned once, without replaying a write automatically.
      json(res, { fixture: 'write_unavailable' }, { status: 503 });
    } else if (path === '/storage/v1/object/public/example.txt') {
      json(res, { version: storageVersion }, { cache: 'public, max-age=3600' });
    } else if (path === '/auth/v1/authorize?provider=example') {
      res.writeHead(302, { Location: '/auth/v1/example_callback?code=example', 'Cache-Control': 'no-store' });
      res.end();
    } else if (path === '/auth/v1/example_callback?code=example') {
      json(res, { fixture: 'oauth_callback', method: req.method });
    } else if (/^\/functions\/v1\/example_redirect_(307|308)(_target)?$/.test(path)) {
      redirectWrites.push({ path, method: req.method, body: await bodyOf(req) });
      if (path.endsWith('_target')) json(res, { fixture: 'redirect_target' });
      else {
        res.writeHead(Number(path.slice(-3)), { Location: path + '_target', 'Cache-Control': 'no-store' });
        res.end();
      }
    } else if (path === '/rest/v1/example_head') {
      json(res, { fixture: 'head' }, { headers: { 'X-Example-Method': req.method } });
    } else if (path === '/rest/v1/example_abort') {
      // This only responds if an already-aborted signal was lost by the wrapper.
      json(res, { fixture: 'unexpected_aborted_request' });
    } else if (path === '/rest/v1/example_redirect') {
      res.writeHead(302, { Location: '/rest/v1/example_redirect_target', 'Cache-Control': 'no-store' });
      res.end();
    } else if (path === '/rest/v1/example_redirect_target') {
      json(res, { fixture: 'unexpected_follow' });
    } else {
      json(res, { fixture: 'not_found' }, { status: 404 });
    }
  });
  const cors = { simple: 0, simpleOptions: 0, authenticated: 0, options: 0, requestedHeaders: [] };
  corsOrigin = await origin(async (req, res) => {
    const path = req.url;
    const headers = { 'Access-Control-Allow-Origin': appOrigin, Vary: 'Origin' };
    if (req.method === 'OPTIONS') {
      if (path === '/rest/v1/example_simple') cors.simpleOptions++;
      cors.options++;
      cors.requestedHeaders.push((req.headers['access-control-request-headers'] ?? '')
        .split(',').map((value) => value.trim().toLowerCase()).filter(Boolean).sort());
      // Deliberately no Cache-Control/Pragma permission. Existing credentials are
      // the only non-safelisted headers this synthetic gateway accepts.
      res.writeHead(204, {
        ...headers,
        'Access-Control-Allow-Methods': 'GET',
        'Access-Control-Allow-Headers': 'apikey, authorization',
        'Access-Control-Max-Age': '0',
        'Cache-Control': 'no-store',
      });
      res.end();
    } else if (path === '/rest/v1/example_simple') {
      cors.simple++;
      json(res, { fixture: 'cors_simple' }, { headers });
    } else if (path === '/rest/v1/example_authenticated') {
      cors.authenticated++;
      json(res, { fixture: 'cors_authenticated' }, { headers });
    } else json(res, { fixture: 'not_found' }, { status: 404, headers });
  });

  report.stage = 'launch_isolated_chromium';
  // No channel/executablePath/profile: use Playwright's matching bundled Chromium
  // and its disposable OS-temp profile, never the user's Chrome or saved state.
  browser = await chromium.launch({ headless: true });
  report.chromium = browser.version();
  report.stage = 'create_isolated_context';
  const context = await browser.newContext({ serviceWorkers: 'block' });
  const page = await context.newPage();
  page.setDefaultTimeout(15000);
  report.stage = 'load_fixture_document';
  await page.goto(appOrigin);
  report.stage = 'import_production_fixture_modules';
  await page.evaluate(async (gateway) => {
    const { createProtectedApiFetch } = await import('/fixture/protected-api-fetch.js');
    globalThis.fixtureFetch = createProtectedApiFetch(gateway);
    globalThis.makeFixtureFetch = createProtectedApiFetch;
  }, appOrigin);

  report.stage = 'real_cached_redirect_recovery';
  const endpoints = [
    ['/rest/v1/example_tasks?select=id&order=id.asc', 'string'],
    ['/auth/v1/user', 'request'],
    ['/functions/v1/example_read?mode=example', 'url'],
  ];
  const cacheEvidence = [];
  for (const [path, inputKind] of endpoints) {
    report.active_case = `cached_redirect_${inputKind}`;
    const url = appOrigin + path;
    loopPaths.set(path, 'loop');
    const warm = await page.evaluate(async (target) => {
      try {
        await fetch(target, { signal: AbortSignal.timeout(10000) });
        return 'unexpected_success';
      } catch (error) { return error.name; }
    }, url);
    check(`cache_warm_${inputKind}_fails_with_redirect_loop`, warm === 'TypeError');
    const warmHits = hits.get(path) ?? 0;
    check(`cache_warm_${inputKind}_reached_origin`, warmHits > 0);
    loopPaths.set(path, 'repaired');
    const stale = await page.evaluate(async (target) => {
      try {
        await fetch(target, { signal: AbortSignal.timeout(10000) });
        return 'unexpected_success';
      } catch (error) { return error.name; }
    }, url);
    const staleHits = (hits.get(path) ?? 0) - warmHits;
    check(`cached_${inputKind}_still_fails_after_origin_repair`, stale === 'TypeError');
    check(`cached_${inputKind}_failure_is_from_cache`, staleHits === 0);
    const repaired = await page.evaluate(async ({ target, kind }) => {
      const input = kind === 'request' ? new Request(target) : kind === 'url' ? new URL(target) : target;
      const response = await globalThis.fixtureFetch(input, { signal: AbortSignal.timeout(10000) });
      return { status: response.status, redirected: response.redirected,
        exactUrl: response.url === target, body: (await response.json()).fixture };
    }, { target: url, kind: inputKind });
    check(`production_helper_${inputKind}_recovers_same_url`, repaired.status === 200
      && repaired.body === 'repaired' && repaired.exactUrl && !repaired.redirected);
    const repairedHits = (hits.get(path) ?? 0) - warmHits;
    check(`repaired_${inputKind}_hits_origin_once_without_redirect`, repairedHits === 1);
    cacheEvidence.push({ input: inputKind, warm_origin_hits: warmHits,
      stale_origin_hits: staleHits, recovered_origin_hits: repairedHits });
  }
  report.cache_evidence = cacheEvidence;

  report.stage = 'write_and_fetch_contract';
  report.active_case = 'write_and_fetch_contract';
  const writeResults = await page.evaluate(async (gateway) => {
    const expectedBody = JSON.stringify({ title: 'Example fixture task' });
    const controller = new AbortController();
    const request = new Request(gateway + '/rest/v1/example_write', {
      method: 'POST', headers: { 'Content-Type': 'application/json',
        Authorization: 'Bearer example-fixture', apikey: 'example-fixture', 'X-Example': 'preserved' },
      body: expectedBody, signal: controller.signal, credentials: 'include', redirect: 'error',
      cache: 'reload',
    });
    let observed;
    const wrapped = globalThis.makeFixtureFetch(gateway, (input, init) => {
      observed = { sameInput: input === request, cache: init.cache,
        requestSignalUnchanged: input.signal === request.signal };
      return fetch(input, init);
    });
    const head = await globalThis.fixtureFetch(gateway + '/rest/v1/example_head', { method: 'HEAD' });
    const headResult = { status: head.status, method: head.headers.get('X-Example-Method'),
      emptyBody: (await head.text()) === '' };
    const response = await wrapped(request);
    const body = await response.json();
    const functionResponse = await globalThis.fixtureFetch(gateway + '/functions/v1/example_write', {
      method: 'POST', body: expectedBody, headers: { 'Content-Type': 'application/json' },
      signal: controller.signal, credentials: 'include', redirect: 'error',
    });
    await functionResponse.text();
    const aborted = new AbortController();
    aborted.abort();
    let abortName;
    try {
      await globalThis.fixtureFetch(gateway + '/rest/v1/example_abort', { signal: aborted.signal });
      abortName = 'unexpected_success';
    } catch (error) { abortName = error.name; }
    let redirectName;
    try {
      await globalThis.fixtureFetch(gateway + '/rest/v1/example_redirect', { redirect: 'error' });
      redirectName = 'unexpected_success';
    } catch (error) { redirectName = error.name; }
    return { status: response.status, functionStatus: functionResponse.status,
      responseUnchanged: body.fixture === 'write_unavailable', observed, abortName, redirectName, headResult };
  }, appOrigin);
  check('post_failures_returned_without_automatic_retry', writeResults.status === 503
    && writeResults.functionStatus === 503 && writes.length === 2
    && writePaths.every((path) => writes.filter((write) => write.path === path).length === 1));
  check('request_input_and_signal_preserved', writeResults.observed.sameInput
    && writeResults.observed.requestSignalUnchanged && writeResults.observed.cache === 'no-store');
  check('post_headers_body_and_method_preserved', writes[0].method === 'POST'
    && writes[0].headers.authorization === 'Bearer example-fixture'
    && writes[0].headers.apikey === 'example-fixture'
    && writes[0].headers['x-example'] === 'preserved'
    && writes.every((write) => write.body === JSON.stringify({ title: 'Example fixture task' })));
  check('http_error_response_preserved', writeResults.responseUnchanged);
  check('head_method_and_empty_body_preserved', writeResults.headResult.status === 200
    && writeResults.headResult.method === 'HEAD' && writeResults.headResult.emptyBody
    && hits.get('/rest/v1/example_head') === 1);
  check('aborted_signal_prevents_network_request', writeResults.abortName === 'AbortError'
    && (hits.get('/rest/v1/example_abort') ?? 0) === 0);
  check('caller_redirect_error_policy_preserved', writeResults.redirectName === 'TypeError'
    && (hits.get('/rest/v1/example_redirect') ?? 0) === 1
    && (hits.get('/rest/v1/example_redirect_target') ?? 0) === 0);

  report.stage = 'standard_redirect_follow_preserved';
  report.active_case = 'oauth_302_and_post_307_308_follow';
  const followed = await page.evaluate(async (gateway) => {
    const oauth = await globalThis.fixtureFetch(gateway + '/auth/v1/authorize?provider=example');
    const oauthBody = await oauth.json();
    const posts = [];
    for (const status of [307, 308]) {
      const response = await globalThis.fixtureFetch(gateway + '/functions/v1/example_redirect_' + status, {
        method: 'POST', body: 'example-redirect-body', headers: { 'Content-Type': 'text/plain' },
      });
      posts.push({ status: response.status, redirected: response.redirected,
        correctTarget: response.url === gateway + '/functions/v1/example_redirect_' + status + '_target',
        fixture: (await response.json()).fixture });
    }
    return { oauth: { status: oauth.status, redirected: oauth.redirected,
      correctTarget: oauth.url === gateway + '/auth/v1/example_callback?code=example',
      fixture: oauthBody.fixture, method: oauthBody.method }, posts };
  }, appOrigin);
  check('normal_oauth_shaped_302_get_follow_is_preserved', followed.oauth.status === 200
    && followed.oauth.redirected && followed.oauth.correctTarget
    && followed.oauth.fixture === 'oauth_callback' && followed.oauth.method === 'GET'
    && hits.get('/auth/v1/authorize?provider=example') === 1
    && hits.get('/auth/v1/example_callback?code=example') === 1);
  check('normal_307_308_post_follow_preserves_body_and_method', followed.posts.length === 2
    && followed.posts.every((value) => value.status === 200 && value.redirected
      && value.correctTarget && value.fixture === 'redirect_target')
    && redirectWrites.length === 4
    && redirectWrites.every((value) => value.method === 'POST' && value.body === 'example-redirect-body')
    && [307, 308].every((status) => ['', '_target'].every((suffix) =>
      hits.get('/functions/v1/example_redirect_' + status + suffix) === 1)));

  report.stage = 'storage_http_cache_preserved';
  report.active_case = 'storage_http_cache';
  const storagePath = '/storage/v1/object/public/example.txt';
  const cachedStorage = () => page.evaluate(async (url) => {
    const response = await globalThis.fixtureFetch(url, { cache: 'force-cache' });
    return (await response.json()).version;
  }, appOrigin + storagePath);
  const firstStorage = await cachedStorage();
  storageVersion = 2;
  const secondStorage = await cachedStorage();
  check('storage_retains_its_existing_cache_contract', firstStorage === 1 && secondStorage === 1
    && hits.get(storagePath) === 1);

  report.stage = 'cross_origin_cors_contract';
  report.active_case = 'cross_origin_cors_contract';
  const corsResult = await page.evaluate(async (gateway) => {
    const client = globalThis.makeFixtureFetch(gateway);
    const simple = await client(gateway + '/rest/v1/example_simple');
    await simple.text();
    const authenticated = await client(gateway + '/rest/v1/example_authenticated', {
      headers: { apikey: 'example-fixture', Authorization: 'Bearer example-fixture' },
    });
    await authenticated.text();
    return { simple: simple.status, authenticated: authenticated.status };
  }, corsOrigin);
  check('cross_origin_simple_get_adds_no_preflight', corsResult.simple === 200
    && cors.simple === 1 && cors.simpleOptions === 0);
  check('existing_authenticated_cors_allowlist_still_works', corsResult.authenticated === 200
    && cors.authenticated === 1 && cors.options === 1
    && JSON.stringify(cors.requestedHeaders) === JSON.stringify([['apikey', 'authorization']]));
  report.cors = { simple_options: cors.simpleOptions, authenticated_options: cors.options,
    cache_headers_required_in_allowlist: false };
  await context.close();
  report.stage = 'complete';
  delete report.active_case;
  report.passed = true;
}

try {
  await main();
} catch (error) {
  // Only controlled fixture assertions and error class; no request headers/body,
  // browser profile state, user environment, URLs or raw browser diagnostics.
  report.error_name = error?.name ?? 'Error';
  if (report.stage === 'load_isolated_playwright') {
    report.dependency_help = 'Install pinned playwright in a non-Git runtime, run its CLI install chromium, then pass --playwright-module /absolute/runtime/node_modules/playwright/index.mjs';
  }
  if (error?.code === 'ERR_ASSERTION') report.failed_check = error.message;
  process.exitCode = 1;
} finally {
  const cleanup = { browser_closed: !browser, fixture_origins_closed: false };
  if (browser) {
    try { await browser.close(); cleanup.browser_closed = !browser.isConnected(); }
    catch { cleanup.browser_closed = false; }
  }
  await Promise.all(servers.map((server) => new Promise((resolve) => {
    server.close(resolve);
    server.closeAllConnections();
  })));
  cleanup.fixture_origins_closed = servers.every((server) => !server.listening);
  report.cleanup = cleanup;
  if (!cleanup.browser_closed || !cleanup.fixture_origins_closed) {
    report.passed = false;
    process.exitCode = 1;
  }
  report.check_count = report.checks.length;
  if (reportPath) {
    try {
      await mkdir(dirname(reportPath), { recursive: true });
      await writeFile(reportPath, JSON.stringify(report) + '\n', { mode: 0o600 });
    } catch {
      report.passed = false;
      report.report_write_failed = true;
      process.exitCode = 1;
    }
  }
  console.log(JSON.stringify(report));
}
