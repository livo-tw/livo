import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { QaProfilePasswordChangeRequired, readWorkspaceProfile } from '@/lib/qa/externalProfile';

vi.mock('@/lib/apiBase', () => ({ fnUrl: () => 'https://example.com/functions/v1/qa' }));
vi.mock('@/integrations/supabase/client', () => ({ supabase: { auth: {
  getSession: async () => ({ data: { session: { access_token: 'example-session' } } }),
} } }));
beforeEach(() => vi.useFakeTimers());
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

it('bounds an open gateway request so the access gate can offer retry', async () => {
  vi.stubGlobal('fetch', vi.fn((_url, options: RequestInit) => new Promise((_resolve, reject) => {
    options.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
  })));
  const pending = readWorkspaceProfile(new AbortController().signal);
  const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  await vi.advanceTimersByTimeAsync(15_001);
  await rejected;
  expect(vi.getTimerCount()).toBe(0);
});

it('preserves the backend password-change requirement instead of treating it as a generic outage', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ error: 'qa_password_change_required' }, { status: 403 })));
  await expect(readWorkspaceProfile(new AbortController().signal)).rejects.toBeInstanceOf(QaProfilePasswordChangeRequired);
  expect(vi.getTimerCount()).toBe(0);
});
