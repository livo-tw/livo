import { afterEach, describe, it, expect, vi } from 'vitest';
import { createClient } from '@supabase/supabase-js';
import { isLoopbackHost, resolveGatewayUrl, supabaseAuthStorageKey } from '@/lib/gatewayUrl';

afterEach(() => vi.unstubAllGlobals());

describe('resolveGatewayUrl', () => {
  it('uses the page origin, including HTTPS and custom frontend ports', () => {
    expect(resolveGatewayUrl('http://localhost:8000', 'http://livo.example.com:3000')).toBe('http://livo.example.com:3000');
    expect(resolveGatewayUrl('http://localhost:18000', 'https://livo.example.com')).toBe('https://livo.example.com');
    expect(resolveGatewayUrl('http://127.0.0.1:8000', 'https://livo.example.com:8443')).toBe('https://livo.example.com:8443');
    expect(resolveGatewayUrl('http://[::1]:8000', 'http://[2001:db8::5]:3001')).toBe('http://[2001:db8::5]:3001');
  });

  it('reads window.location.origin by default', () => {
    vi.stubGlobal('window', { location: new URL('https://livo.example.com/demo/auth') });
    expect(resolveGatewayUrl('http://localhost:8000')).toBe('https://livo.example.com');
  });

  it('keeps the baked gateway when the page is on loopback', () => {
    for (const origin of ['http://localhost:3000', 'https://app.localhost', 'http://127.0.0.1:3000', 'http://[::1]:3000']) {
      expect(resolveGatewayUrl('http://localhost:8000', origin)).toBe('http://localhost:8000');
    }
  });

  it('never rewrites a real gateway host', () => {
    expect(resolveGatewayUrl('https://api.example.com', 'https://livo.example.com')).toBe('https://api.example.com');
    expect(resolveGatewayUrl('http://api.example.com:8000/', 'http://livo.example.com:3000')).toBe('http://api.example.com:8000/');
  });

  it('keeps empty, malformed, absent-page and non-HTTP inputs unchanged', () => {
    expect(resolveGatewayUrl('', 'https://livo.example.com')).toBe('');
    expect(resolveGatewayUrl('not a url', 'https://livo.example.com')).toBe('not a url');
    for (const page of ['', 'not a url', 'file:///demo/index.html']) {
      expect(resolveGatewayUrl('http://localhost:8000', page)).toBe('http://localhost:8000');
    }
    vi.stubGlobal('window', undefined);
    expect(resolveGatewayUrl('http://localhost:8000')).toBe('http://localhost:8000');
  });

  it('uses the bare origin without a trailing slash or page path', () => {
    expect(resolveGatewayUrl('http://localhost:8000/', 'https://livo.example.com/demo/')).toBe('https://livo.example.com');
  });
});

describe('isLoopbackHost', () => {
  it('recognises loopback names and addresses', () => {
    for (const host of ['localhost', 'LOCALHOST', 'app.localhost', '127.0.0.1', '127.1.2.3', '::1', '[::1]']) {
      expect(isLoopbackHost(host)).toBe(true);
    }
    for (const host of ['livo.example.com', '[2001:db8::5]', 'localhost.example.com']) {
      expect(isLoopbackHost(host)).toBe(false);
    }
  });
});

describe('supabaseAuthStorageKey', () => {
  it.each(['http://localhost:8000', 'https://livo.example.com', 'https://livo.example.com:8443'])('matches the SDK session key for %s', (origin) => {
    const gateway = resolveGatewayUrl('http://localhost:8000', origin);
    const client = createClient(gateway, 'example-key', {
      auth: { autoRefreshToken: false, detectSessionInUrl: false, persistSession: false },
    });
    const auth = client.auth as unknown as { storageKey: string };
    expect(supabaseAuthStorageKey(gateway)).toBe(auth.storageKey);
    const realtime = client.realtime as unknown as { endPoint: string };
    expect(realtime.endPoint).toBe(gateway.replace(/^http/, 'ws') + '/realtime/v1/websocket');
  });
});
