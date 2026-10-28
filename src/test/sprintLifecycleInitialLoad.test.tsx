import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, renderHook, waitFor } from '@testing-library/react';
import { useInitialLoad } from '@/context/hooks/useInitialLoad';
type Reply = { data: unknown; error: unknown };
interface Query extends PromiseLike<Reply> { select(...args: unknown[]): Query; order(...args: unknown[]): Query; eq(...args: unknown[]): Query; limit(...args: unknown[]): Query; maybeSingle(): Promise<Reply>; insert(...args: unknown[]): Query }
const api = vi.hoisted(() => ({ writes: [] as { table: string; operation: string }[], rpc: vi.fn(), from: vi.fn(), error: vi.fn() }));
vi.mock('sonner', () => ({ toast: { error: api.error } }));
vi.mock('@/i18n', () => ({ default: { t: (key: string) => key } }));
vi.mock('@/integrations/supabase/client', () => ({ supabase: { rpc: api.rpc, auth: { getUser: async (): Promise<{ data: { user: null } }> => ({ data: { user: null } }) }, from: (table: string) => {
  api.from(table);
  const response = Promise.resolve({ data: table === 'members' ? [{ id: 'member-example', name: 'Example Member', email: 'member@example.com', role: 'member', is_active: true, color: '#667788', avatar: 'E', job_title: 'Engineer', sort_order: 0 }] : [], error: null });
  const query: Query = { then: (resolve, reject) => response.then(resolve, reject), select: () => query, order: () => query, eq: () => query, limit: () => query, maybeSingle: async () => ({ data: null, error: null }), insert: () => { api.writes.push({ table, operation: 'insert' }); return query; } };
  return query;
} } }));
vi.mock('@/lib/commentQueries', () => ({ fetchComments: async (): Promise<{ data: unknown[]; error: null }> => ({ data: [], error: null }) }));
vi.mock('@/lib/themes', () => ({ applyTheme: vi.fn() }));
vi.mock('@/context/UIContext', () => ({ DEFAULT_REQUIRED_FIELDS: { title: true, project: true } }));
const dependencies = (): Parameters<typeof useInitialLoad>[0] => ({
  setUsers: vi.fn(), setStatuses: vi.fn(), setProductLines: vi.fn(), setAllProjects: vi.fn(), setTags: vi.fn(), setTaskSpecs: vi.fn(), setTaskChecks: vi.fn(), setTaskTodos: vi.fn(), setComments: vi.fn(), setStatusLogs: vi.fn(), setAllTasks: vi.fn(), setDeployMap: vi.fn(), setCustomFields: vi.fn(), setCustomFieldValues: vi.fn(), setTaskTemplates: vi.fn(), setTaskDependencies: vi.fn(), setUserThemeState: vi.fn(), setRequiredFields: vi.fn(), refreshFeatureToggles: vi.fn(async () => {}), setIsLoading: vi.fn(), setSprintActive: vi.fn(), refreshSprints: vi.fn(async () => {}),
});
beforeEach(() => { api.writes.length = 0; api.rpc.mockClear(); api.from.mockClear(); api.error.mockClear(); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); });
describe('sprint lifecycle initial load is read-only', () => {
  it('reports a failed sprint read without creating a replacement sprint or enabling an unknown active state', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const deps = dependencies();
    deps.refreshSprints = vi.fn(async () => { throw new Error('example unavailable'); });
    renderHook(() => useInitialLoad(deps));
    await waitFor(() => expect(deps.setIsLoading).toHaveBeenLastCalledWith(false));
    expect(api.error).toHaveBeenCalledWith('sprint.refreshFailed');
    expect(deps.setSprintActive).not.toHaveBeenCalledWith(true);
    expect(api.writes).toEqual([]);
    expect(api.rpc).not.toHaveBeenCalled();
  });
  it('keeps a no-active-sprint read inactive without creating a sprint or issuing a lifecycle command, including rerender', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const deps = dependencies();
    const refresh = vi.fn(async () => { deps.setSprintActive(false); }); deps.refreshSprints = refresh;
    const view = renderHook(() => useInitialLoad(deps));
    await waitFor(() => expect(deps.setIsLoading).toHaveBeenLastCalledWith(false));
    expect(error).not.toHaveBeenCalled();
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(refresh).toHaveBeenCalledWith();
    expect(deps.setSprintActive).not.toHaveBeenCalledWith(true);
    expect(api.writes.filter(write => write.table === 'sprints')).toEqual([]);
    expect(api.rpc).not.toHaveBeenCalled();
    view.rerender();
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(api.writes).toEqual([]);
  });
});
