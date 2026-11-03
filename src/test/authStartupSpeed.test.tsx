import { StrictMode, useState, type ReactNode } from 'react';
import { act, cleanup, render, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useAuthState } from '@/context/hooks/useAuthState';
import { useInitialLoad } from '@/context/hooks/useInitialLoad';
import { useMemberState } from '@/context/hooks/useMemberState';
import type { User } from '@/types';

type AuthReply = { data: { user: { id: string; email: string } | null }; error: Error | null };
type Reply = { data: unknown; error: Error | null };
const api = vi.hoisted(() => ({
  getUser: vi.fn<() => Promise<AuthReply>>(),
  signOut: vi.fn(async () => ({ error: null })),
  members: vi.fn<() => Promise<Reply>>(),
  tasks: vi.fn<() => Promise<Reply>>(),
  linked: new Map<string, string>(),
  lookupError: null as Error | null,
  lookupPending: null as Promise<{ data: { id: string } | null; error: Error | null }> | null,
  writeError: null as Error | null,
  lookups: vi.fn(),
  writes: vi.fn(),
  applyTheme: vi.fn(),
  error: vi.fn(),
}));
vi.mock('sonner', () => ({ toast: { error: api.error } }));
vi.mock('@/i18n', () => ({ default: { t: (key: string) => key } }));
vi.mock('@/lib/themes', () => ({ applyTheme: api.applyTheme }));
vi.mock('@/lib/commentQueries', () => ({ fetchComments: async (): Promise<{ data: unknown[]; error: null }> => ({ data: [], error: null }) }));
vi.mock('@/context/UIContext', () => ({ DEFAULT_REQUIRED_FIELDS: { title: true } }));
vi.mock('@/integrations/supabase/client', () => ({ USING_MOCK_BACKEND: false, supabase: {
  auth: { getUser: api.getUser, signOut: api.signOut },
  from: (table: string) => {
    let authId = '';
    let selected = '';
    const reply = table === 'members' ? api.members() : table === 'tasks' ? api.tasks() : Promise.resolve<Reply>({ data: [], error: null });
    const query = {
      then: reply.then.bind(reply),
      select: (columns: string) => { selected = columns; return query; },
      order: () => query,
      eq: (column: string, value: string) => { if (column === 'auth_id') authId = value; return query; },
      maybeSingle: async () => {
        if (table !== 'members' || selected !== 'id') return { data: null, error: null };
        api.lookups(authId);
        if (api.lookupPending) return api.lookupPending;
        const id = api.linked.get(authId);
        return { data: id ? { id } : null, error: api.lookupError };
      },
      update: (patch: unknown) => { api.writes(table, patch); return { eq: async (): Promise<Reply> => ({ data: null, error: api.writeError }) }; },
      insert: async (patch: unknown): Promise<{ error: null }> => { api.writes(table, patch); return { error: null }; },
    };
    return query;
  },
} }));

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
const row = (id = 'member-a', authId = 'auth-a', active = true, theme = 'dark') => ({
  id, auth_id: authId, name: 'Example Member', email: authId + '@example.com',
  avatar: 'E', color: '#667788', role: 'member', job_title: 'Engineer', is_active: active, sort_order: 0, theme,
});
const authReply = (id = 'auth-a'): AuthReply => ({ data: { user: { id, email: id + '@example.com' } }, error: null });
const users = (active = true): User[] => [{
  id: 'member-a', name: 'Example Member', email: 'auth-a@example.com', avatar: 'E', color: '#667788',
  role: 'member', jobTitle: 'Engineer', isActive: active, sortOrder: 0,
}];

function useStartup() {
  const member = useMemberState();
  const auth = useAuthState(member.users, member.usersLoaded);
  const [isLoading, setIsLoading] = useState(true);
  const initialLoad = useInitialLoad({
    setUsers: member.setUsers, readAuthUser: auth.readAuthUser,
    setStatuses: vi.fn(), setProductLines: vi.fn(), setAllProjects: vi.fn(), setTags: vi.fn(),
    setTaskSpecs: vi.fn(), setTaskChecks: vi.fn(), setTaskTodos: vi.fn(), setComments: vi.fn(),
    setStatusLogs: vi.fn(), setAllTasks: vi.fn(), setDeployMap: vi.fn(), setCustomFields: vi.fn(),
    setCustomFieldValues: vi.fn(), setTaskTemplates: vi.fn(), setTaskDependencies: vi.fn(),
    setUserThemeState: auth.setUserThemeState, setRequiredFields: vi.fn(),
    refreshFeatureToggles: async () => {}, setIsLoading, setSprintActive: vi.fn(), refreshSprints: async () => {},
  });
  return { ...auth, isLoading, usersLoaded: member.usersLoaded, loadFailed: initialLoad.loadFailed };
}

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  api.linked.clear();
  api.linked.set('auth-a', 'member-a');
  api.lookupError = null;
  api.lookupPending = null;
  api.writeError = null;
  api.getUser.mockResolvedValue(authReply());
  api.members.mockResolvedValue({ data: [row()], error: null });
  api.tasks.mockResolvedValue({ data: [], error: null });
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllEnvs(); });

describe('startup identity critical path', () => {
  it('keeps a rejected bulk read behind the startup failure gate after identity succeeds', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    let rejectBulk!: (error: Error) => void;
    api.tasks.mockReturnValue(new Promise<Reply>((_resolve, reject) => { rejectBulk = reject; }));
    const { result } = renderHook(() => useStartup());
    await waitFor(() => expect(result.current.memberVerified).toBe(true));
    expect(result.current.isLoading).toBe(true);
    await act(async () => { rejectBulk(new Error('Example task network failure')); });
    await waitFor(() => expect(result.current.loadFailed).toBe(true));
    expect(result.current.isLoading).toBe(false);
  });

  it('treats a resolved task read error as unknown data rather than a valid empty list', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    api.tasks.mockResolvedValue({ data: null, error: new Error('Example task read error') });
    const { result } = renderHook(() => useStartup());
    await waitFor(() => expect(result.current.loadFailed).toBe(true));
    expect(result.current.isLoading).toBe(false);
  });

  it('accepts successful empty required collections', async () => {
    const { result } = renderHook(() => useStartup());
    await waitFor(() => expect(result.current.memberVerified).toBe(true));
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.loadFailed).toBe(false);
  });

  it('allows a later explicit identity read after a resolved getUser failure', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    api.getUser.mockResolvedValueOnce({ data: { user: null }, error: new Error('Example temporary failure') })
      .mockResolvedValue(authReply());
    const { result } = renderHook(() => useAuthState([], false));
    await waitFor(() => expect(api.getUser).toHaveBeenCalledTimes(1));
    await act(async () => { await result.current.readAuthUser(); });
    expect(api.getUser).toHaveBeenCalledTimes(2);
    expect(result.current.memberVerified).toBe(false);
  });

  it('does not claim a Docker member by the same e-mail when auth_id is unlinked', async () => {
    api.linked.clear();
    const { result } = renderHook(() => useStartup());
    await waitFor(() => expect(api.signOut).toHaveBeenCalledTimes(1));
    expect(result.current.memberVerified).toBe(false);
    expect(api.writes).not.toHaveBeenCalled();
  });

  it('keeps a Docker auth_id link authoritative when the member e-mail differs', async () => {
    api.members.mockResolvedValue({ data: [{ ...row(), email: 'updated-member@example.com' }], error: null });
    const { result } = renderHook(() => useStartup());
    await waitFor(() => expect(result.current.memberVerified).toBe(true));
    expect(api.writes).not.toHaveBeenCalled();
    expect(api.signOut).not.toHaveBeenCalled();
  });

  it('does not verify a cloud self-link rejected by the server', async () => {
    vi.stubEnv('VITE_API_URL', 'https://api.example.com');
    vi.spyOn(console, 'error').mockImplementation(() => {});
    api.linked.clear();
    api.writeError = new Error('Example self-link denial');
    const { result } = renderHook(() => useStartup());
    await waitFor(() => expect(api.writes).toHaveBeenCalled());
    expect(result.current.memberVerified).toBe(false);
    expect(result.current.currentMemberId).toBe('');
  });

  it('does not publish an identity or theme when getUser reports an error', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    api.getUser.mockResolvedValue({ ...authReply(), error: new Error('Example identity failure') });
    const { result } = renderHook(() => useStartup());
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.memberVerified).toBe(false);
    expect(result.current.verificationFailed).toBe(true);
    expect(api.lookups).not.toHaveBeenCalled();
    expect(api.applyTheme).not.toHaveBeenCalled();
  });

  it('does not publish members or verify when the fresh member list fails', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    api.members.mockResolvedValue({ data: null, error: new Error('Example member list failure') });
    const { result } = renderHook(() => useStartup());
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.memberVerified).toBe(false);
    expect(result.current.usersLoaded).toBe(false);
    expect(api.lookups).not.toHaveBeenCalled();
    expect(api.writes).not.toHaveBeenCalled();
  });

  it('verifies using one shared identity read while slow bulk data remains loading', async () => {
    const bulk = deferred<Reply>();
    const identity = deferred<AuthReply>();
    const members = deferred<Reply>();
    api.tasks.mockReturnValue(bulk.promise);
    api.getUser.mockReturnValue(identity.promise);
    api.members.mockReturnValue(members.promise);
    const { result, rerender } = renderHook(() => useStartup());

    expect(api.getUser).toHaveBeenCalledTimes(1);
    expect(result.current.memberVerified).toBe(false);
    await act(async () => {
      identity.resolve(authReply());
      members.resolve({ data: [row()], error: null });
    });
    await waitFor(() => expect(result.current.memberVerified).toBe(true));
    expect(result.current.usersLoaded).toBe(true);
    expect(result.current.isLoading).toBe(true);
    expect(result.current.currentMemberId).toBe('member-a');
    expect(result.current.userTheme).toBe('dark');
    rerender();
    expect(api.getUser).toHaveBeenCalledTimes(1);
    expect(api.lookups).toHaveBeenCalledTimes(1);

    await act(async () => { bulk.resolve({ data: [], error: null }); });
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(api.getUser).toHaveBeenCalledTimes(1);
  });

  it('does not duplicate startup identity reads during StrictMode effect replay', async () => {
    const wrapper = ({ children }: { children: ReactNode }) => <StrictMode>{children}</StrictMode>;
    const { result } = renderHook(() => useStartup(), { wrapper });
    await waitFor(() => expect(result.current.memberVerified).toBe(true));
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(api.getUser).toHaveBeenCalledTimes(1);
    expect(api.lookups).toHaveBeenCalledTimes(1);
  });

  it('does not trust a persisted member id without a current authenticated user', async () => {
    localStorage.setItem('currentMemberId', 'member-a');
    api.getUser.mockResolvedValue({ data: { user: null }, error: null });
    const { result } = renderHook(() => useStartup());
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.memberVerified).toBe(false);
    expect(result.current.currentMemberId).toBe('');
    expect(result.current.verificationFailed).toBe(true);
    expect(api.lookups).not.toHaveBeenCalled();
  });

  it('fails closed on a membership lookup error without falling back to e-mail writes', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    api.lookupError = new Error('Example network failure');
    const { result } = renderHook(() => useStartup());
    await waitFor(() => expect(api.lookups).toHaveBeenCalled());
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.memberVerified).toBe(false);
    expect(api.writes).not.toHaveBeenCalled();
    expect(api.signOut).not.toHaveBeenCalled();
    expect(result.current.verificationFailed).toBe(true);
  });

  it('does not verify a disabled linked member', async () => {
    api.members.mockResolvedValue({ data: [row('member-a', 'auth-a', false)], error: null });
    const { result } = renderHook(() => useStartup());
    await waitFor(() => expect(api.signOut).toHaveBeenCalledTimes(1));
    expect(result.current.memberVerified).toBe(false);
    expect(result.current.currentMemberId).toBe('');
    expect(api.writes).not.toHaveBeenCalled();
  });

  it('does not verify a linked id absent from the fresh member read', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    api.members.mockResolvedValue({ data: [], error: null });
    const { result } = renderHook(() => useStartup());
    await waitFor(() => expect(api.lookups).toHaveBeenCalled());
    expect(result.current.memberVerified).toBe(false);
    expect(api.writes).not.toHaveBeenCalled();
  });

  it('does not publish identity or theme after unmount', async () => {
    const identity = deferred<AuthReply>();
    api.getUser.mockReturnValue(identity.promise);
    const view = renderHook(() => useStartup());
    view.unmount();
    await act(async () => { identity.resolve(authReply()); });
    expect(api.lookups).not.toHaveBeenCalled();
    expect(api.applyTheme).not.toHaveBeenCalled();
    expect(api.signOut).not.toHaveBeenCalled();
    expect(localStorage.getItem('currentMemberId')).toBeNull();
  });

  it('ignores account A resolving after a keyed account B mount', async () => {
    const oldIdentity = deferred<AuthReply>();
    const oldMembers = deferred<Reply>();
    let current: ReturnType<typeof useStartup> | undefined;
    let memberRead = 0;
    api.getUser.mockReturnValueOnce(oldIdentity.promise).mockResolvedValue(authReply('auth-b'));
    api.members.mockImplementation(() => {
      memberRead += 1;
      return memberRead === 1 ? oldMembers.promise : Promise.resolve({ data: [row('member-b', 'auth-b', true, 'light')], error: null });
    });
    api.linked.set('auth-b', 'member-b');
    function Harness(): null { current = useStartup(); return null; }
    const view = render(<Harness key="auth-a" />);
    view.rerender(<Harness key="auth-b" />);
    await waitFor(() => expect(current?.currentMemberId).toBe('member-b'));
    await act(async () => {
      oldIdentity.resolve(authReply());
      oldMembers.resolve({ data: [row('member-a', 'auth-a', false)], error: null });
    });
    expect(current?.currentMemberId).toBe('member-b');
    expect(current?.verificationFailed).toBe(false);
    expect(localStorage.getItem('currentMemberId')).toBe('member-b');
    expect(api.signOut).not.toHaveBeenCalled();
    expect(api.applyTheme).toHaveBeenLastCalledWith('light');
  });

  it('cancels a member lookup before it can sign out a later mounted account', async () => {
    const lookup = deferred<{ data: { id: string } | null; error: Error | null }>();
    api.lookupPending = lookup.promise;
    const view = renderHook(() => useAuthState(users(false), true));
    await waitFor(() => expect(api.lookups).toHaveBeenCalledTimes(1));
    view.unmount();
    await act(async () => { lookup.resolve({ data: { id: 'member-a' }, error: null }); });
    expect(api.signOut).not.toHaveBeenCalled();
    expect(api.writes).not.toHaveBeenCalled();
  });
});
