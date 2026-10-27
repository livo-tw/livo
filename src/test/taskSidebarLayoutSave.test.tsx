import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const state = vi.hoisted(() => ({ denied: true, success: vi.fn(), error: vi.fn() }));
vi.mock('@/i18n', () => ({ default: { t: (key: string) => key } }));
vi.mock('sonner', () => ({ toast: { success: state.success, error: state.error } }));
vi.mock('@/lib/activityLog', () => ({ logActivity: vi.fn() }));
vi.mock('@/integrations/supabase/client', () => ({ supabase: { from: () => ({
  select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { value: ['project', 'status'] }, error: null as null }) }) }),
  upsert: async () => ({ error: state.denied ? { message: 'Settings write denied' } : null }),
}) } }));
import { useTaskSidebarFields } from '@/components/task-detail/hooks/useTaskSidebarFields';
beforeEach(() => { vi.clearAllMocks(); state.denied = true; });
afterEach(cleanup);
it('retains the edited layout after failure and acknowledges success only after a successful retry', async () => {
  const { result } = renderHook(() => useTaskSidebarFields({ task: null, currentMemberId: 'member-example', users: [], tags: [], allTasks: [], setAllTasks: vi.fn(), setSelectedTask: vi.fn(), refreshTags: vi.fn(), getFieldLocker: () => undefined, trackPresence: vi.fn(), confirm: vi.fn() }));
  await act(async () => {});
  act(() => { result.current.setIsLayoutMode(true); result.current.setSidebarFieldOrder(['status', 'project']); });
  await act(async () => result.current.saveSidebarFieldOrder());
  expect(result.current.isLayoutMode).toBe(true); expect(result.current.layoutSaving).toBe(false);
  expect(result.current.sidebarFieldOrder).toEqual(['status', 'project']);
  expect(state.success).not.toHaveBeenCalled(); expect(state.error).toHaveBeenCalledWith('taskDetail.sidebar.layoutSaveFailed');
  state.denied = false; await act(async () => result.current.saveSidebarFieldOrder());
  expect(result.current.isLayoutMode).toBe(false); expect(state.success).toHaveBeenCalledWith('taskDetail.sidebar.layoutSaved');
});
