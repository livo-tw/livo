import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { useInitialLoad } from '@/context/hooks/useInitialLoad';
import { useTaskQueries } from '@/context/hooks/useTaskQueries';
import { useHighFreqSubs } from '@/context/hooks/useHighFreqSubs';
import type { Task } from '@/types';
const mediaApi=vi.hoisted(()=>({summary:vi.fn()}));
vi.mock('@/lib/taskCommentClient',()=>({taskCommentClient:{summary:mediaApi.summary}}));
type Reply = { data: unknown; error: unknown; count?: number };
type TaskChange = { eventType: 'INSERT' | 'UPDATE' | 'DELETE'; new?: object; old?: object };
interface Query extends PromiseLike<Reply> {
  select(columns: string, options?: { count?: string }): Query;
  order(...args: unknown[]): Query; eq(...args: unknown[]): Query; not(...args: unknown[]): Query;
  limit(size: number): Query; gt(column: string, cursor: string): Query; maybeSingle(): Promise<Reply>;
}
const api = vi.hoisted(() => ({ rpc: vi.fn(), from: vi.fn(), error: vi.fn(), publish: vi.fn(),
  cap: 250, total: 1001, includeCount: true, failLaterPage: false, includeMetadata: false,
  holdPage: false, releasePage: undefined as (() => void) | undefined,
  onTaskChange: undefined as ((payload: TaskChange) => void) | undefined,
  onMetadataChange: new Map<string, (payload: TaskChange) => void>(),
  cappedMetadata: false, failMetadataPage: false,
  rows: Array.from({ length: 1001 }, (_, index) => ({
    id: 'fixture-' + String(index + 1).padStart(4, '0'), task_key: 'EX-' + (index + 1), title: 'Example ' + (index + 1),
    project_id: 'fixture-project', status_id: 'fixture-status', creator_id: 'member-example',
    priority: 'medium', created_at: '2026-11-04T00:00:00Z',
  })),
}));
vi.mock('sonner', () => ({ toast: { error: api.error } }));
vi.mock('@/i18n', () => ({ default: { t: (key: string) => key } }));
vi.mock('@/integrations/supabase/client', () => ({ USING_MOCK_BACKEND: false, supabase: {
  channel: () => {
    const channel = {
      on: (_event: string, filter: { table: string }, handle: (payload: TaskChange) => void) => {
        if (filter.table === 'tasks') api.onTaskChange = handle;
        else api.onMetadataChange.set(filter.table, handle);
        return channel;
      },
      subscribe: () => channel,
    };
    return channel;
  },
  removeChannel: () => {},
  rpc: api.rpc, auth: { getUser: async (): Promise<{ data: { user: null } }> => ({ data: { user: null } }) }, from: (table: string) => {
  api.from(table);
  let count = false;
  let cursor = '';
  let limit = api.cap;
  const read = (): Reply => {
    if (table === 'tasks') {
      if (cursor && api.failLaterPage) return { data: null, error: { message: 'page unavailable' } };
      const rows = api.rows.slice(0, api.total);
      return { data: rows.filter(row => row.id > cursor).slice(0, limit), error: null,
        ...(count && api.includeCount ? { count: rows.length } : {}) };
    }
    if (api.cappedMetadata && (table === 'task_tags' || table === 'task_deployments')) {
      if (cursor && api.failMetadataPage) return { data: null, error: { message: 'Metadata page unavailable' } };
      const rows = api.rows.map(task => ({ id: 'meta-' + task.id, task_id: task.id, tag_id: 'tag-example', environment: 'Stage', status: 'deployed' }));
      const data = rows.filter(row => row.id > cursor).slice(0, limit);
      return { data, error: null, ...(count ? { count: rows.length } : {}) };
    }
    if (api.includeMetadata) {
      const task_id = 'fixture-0001';
      if (table === 'task_deployments') return { data: cursor ? [] : [{ id: 'deployment-1', task_id, environment: 'Stage', status: 'deployed' }], count: 1, error: null };
      if (table === 'task_attachments') return { data: cursor ? [] : [{ id: 'attachment-1', task_id }], count: 1, error: null };
      if (table === 'task_tags') return { data: cursor ? [] : [{ id: 'tag-link-1', task_id, tag_id: 'tag-1' }], count: 1, error: null };
    }
    const data = table === 'members' ? [{ id: 'member-example', name: 'Example Member', email: 'member@example.com',
      role: 'member', is_active: true, color: '#667788', avatar: 'E', job_title: 'Engineer', sort_order: 0 }] : [];
    return { data, error: null, ...(count ? { count: data.length } : {}) };
  };
  const query: Query = {
    then: (resolve, reject) => {
      if (table === 'tasks' && cursor && api.holdPage) {
        api.holdPage = false;
        return new Promise<Reply>(release => { api.releasePage = () => release(read()); }).then(resolve, reject);
      }
      return Promise.resolve(read()).then(resolve, reject);
    },
    select: (_columns, options) => { count = options?.count === 'exact'; return query; },
    order: () => query, eq: () => query, not: () => query,
    limit: size => { limit = Math.min(size, api.cap); return query; },
    gt: (_column, id) => { cursor = id; return query; },
    maybeSingle: async () => ({ data: null, error: null }),
  };
  return query;
} } }));
vi.mock('@/lib/commentQueries', () => ({ fetchComments: async (): Promise<{ data: unknown[]; error: null }> => ({ data: [], error: null }) }));
vi.mock('@/lib/themes', () => ({ applyTheme: vi.fn() }));
vi.mock('@/context/UIContext', () => ({ DEFAULT_REQUIRED_FIELDS: { title: true, project: true } }));
const dependencies = (): Parameters<typeof useInitialLoad>[0] => ({
  setUsers: vi.fn(), setStatuses: vi.fn(), setProductLines: vi.fn(), setAllProjects: vi.fn(), setTags: vi.fn(), setTaskSpecs: vi.fn(), setTaskChecks: vi.fn(), setTaskTodos: vi.fn(), setComments: vi.fn(), setStatusLogs: vi.fn(), beginBoardRead: () => ({ isCurrent: () => true, publish: api.publish, close: vi.fn() }), setCustomFields: vi.fn(), setCustomFieldValues: vi.fn(), setTaskTemplates: vi.fn(), setTaskDependencies: vi.fn(), setUserThemeState: vi.fn(), setRequiredFields: vi.fn(), refreshFeatureToggles: vi.fn(async () => {}), setIsLoading: vi.fn(), setSprintActive: vi.fn(), refreshSprints: vi.fn(async () => {}),
});
beforeEach(() => {
  api.cap = 250; api.total = 1001; api.includeCount = true; api.failLaterPage = false; api.includeMetadata = false;
  api.holdPage = false; api.releasePage = undefined; api.onTaskChange = undefined;
  api.cappedMetadata = false; api.failMetadataPage = false; api.onMetadataChange.clear();
  api.rpc.mockClear(); api.from.mockClear(); api.error.mockClear(); api.publish.mockClear();
  mediaApi.summary.mockImplementation(async(ids:string[])=>({workspaceId:'default',actorId:'member-example',counts:Object.fromEntries(ids.map(id=>[id,api.includeMetadata&&id==='fixture-0001'?1:0])),commentCounts:{},storageUsedBytes:0,storageUsageSource:'task_attachment_accounting'}));
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });
const taskRequests = () => api.from.mock.calls.filter(([table]) => table === 'tasks');

describe('board task pagination', () => {
  it('loads all tasks on startup even when the API caps pages below the requested size', async () => {
    const deps = dependencies();
    const { result } = renderHook(() => useInitialLoad(deps));
    await waitFor(() => expect(deps.setIsLoading).toHaveBeenLastCalledWith(false));
    const saved = (api.publish.mock.calls.at(-1)?.[0] as Task[] | undefined);
    expect(saved).toHaveLength(1001);
    expect(saved?.at(-1)?.id).toBe('fixture-1001');
    expect(result.current.loadFailed).toBe(false);
    expect(taskRequests()).toHaveLength(6);
  });

  it('continues through a short page when the API supplies no total count', async () => {
    api.includeCount = false;
    const { result } = renderHook(() => useTaskQueries());
    await act(async () => { await result.current.refreshTasks(); });
    expect(result.current.allTasks).toHaveLength(1001);
    expect(result.current.allTasks.at(-1)?.id).toBe('fixture-1001');
  });

  it('does not replace the last complete snapshot when a later page fails', async () => {
    api.failLaterPage = true;
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { result } = renderHook(() => useTaskQueries());
    const prior = [{ id: 'old-card', title: 'Previous snapshot' } as Task];
    act(() => result.current.setAllTasks(prior));
    await act(async () => { await result.current.refreshTasks(); });
    expect(result.current.allTasks).toEqual(prior);
    expect(error).toHaveBeenCalledWith('[LIVO] refreshTasks skipped:', { message: 'page unavailable' });
  });

  it('keeps live inserts, latest edits and deletes during pagination with complete fetched metadata', async () => {
    const { result } = renderHook(() => {
      const tasks = useTaskQueries();
      useHighFreqSubs({ ...tasks, setSelectedTask: vi.fn() });
      return tasks;
    });
    const originalRows = api.rows;
    try {
      await act(async () => { await result.current.refreshTasks(); });
      const [edited, deleted, unseen] = originalRows;
      // The backend still holds a row this client has not loaded yet.
      act(() => result.current.setAllTasks(rows => rows.filter(row => row.id !== unseen.id)));
      api.holdPage = true;
      api.includeMetadata = true;
      const refresh = result.current.refreshTasks();
      await waitFor(() => expect(api.releasePage).toBeTypeOf('function'));

      const inserted = { ...edited, id: 'fixture-0000', title: 'New live card' };
      const editedAgain = { ...edited, title: 'Latest live edit' };
      const insertedAgain = { ...inserted, title: 'New live card edited' };
      api.rows = [insertedAgain, editedAgain, ...originalRows.slice(3)];
      api.total = api.rows.length;
      act(() => {
        api.onTaskChange?.({ eventType: 'UPDATE', new: { ...edited, title: 'First live edit' } });
        api.onTaskChange?.({ eventType: 'UPDATE', new: editedAgain });
        api.onTaskChange?.({ eventType: 'INSERT', new: inserted });
        api.onTaskChange?.({ eventType: 'UPDATE', new: insertedAgain });
        api.onTaskChange?.({ eventType: 'DELETE', old: { id: deleted.id } });
        api.onTaskChange?.({ eventType: 'DELETE', old: { id: unseen.id } });
      });

      await act(async () => { api.releasePage?.(); await refresh; });
      expect(result.current.allTasks).toHaveLength(1000);
      expect(result.current.allTasks.find(row => row.id === edited.id)).toMatchObject({
        title: 'Latest live edit', attachmentCount: 1, tagIds: ['tag-1'],
        deployments: [{ environment: 'Stage', status: 'deployed' }],
      });
      expect(result.current.allTasks.find(row => row.id === inserted.id)?.title).toBe('New live card edited');
      expect(result.current.allTasks.some(row => row.id === deleted.id || row.id === unseen.id)).toBe(false);
      expect(result.current.allTasks.at(-2)?.id).toBe('fixture-1001');
    } finally { api.rows = originalRows; }
  });

  it('keeps live task events during startup before the first board snapshot is published', async () => {
    const deps = dependencies();
    const originalRows = api.rows;
    const [edited, deleted] = originalRows;
    api.holdPage = true;
    try {
      const { result } = renderHook(() => {
        const tasks = useTaskQueries();
        const startup = useInitialLoad({ ...deps, beginBoardRead: tasks.beginBoardRead });
        useHighFreqSubs({ ...tasks, setSelectedTask: vi.fn() });
        return { tasks, startup };
      });
      await waitFor(() => expect(api.releasePage).toBeTypeOf('function'));
      const inserted = { ...edited, id: 'fixture-0000', title: 'New task during startup' };
      const newer = { ...edited, title: 'Live title during startup' };
      api.rows = [inserted, newer, ...originalRows.slice(2)];
      api.total = api.rows.length;
      act(() => {
        api.onTaskChange?.({ eventType: 'INSERT', new: inserted });
        api.onTaskChange?.({ eventType: 'UPDATE', new: newer });
        api.onTaskChange?.({ eventType: 'DELETE', old: { id: deleted.id } });
      });
      await act(async () => { api.releasePage?.(); });
      await waitFor(() => expect(deps.setIsLoading).toHaveBeenLastCalledWith(false));
      expect(result.current.startup.loadFailed).toBe(false);
      expect(result.current.tasks.allTasks).toHaveLength(1001);
      expect(result.current.tasks.allTasks.find(row => row.id === edited.id)?.title).toBe(newer.title);
      expect(result.current.tasks.allTasks.some(row => row.id === deleted.id)).toBe(false);
      expect(result.current.tasks.allTasks.some(row => row.id === inserted.id)).toBe(true);
    } finally { api.rows = originalRows; }
  });

  it('does not replace a newer complete refresh when an overlapping startup read finishes later', async () => {
    const deps = dependencies();
    const originalRows = api.rows;
    const first = originalRows[0];
    api.holdPage = true;
    try {
      const { result } = renderHook(() => {
        const tasks = useTaskQueries();
        useInitialLoad({ ...deps, beginBoardRead: tasks.beginBoardRead });
        return tasks;
      });
      await waitFor(() => expect(api.releasePage).toBeTypeOf('function'));
      const newer = { ...first, title: 'Title from the newer full refresh' };
      api.rows = [newer, ...originalRows.slice(1)];
      await act(async () => { await result.current.refreshTasks(); });
      expect(result.current.allTasks[0].title).toBe(newer.title);

      await act(async () => { api.releasePage?.(); });
      await waitFor(() => expect(deps.setIsLoading).toHaveBeenLastCalledWith(false));
      expect(result.current.allTasks[0].title).toBe(newer.title);
    } finally { api.rows = originalRows; }
  });

  it('pages debounced live deployment and tag reads and retains complete metadata on a page error', async () => {
    api.cappedMetadata = true;
    vi.useFakeTimers();
    try {
      const { result } = renderHook(() => {
        const tasks = useTaskQueries();
        useHighFreqSubs({ ...tasks, setSelectedTask: vi.fn() });
        return tasks;
      });
      const tail = () => result.current.allTasks.find(task => task.id === 'fixture-1001');
      const metadata = { tagIds: ['tag-example'], deployments: [{ environment: 'Stage', status: 'deployed' }] };
      await act(async () => { await result.current.refreshTasks(); });
      expect(tail()).toMatchObject(metadata);

      const emitChanges = () => {
        api.onMetadataChange.get('task_tags')?.({ eventType: 'INSERT' });
        api.onMetadataChange.get('task_deployments')?.({ eventType: 'UPDATE' });
      };
      act(emitChanges);
      await act(async () => { await vi.advanceTimersByTimeAsync(501); });
      expect(result.current.allTasks).toHaveLength(1001);
      expect(tail()).toMatchObject(metadata);

      api.failMetadataPage = true;
      act(emitChanges);
      await act(async () => { await vi.advanceTimersByTimeAsync(501); });
      expect(tail()).toMatchObject(metadata);
    } finally { vi.useRealTimers(); }
  });

  it('completes a small board in one request when the total is known', async () => {
    api.total = 40;
    const { result } = renderHook(() => useTaskQueries());
    await act(async () => { await result.current.refreshTasks(); });
    expect(result.current.allTasks).toHaveLength(40);
    expect(taskRequests()).toHaveLength(1);
  });
  it('keeps tasks available and preserves the last numeric count when a fresh private summary fails',async()=>{
    api.total=40;api.includeMetadata=true;
    const {result}=renderHook(()=>useTaskQueries());
    await act(async()=>{await result.current.refreshTasks();});
    expect(result.current.allTasks[0]).toMatchObject({attachmentCount:1,attachmentSummaryKnown:true});
    mediaApi.summary.mockRejectedValue(new Error('summary unavailable'));api.includeMetadata=false;
    await act(async()=>{await result.current.refreshTasks();});
    expect(result.current.allTasks).toHaveLength(40);
    expect(result.current.allTasks[0]).toMatchObject({attachmentCount:1,attachmentSummaryKnown:false});
  });

});
