// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createClient } from '@supabase/supabase-js';
import { createProtectedApiFetch } from '@/lib/protectedApiFetch';

const GATEWAY = 'https://api.example.com';
const sendOk = () => vi.fn<typeof fetch>(async () => new Response('{}'));

afterEach(() => vi.unstubAllGlobals());

describe('protected API HTTP-cache bypass', () => {
  it.each([
    '/auth/v1/token?grant_type=refresh_token',
    '/auth/v1/verify?type=invite&token=example-code',
    '/rest/v1/tasks?select=*',
    '/rest/v1',
    '/functions/v1/knowledge-workflow',
  ])('bypasses existing cache entries for %s', async path => {
    const send = sendOk();
    await createProtectedApiFetch(GATEWAY, send)(GATEWAY + path);
    expect(send).toHaveBeenCalledExactlyOnceWith(GATEWAY + path, { cache: 'no-store' });
  });

  it.each([
    GATEWAY + '/storage/v1/object/public/example/file.png',
    GATEWAY + '/assets/example.js',
    GATEWAY + '/rest/v10/tasks',
    GATEWAY + '/rest/v1-example/tasks',
    GATEWAY + '/other/rest/v1/tasks',
    GATEWAY + ':8443/rest/v1/tasks',
    'https://other.example.com/rest/v1/tasks',
    'https://api.example.com.other.example.com/rest/v1/tasks',
  ])('preserves cache policy outside the configured API: %s', async url => {
    const send = sendOk();
    const init = Object.freeze({ cache: 'force-cache' as const });
    await createProtectedApiFetch(GATEWAY, send)(url, init);
    expect(send.mock.calls[0][0]).toBe(url);
    expect(send.mock.calls[0][1]).toBe(init);
  });

  it('respects a configured gateway base path and URL inputs', async () => {
    const send = sendOk();
    const fetchApi = createProtectedApiFetch(GATEWAY + '/gateway/', send);
    const protectedUrl = new URL(GATEWAY + '/gateway/rest/v1/tasks');
    await fetchApi(protectedUrl);
    await fetchApi(GATEWAY + '/rest/v1/tasks');
    expect(send.mock.calls[0]).toEqual([protectedUrl, { cache: 'no-store' }]);
    expect(send.mock.calls[0][0]).toBe(protectedUrl);
    expect(send.mock.calls[1][1]).toBeUndefined();
  });

  it('resolves relative inputs as the browser does, without redirecting them to the gateway', async () => {
    vi.stubGlobal('document', { baseURI: 'https://app.example.com/demo/' });
    const send = sendOk();
    await createProtectedApiFetch(GATEWAY, send)('/rest/v1/tasks');
    expect(send.mock.calls[0]).toEqual(['/rest/v1/tasks', undefined]);
    vi.stubGlobal('document', { baseURI: GATEWAY + '/demo/' });
    await createProtectedApiFetch(GATEWAY, send)('/rest/v1/tasks');
    expect(send.mock.calls[1]).toEqual(['/rest/v1/tasks', { cache: 'no-store' }]);
  });

  it('preserves a Request body and native method, headers, signal and redirect semantics', async () => {
    const controller = new AbortController();
    const input = new Request(GATEWAY + '/functions/v1/example-command', {
      method: 'POST', body: '{"example":true}',
      headers: { Authorization: 'Bearer example-token', 'Content-Type': 'application/json' },
      signal: controller.signal, credentials: 'include', redirect: 'manual', cache: 'force-cache',
    });
    let actual: Request | undefined;
    const send = vi.fn<typeof fetch>(async (request, init) => {
      expect(request).toBe(input);
      expect(input.bodyUsed).toBe(false);
      actual = new Request(request, init);
      expect(await actual.text()).toBe('{"example":true}');
      return new Response('{}');
    });
    await createProtectedApiFetch(GATEWAY, send)(input);
    expect(actual!.method).toBe('POST');
    expect(actual!.headers.get('Authorization')).toBe('Bearer example-token');
    expect(actual!.headers.get('Content-Type')).toBe('application/json');
    expect(actual!.credentials).toBe('include');
    expect(actual!.redirect).toBe('manual');
    expect(actual!.cache).toBe('no-store');
    controller.abort();
    expect(actual!.signal.aborted).toBe(true);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('preserves RequestInit overrides by reference and changes only cache', async () => {
    const send = sendOk();
    const input = new Request(GATEWAY + '/rest/v1/tasks', { method: 'POST', body: 'original' });
    const controller = new AbortController();
    const headers = new Headers({ 'Content-Type': 'text/plain', 'X-Example': 'preserved' });
    const body = new URLSearchParams({ example: 'preserved' });
    const init = Object.freeze({ method: 'PATCH', body, headers, signal: controller.signal,
      credentials: 'omit' as const, redirect: 'error' as const, cache: 'reload' as const,
      keepalive: true, referrerPolicy: 'no-referrer' as const });
    await createProtectedApiFetch(GATEWAY, send)(input, init);
    expect(send.mock.calls[0][0]).toBe(input);
    expect(send.mock.calls[0][1]).toEqual({ ...init, cache: 'no-store' });
    expect(send.mock.calls[0][1]!.headers).toBe(headers);
    expect(send.mock.calls[0][1]!.body).toBe(body);
    expect(send.mock.calls[0][1]!.signal).toBe(controller.signal);
    expect(init.cache).toBe('reload');
    expect(headers.has('Cache-Control')).toBe(false);
    expect(headers.has('Pragma')).toBe(false);
  });

  it('leaves legitimate auth redirects and failed responses to native fetch', async () => {
    const response = new Response(null, { status: 302, headers: { Location: 'https://identity.example.com/' } });
    const send = vi.fn<typeof fetch>().mockResolvedValue(response);
    const init = { redirect: 'manual' as const };
    expect(await createProtectedApiFetch(GATEWAY, send)(GATEWAY + '/auth/v1/authorize', init)).toBe(response);
    expect(send).toHaveBeenCalledExactlyOnceWith(GATEWAY + '/auth/v1/authorize', { redirect: 'manual', cache: 'no-store' });
  });

  it('does not retry a POST whose response was lost after a possible commit', async () => {
    const failure = new TypeError('Example connection interrupted');
    const send = vi.fn<typeof fetch>().mockRejectedValue(failure);
    const init = { method: 'POST', body: '{"example":true}' };
    await expect(createProtectedApiFetch(GATEWAY, send)(GATEWAY + '/functions/v1/example-command', init)).rejects.toBe(failure);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('returns an error response without submitting the operation again', async () => {
    const response = new Response('{"error":"example_unavailable"}', { status: 502 });
    const send = vi.fn<typeof fetch>().mockResolvedValue(response);
    expect(await createProtectedApiFetch(GATEWAY, send)(GATEWAY + '/rest/v1/tasks', { method: 'POST', body: '{}' })).toBe(response);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('uses the current native fetch when no implementation is provided', async () => {
    const send = sendOk();
    vi.stubGlobal('fetch', send);
    await createProtectedApiFetch(GATEWAY)(GATEWAY + '/rest/v1/tasks');
    expect(send).toHaveBeenCalledExactlyOnceWith(GATEWAY + '/rest/v1/tasks', { cache: 'no-store' });
  });

  it.each(['not a URL', 'file:///example'])('leaves invalid gateways to the SDK: %s', async gateway => {
    const send = sendOk();
    await createProtectedApiFetch(gateway, send)(GATEWAY + '/rest/v1/tasks');
    expect(send.mock.calls[0][1]).toBeUndefined();
  });

  it('applies through the actual SDK to auth, REST and functions while preserving storage', async () => {
    const send = vi.fn<typeof fetch>(async input => {
      const url = new URL(typeof input === 'object' && 'url' in input ? input.url : String(input));
      const data = url.pathname.startsWith('/rest/') || url.pathname.startsWith('/storage/') ? [] : {};
      return new Response(JSON.stringify(data), { headers: { 'Content-Type': 'application/json' } });
    });
    const client = createClient(GATEWAY, 'example-key', {
      auth: { autoRefreshToken: false, detectSessionInUrl: false, persistSession: false },
      global: { fetch: createProtectedApiFetch(GATEWAY, send) },
    });
    expect((await client.from('tasks').select('id')).error).toBeNull();
    expect((await client.functions.invoke('example-command', { body: { example: true } })).error).toBeNull();
    expect((await client.auth.signInWithOtp({ email: 'member@example.com' })).error).toBeNull();
    expect((await client.storage.from('example').list()).error).toBeNull();
    const calls = send.mock.calls.map(([input, init]) => ({ url: String(input), init }));
    for (const route of ['rest', 'functions', 'auth']) {
      const call = calls.find(call => call.url.startsWith(`${GATEWAY}/${route}/v1/`));
      expect(call, route).toBeDefined();
      expect(call!.init!.cache).toBe('no-store');
    }
    expect(calls.find(call => call.url.startsWith(`${GATEWAY}/storage/v1/`))!.init!.cache).toBeUndefined();
    const command = calls.find(call => call.url.includes('/functions/v1/'))!;
    expect(command.init!.method).toBe('POST');
    expect(JSON.parse(command.init!.body as string)).toEqual({ example: true });
  });
});
