import { describe, expect, it } from 'vitest';
import { appDeepLinkSearch } from '@/lib/appDeepLink';

describe('destinations after sign-in', () => {
  it('keeps a knowledge paragraph or existing task and QA destination', () => {
    expect(appDeepLinkSearch('?kb=meeting&anchor=decision')).toBe('?kb=meeting&anchor=decision');
    expect(appDeepLinkSearch('?task=EX-1')).toBe('?task=EX-1');
    expect(appDeepLinkSearch('?qa=example')).toBe('?qa=example');
  });
  it('does not preserve credentials or accept external return URLs', () => {
    expect(appDeepLinkSearch('?returnTo=https://example.com&token=private&invite=private')).toBe('');
    expect(appDeepLinkSearch('?anchor=orphan')).toBe('');
    expect(appDeepLinkSearch(`?kb=${'x'.repeat(201)}`)).toBe('');
  });
});
