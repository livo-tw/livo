import { act, renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { Project, Task, User } from '@/types';
import { useTaskActions, type UseTaskActionsParams } from '@/components/task-detail/hooks/useTaskActions';
import { sendSlackNotify } from '@/lib/slackNotify';
import { logActivity } from '@/lib/activityLog';
import { createNotification } from '@/components/task-detail/utils';

vi.mock('@/integrations/supabase/client', () => ({ supabase: { from: vi.fn() } }));
vi.mock('@/lib/slackNotify', () => ({ sendSlackNotify: vi.fn().mockResolvedValue(undefined) }));
vi.mock('@/lib/activityLog', () => ({ logActivity: vi.fn() }));
vi.mock('@/components/task-detail/utils', () => ({ createNotification: vi.fn() }));
vi.mock('@/i18n', () => ({ default: { t: (key: string) => key } }));
vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }));

describe('web Slack notices for assignment changes', () => {
  it('waits for the task save, because slack-notify reads the recipients from the stored task', async () => {
    let save!: () => void;
    const updateTaskInDb = vi.fn(() => new Promise<void>(resolve => { save = resolve; }));
    const users = [{ id: 'actor', name: 'Example actor', email: 'actor@example.com' }, { id: 'next', name: 'Example next', email: 'next@example.com' }] as User[];
    const params = {
      task: { id: 'task-1', taskKey: 'EX-1', title: 'Example', statusId: 'todo', projectId: 'p', priority: 'medium', assigneeId: 'actor' } as Task,
      project: { id: 'p', name: 'Example project' } as Project, statuses: [], users, allProjects: [], currentMemberId: 'actor', currentMember: users[0],
      status: undefined, assignee: users[0], setAllTasks: vi.fn(), setSelectedTask: vi.fn(), updateTaskInDb,
    } as unknown as UseTaskActionsParams;
    const { result } = renderHook(() => useTaskActions(params));
    act(() => { void result.current.updateTask({ assigneeId: 'next' }); });
    await Promise.resolve();
    expect(updateTaskInDb).toHaveBeenCalledOnce();
    expect(sendSlackNotify).not.toHaveBeenCalled();
    await act(async () => { save(); await Promise.resolve(); });
    expect(sendSlackNotify).toHaveBeenCalledWith(expect.objectContaining({ type: 'assignee_changed', taskId: 'task-1',
      dmTargets: [expect.objectContaining({ email: 'next@example.com' })] }));
  });

  it('logs and notifies nothing when the save is refused', async () => {
    vi.clearAllMocks();
    let save!: (ok: boolean) => void;
    const updateTaskInDb = vi.fn(() => new Promise<boolean>(resolve => { save = resolve; }));
    const users = [{ id: 'actor', name: 'Example actor', email: 'actor@example.com' }, { id: 'next', name: 'Example next', email: 'next@example.com' }] as User[];
    const params = {
      task: { id: 'task-1', taskKey: 'EX-1', title: 'Example', statusId: 'todo', projectId: 'p', priority: 'medium', assigneeId: 'actor' } as Task,
      project: { id: 'p', name: 'Example project' } as Project, statuses: [], users, allProjects: [], currentMemberId: 'actor', currentMember: users[0],
      status: undefined, assignee: users[0], setAllTasks: vi.fn(), setSelectedTask: vi.fn(), updateTaskInDb,
    } as unknown as UseTaskActionsParams;
    const { result } = renderHook(() => useTaskActions(params));
    act(() => { void result.current.updateTask({ assigneeId: 'next', title: 'Renamed' }); });
    await act(async () => { save(false); await Promise.resolve(); });
    expect(logActivity).not.toHaveBeenCalled();
    expect(createNotification).not.toHaveBeenCalled();
    expect(sendSlackNotify).not.toHaveBeenCalled();

    act(() => { void result.current.updateTask({ assigneeId: 'next', title: 'Renamed' }); });
    expect(logActivity).not.toHaveBeenCalled();
    await act(async () => { save(true); await Promise.resolve(); });
    expect(logActivity).toHaveBeenCalledWith('actor', 'update_title', expect.any(String), 'task-1', 'EX-1');
    expect(createNotification).toHaveBeenCalledWith('next', 'actor', 'assign', 'task-1', 'Example');
    expect(sendSlackNotify).toHaveBeenCalledOnce();
  });
});
