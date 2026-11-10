import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { useApiOfflineBanner } from '@/hooks/useApiOfflineBanner';
import { getApiReachability, invalidateApiReachability } from '@/lib/apiReachability';
import { createProtectedApiFetch } from '@/lib/protectedApiFetch';
import { createCfClient } from '@/integrations/backend/cfClient';

const API = 'https://gateway.example.com';
const json = (status = 200) => new Response('{}', { status, headers: { 'Content-Type': 'application/json' } });
let online = true;

beforeEach(() => {
  online = true;
  vi.spyOn(navigator, 'onLine', 'get').mockImplementation(() => online);
  invalidateApiReachability();
  localStorage.clear();
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

const request = (send: typeof fetch, init?: RequestInit) =>
  createProtectedApiFetch(API, send)(`${API}/rest/v1/tasks`, init);

describe('offline banner reconciles browser hints with SDK transport evidence', () => {
  it('clears a false browser offline hint after a fresh same-API JSON response', async () => {
    online = false;
    const { result } = renderHook(useApiOfflineBanner);
    expect(result.current).toBe(true);
    const send = vi.fn<typeof fetch>().mockResolvedValue(json());
    await act(async () => { await request(send); });
    expect(result.current).toBe(false);
    expect(send.mock.calls[0][1]?.cache).toBe('no-store');
    expect(navigator.onLine).toBe(false);
  });

  it('keeps the warning after a real network rejection without replaying a write', async () => {
    online = false;
    const { result } = renderHook(useApiOfflineBanner);
    const error = new TypeError('Network request failed');
    const send = vi.fn<typeof fetch>().mockRejectedValue(error);
    await act(async () => {
      await expect(request(send, { method: 'POST', body: '{}' })).rejects.toBe(error);
    });
    expect(result.current).toBe(true);
    expect(send).toHaveBeenCalledTimes(1);
    expect(localStorage.length).toBe(0);
  });

  it('also reports transport failure when the browser still claims it is online', async () => {
    const { result } = renderHook(useApiOfflineBanner);
    const send = vi.fn<typeof fetch>().mockRejectedValue(new TypeError('Network request failed'));
    await act(async () => { await request(send).catch(() => {}); });
    expect(result.current).toBe(true);
    await act(async () => { await request(vi.fn<typeof fetch>().mockResolvedValue(json())); });
    expect(result.current).toBe(false);
  });

  it('does not turn user cancellation into a global network outage', async () => {
    online = false;
    const { result } = renderHook(useApiOfflineBanner);
    await act(async () => { await request(vi.fn<typeof fetch>().mockResolvedValue(json())); });
    const cancelled = new DOMException('Cancelled', 'AbortError');
    await act(async () => {
      await request(vi.fn<typeof fetch>().mockRejectedValue(cancelled)).catch(() => {});
    });
    const controller = new AbortController(); controller.abort();
    await act(async () => {
      await request(vi.fn<typeof fetch>().mockRejectedValue(new TypeError('Cancelled')), { signal: controller.signal }).catch(() => {});
    });
    expect(result.current).toBe(false);
  });

  it('ignores an older failed request after a newer request has responded', async () => {
    online = false;
    const { result } = renderHook(useApiOfflineBanner);
    let rejectOld!: (error: Error) => void;
    const old = request(vi.fn<typeof fetch>(() => new Promise((_resolve, reject) => { rejectOld = reject; }))).catch(() => {});
    await act(async () => { await request(vi.fn<typeof fetch>().mockResolvedValue(json())); });
    await act(async () => { rejectOld(new TypeError('Old failure')); await old; });
    expect(result.current).toBe(false);
  });

  it('reconciles a missed online event when the window regains focus', () => {
    online = false;
    const { result } = renderHook(useApiOfflineBanner);
    expect(result.current).toBe(true);
    online = true;
    act(() => { window.dispatchEvent(new Event('focus')); });
    expect(result.current).toBe(false);
  });

  it('recovers a failed offline context on a real online transition and ignores its old requests', async () => {
    online = false;
    const { result } = renderHook(useApiOfflineBanner);
    await act(async () => {
      await request(vi.fn<typeof fetch>().mockRejectedValue(new TypeError('Offline'))).catch(() => {});
    });
    expect(result.current).toBe(true);
    let rejectOld!: (error: Error) => void;
    const old = request(vi.fn<typeof fetch>(() => new Promise((_resolve, reject) => { rejectOld = reject; }))).catch(() => {});
    online = true;
    act(() => { window.dispatchEvent(new Event('online')); });
    expect(result.current).toBe(false);
    await act(async () => { rejectOld(new TypeError('Previous connection failed')); await old; });
    expect(result.current).toBe(false);
    expect(getApiReachability()).toBe('unknown');
  });

  it('does not erase an API transport failure by focusing an unchanged online hint', async () => {
    const { result } = renderHook(useApiOfflineBanner);
    await act(async () => {
      await request(vi.fn<typeof fetch>().mockRejectedValue(new TypeError('API unreachable'))).catch(() => {});
    });
    act(() => { window.dispatchEvent(new Event('focus')); });
    expect(result.current).toBe(true);
    expect(getApiReachability()).toBe('failed');
  });

  it('rechecks a missed offline hint on visibility and awaits new API evidence', async () => {
    const { result } = renderHook(useApiOfflineBanner);
    await act(async () => { await request(vi.fn<typeof fetch>().mockResolvedValue(json())); });
    online = false;
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
    act(() => { document.dispatchEvent(new Event('visibilitychange')); });
    expect(result.current).toBe(true);
    await act(async () => { await request(vi.fn<typeof fetch>().mockResolvedValue(json())); });
    expect(result.current).toBe(false);
  });

  it('does not reuse a response from before a new offline event', async () => {
    const { result } = renderHook(useApiOfflineBanner);
    let resolveOld!: (response: Response) => void;
    const old = request(vi.fn<typeof fetch>(() => new Promise(resolve => { resolveOld = resolve; })));
    online = false;
    act(() => { window.dispatchEvent(new Event('offline')); });
    await act(async () => { resolveOld(json()); await old; });
    expect(result.current).toBe(true);
  });

  it('treats a JSON auth rejection as reachable without consuming or changing the auth result', async () => {
    online = false;
    const { result } = renderHook(useApiOfflineBanner);
    const denied = json(401);
    await act(async () => { expect(await request(vi.fn<typeof fetch>().mockResolvedValue(denied))).toBe(denied); });
    expect(denied.status).toBe(401);
    expect(denied.bodyUsed).toBe(false);
    expect(result.current).toBe(false);
    expect(localStorage.length).toBe(0);
  });

  it('does not count cached media, HTML or a redirected response from another origin', async () => {
    online = false;
    const { result } = renderHook(useApiOfflineBanner);
    await act(async () => {
      await request(vi.fn<typeof fetch>().mockResolvedValue(new Response('<html>Offline shell</html>', { headers: { 'Content-Type': 'text/html' } })));
      const external = json(); Object.defineProperty(external, 'url', { value: 'https://other.example.com/api' });
      await request(vi.fn<typeof fetch>().mockResolvedValue(external));
      await createProtectedApiFetch(API, vi.fn<typeof fetch>().mockResolvedValue(json()))(`${API}/storage/v1/object/example.png`);
    });
    expect(result.current).toBe(true);
  });

  it('observes the real Cloudflare JSON SDK path without changing its query response', async () => {
    online = false;
    const { result } = renderHook(useApiOfflineBanner);
    const send = vi.fn<typeof fetch>().mockResolvedValue(new Response('{"data":[],"error":null}', { headers: { 'Content-Type': 'application/json' } }));
    vi.stubGlobal('fetch', send);
    await act(async () => {
      const response = await (createCfClient() as SupabaseClient).from('tasks').select('id');
      expect(response.error).toBeNull(); expect(response.data).toEqual([]);
    });
    expect(result.current).toBe(false);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0][1]?.cache).toBe('no-store');
  });

  it('removes browser listeners and the subscription when unmounted', () => {
    const removeWindow = vi.spyOn(window, 'removeEventListener');
    const removeDocument = vi.spyOn(document, 'removeEventListener');
    const { unmount } = renderHook(useApiOfflineBanner);
    unmount();
    for (const type of ['online', 'offline', 'focus']) expect(removeWindow).toHaveBeenCalledWith(type, expect.any(Function));
    expect(removeDocument).toHaveBeenCalledWith('visibilitychange', expect.any(Function));
    expect(getApiReachability()).toBe('unknown');
  });
});
