import { describe, it, expect } from 'vitest';
import { bindableMembers, normalizeToken } from '@/components/integrations/apiTokenUtils';
import type { User } from '@/types';

const user = (id: string, role: User['role'], isActive = true): User => ({
  id,
  name: id,
  avatar: id.slice(0, 1),
  role,
  jobTitle: '',
  color: '#6B778C',
  email: `${id}@example.com`,
  isActive,
  sortOrder: 0,
});

describe('normalizeToken', () => {
  it('reads the camelCase contract (Cloudflare and self-host)', () => {
    expect(
      normalizeToken({
        id: 't1',
        name: 'CI',
        memberId: 'm1',
        createdBy: 'm1',
        createdAt: '2026-10-01T00:00:00Z',
        lastUsedAt: null,
        revokedAt: '2026-10-02T00:00:00Z',
      }),
    ).toEqual({
      id: 't1',
      name: 'CI',
      memberId: 'm1',
      createdAt: '2026-10-01T00:00:00Z',
      lastUsedAt: null,
      revokedAt: '2026-10-02T00:00:00Z',
    });
  });

  it('still reads older snake_case rows', () => {
    const tok = normalizeToken({ id: 't2', name: 'old', member_id: 'm2', created_at: '2026-07-13', revoked_at: null });
    expect(tok.memberId).toBe('m2');
    expect(tok.createdAt).toBe('2026-07-13');
    expect(tok.revokedAt).toBeNull();
  });
});

describe('bindableMembers', () => {
  const users = [
    user('super', 'super_admin'),
    user('admin', 'admin'),
    user('admin2', 'admin'),
    user('member', 'member'),
    user('gone', 'member', false),
  ];

  it('an admin may bind to self and to ordinary members only', () => {
    expect(bindableMembers(users, users[1]).map((u) => u.id)).toEqual(['admin', 'member']);
  });

  it('a super_admin may bind to any active member', () => {
    expect(bindableMembers(users, users[0]).map((u) => u.id)).toEqual(['super', 'admin', 'admin2', 'member']);
  });

  it('nobody without a resolved caller', () => {
    expect(bindableMembers(users, null)).toEqual([]);
  });
});
