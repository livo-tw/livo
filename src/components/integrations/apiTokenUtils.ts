// Pure helpers for ApiTokensCard (unit-tested in src/test/apiTokenUtils.test.ts).

import type { User } from '@/types';

export interface ApiToken {
  id: string;
  name: string;
  memberId: string;
  createdAt: string | null;
  lastUsedAt: string | null;
  revokedAt: string | null;
}

/** Accepts the camelCase contract and the older snake_case rows. */
export function normalizeToken(raw: Record<string, unknown>): ApiToken {
  const str = (camel: string, snake: string): string | null => {
    const v = raw[camel] ?? raw[snake];
    return typeof v === 'string' && v ? v : null;
  };
  return {
    id: String(raw.id ?? ''),
    name: String(raw.name ?? ''),
    memberId: str('memberId', 'member_id') ?? '',
    createdAt: str('createdAt', 'created_at'),
    lastUsedAt: str('lastUsedAt', 'last_used_at'),
    revokedAt: str('revokedAt', 'revoked_at'),
  };
}

const ADMIN_ROLES: User['role'][] = ['admin', 'super_admin'];

/** Members the caller may bind a token to (same rule as the server). */
export function bindableMembers(users: User[], caller: User | null): User[] {
  if (!caller) return [];
  return users.filter(u =>
    u.isActive && (u.id === caller.id || caller.role === 'super_admin' || !ADMIN_ROLES.includes(u.role)),
  );
}
