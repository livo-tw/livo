import { afterEach, describe, expect, it, vi } from 'vitest';
import { generateId, randomUUID } from '@/lib/generateId';
import { copyText } from '@/lib/clipboard';

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('randomUUID on plain http (no crypto.randomUUID)', () => {
  it('uses crypto.randomUUID when the browser has it', () => {
    expect(randomUUID()).toMatch(UUID_V4);
  });

  it('falls back to getRandomValues and still returns a v4 UUID', () => {
    const real = globalThis.crypto;
    const getRandomValues = vi.fn((a: Uint8Array) => real.getRandomValues(a));
    vi.stubGlobal('crypto', { getRandomValues });
    const ids = new Set(Array.from({ length: 200 }, () => randomUUID()));
    expect(ids.size).toBe(200);
    for (const id of ids) expect(id).toMatch(UUID_V4);
    expect(getRandomValues).toHaveBeenCalled();
    expect(generateId('p')).toMatch(/^p_[0-9a-f-]{36}$/);
  });

  it('still works with no Web Crypto at all', () => {
    vi.stubGlobal('crypto', undefined);
    expect(randomUUID()).toMatch(UUID_V4);
  });
});

describe('copyText on plain http (no navigator.clipboard)', () => {
  it('falls back to execCommand and cleans up after itself', async () => {
    vi.stubGlobal('isSecureContext', false);
    const exec = vi.fn(() => true);
    (document as unknown as { execCommand: typeof exec }).execCommand = exec;
    const before = document.querySelectorAll('textarea').length;
    await expect(copyText('http://livo.example.com/demo/?task=ABC-1')).resolves.toBe(true);
    expect(exec).toHaveBeenCalledWith('copy');
    expect(document.querySelectorAll('textarea').length).toBe(before);
  });

  it('reports failure instead of throwing', async () => {
    vi.stubGlobal('isSecureContext', false);
    (document as unknown as { execCommand: () => boolean }).execCommand = () => { throw new Error('blocked'); };
    await expect(copyText('x')).resolves.toBe(false);
  });
});
