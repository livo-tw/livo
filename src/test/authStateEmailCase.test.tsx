import { renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useAuthState } from '@/context/hooks/useAuthState';
import type { User } from '@/types';

const state = vi.hoisted(() => ({
  linkedMemberId: null as string | null,
  updates: [] as Array<{ patch: unknown; id: unknown }>,
  signOut: vi.fn(), error: vi.fn(),
}));
vi.mock('sonner', () => ({ toast: { error: state.error, success: vi.fn() } }));
vi.mock('@/i18n', () => ({ default: { t: (key: string) => key } }));
vi.mock('@/integrations/supabase/client', () => ({ supabase: {
  auth: {
    getUser: async () => ({ data: { user: { id: 'auth-1', email: 'sam@example.com' } } }),
    signOut: state.signOut,
  },
  from: () => ({
    select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: state.linkedMemberId ? { id: state.linkedMemberId } : null }) }) }),
    update: (patch: unknown) => ({ eq: async (_col: string, id: unknown) => { state.updates.push({ patch, id }); return { error: null as null }; } }),
    insert: async () => ({ error: null as null }),
  }),
} }));

const member = (email: string): User => ({ id: 'm-sam', name: 'Sam', avatar: 'S', color: '#000000', role: 'member', isActive: true, email } as User);

beforeEach(() => { state.linkedMemberId = null; state.updates = []; vi.clearAllMocks(); });

describe('linking a login to its member', () => {
  // GoTrue keeps e-mails lower-case. A member saved as "Sam@Example.com" was
  // unlinked on every sign-in by a case-sensitive compare and then never matched.
  it('keeps the link when the member e-mail differs only in case', async () => {
    state.linkedMemberId = 'm-sam';
    const { result } = renderHook(() => useAuthState([member('Sam@Example.com')], true));
    await waitFor(() => expect(result.current.memberVerified).toBe(true));
    expect(result.current.currentMemberId).toBe('m-sam');
    expect(state.updates).toEqual([]);
    expect(state.signOut).not.toHaveBeenCalled();
  });
  it('matches an unlinked member by e-mail without case', async () => {
    const { result } = renderHook(() => useAuthState([member('SAM@example.com')], true));
    await waitFor(() => expect(result.current.memberVerified).toBe(true));
    expect(result.current.currentMemberId).toBe('m-sam');
    expect(state.signOut).not.toHaveBeenCalled();
  });
});
