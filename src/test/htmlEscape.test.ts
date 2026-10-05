import { describe, expect, it } from 'vitest';
import { escapeHtml } from '@/lib/html';

describe('escapeHtml', () => {
  it('neutralises markup in user text used by exports', () => {
    expect(escapeHtml('<img src=x onerror="alert(1)">')).toBe('&lt;img src=x onerror=&quot;alert(1)&quot;&gt;');
    expect(escapeHtml("Tom & Jerry's")).toBe('Tom &amp; Jerry&#39;s');
    expect(escapeHtml(null)).toBe('');
    expect(escapeHtml(42)).toBe('42');
  });
});
