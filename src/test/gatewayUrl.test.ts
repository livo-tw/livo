// Self-host gateway URL: a bundle baked with http://localhost:<port> must reach
// the server when it is opened from another machine. Hosts here are made up.

import { describe, it, expect } from 'vitest';
import { isLoopbackHost, resolveGatewayUrl, supabaseAuthStorageKey } from '@/lib/gatewayUrl';

describe('resolveGatewayUrl', () => {
  it('points a loopback gateway at the page host, keeping scheme and port', () => {
    expect(resolveGatewayUrl('http://localhost:8000', '192.168.1.20')).toBe('http://192.168.1.20:8000');
    expect(resolveGatewayUrl('http://localhost:18000', 'livo-server')).toBe('http://livo-server:18000');
    expect(resolveGatewayUrl('http://127.0.0.1:8000', 'pm.example.internal')).toBe('http://pm.example.internal:8000');
    expect(resolveGatewayUrl('http://localhost:8000', '[fd00::5]')).toBe('http://[fd00::5]:8000');
  });

  it('leaves the URL alone when the page itself is on the server', () => {
    expect(resolveGatewayUrl('http://localhost:8000', 'localhost')).toBe('http://localhost:8000');
    expect(resolveGatewayUrl('http://localhost:8000', '127.0.0.1')).toBe('http://localhost:8000');
    expect(resolveGatewayUrl('http://localhost:8000', '[::1]')).toBe('http://localhost:8000');
    expect(resolveGatewayUrl('http://localhost:8000', '')).toBe('http://localhost:8000');
  });

  it('never rewrites a real gateway host', () => {
    expect(resolveGatewayUrl('https://api.example.com', '192.168.1.20')).toBe('https://api.example.com');
    expect(resolveGatewayUrl('http://10.0.0.5:8000', 'livo-server')).toBe('http://10.0.0.5:8000');
  });

  it('keeps an empty or unparsable value as it is', () => {
    expect(resolveGatewayUrl('', '192.168.1.20')).toBe('');
    expect(resolveGatewayUrl('not a url', '192.168.1.20')).toBe('not a url');
  });

  it('keeps a trailing slash only when the build had one', () => {
    expect(resolveGatewayUrl('http://localhost:8000/', '192.168.1.20')).toBe('http://192.168.1.20:8000/');
  });
});

describe('isLoopbackHost', () => {
  it('recognises loopback names and addresses', () => {
    for (const h of ['localhost', 'LOCALHOST', 'app.localhost', '127.0.0.1', '127.1.2.3', '::1', '[::1]']) {
      expect(isLoopbackHost(h)).toBe(true);
    }
    for (const h of ['192.168.1.20', 'livo-server', '10.0.0.5', '[fd00::5]', 'localhost.example.com']) {
      expect(isLoopbackHost(h)).toBe(false);
    }
  });
});

describe('supabaseAuthStorageKey', () => {
  it('matches the key supabase-js derives from the gateway host', () => {
    expect(supabaseAuthStorageKey('http://localhost:8000')).toBe('sb-localhost-auth-token');
    expect(supabaseAuthStorageKey('http://192.168.1.20:8000')).toBe('sb-192-auth-token');
    expect(supabaseAuthStorageKey('https://abcdefgh.supabase.co')).toBe('sb-abcdefgh-auth-token');
  });
});
