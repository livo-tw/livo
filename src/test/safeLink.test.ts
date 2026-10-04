import { describe, expect, it } from 'vitest';
import { safeLinkHref } from '@/lib/safeLink';

describe('safeLinkHref', () => {
  it.each(['https://gitlab.example.com/group/repo/-/merge_requests/1', 'http://10.0.0.5:3000/storage/v1/object/public/task-images/a.png', '/storage/v1/object/public/task-images/a.png'])('keeps %s', (url) => {
    expect(safeLinkHref(url)).toBe(url);
  });
  it.each(['javascript:alert(1)', ' JavaScript:alert(1)', 'data:text/html,<script>alert(1)</script>', 'vbscript:x', 'https://user:pass@example.com/', '', null, undefined])('refuses %s', (url) => {
    expect(safeLinkHref(url as string | null | undefined)).toBeNull();
  });
});
