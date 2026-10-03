import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Task, Status, Project } from '@/types';
import { useTaskStatusChange, type UseTaskStatusChangeParams } from '@/components/task-detail/hooks/useTaskStatusChange';
import { useBoardApproval } from '@/components/board/useBoardApproval';

const state = vi.hoisted(() => ({ approvalsEnabled: false, featureTogglesReady: true }));
vi.mock('@/context/UIContext', () => ({ useUIContext: () => state }));
vi.mock('@/integrations/supabase/client', () => ({ supabase: { from: vi.fn() } }));
vi.mock('@/lib/slackNotify', () => ({ sendSlackNotify: vi.fn().mockResolvedValue(undefined) }));
vi.mock('@/components/task-detail/utils', () => ({ createNotification: vi.fn() }));
vi.mock('@/i18n', () => ({ default: { t: (key: string) => key } }));
vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }));

function params(requiresApproval = true): UseTaskStatusChangeParams {
  return {
    task: { id: 'task-1', taskKey: 'EX-1', title: 'Example task', statusId: 'todo', projectId: 'project-1', requiresApproval } as Task,
    project: { id: 'project-1', name: 'Example project' } as Project,
    statuses: [{ id: 'todo', name: 'Todo' }, { id: 'done', name: 'Done', isDone: true }] as Status[],
    statusLogs: [], users: [], currentMemberId: 'member-1', currentMember: null, assignee: undefined,
    updateTask: vi.fn(), setAllTasks: vi.fn(), setSelectedTask: vi.fn(),
    canTransitionTo: vi.fn(() => ({ allowed: true, missingStatusIds: [] })),
    triggerNotification: vi.fn(),
    getRuleForTransition: vi.fn(async () => ({ rule: { id: 'rule-1' } })),
    requestApproval: vi.fn(async () => ({ id: 'request-1' })),
  };
}

describe('status changes respect team approval switches', () => {
  beforeEach(() => { state.approvalsEnabled = false; state.featureTogglesReady = true; });
  it.each([true, false])('bypasses mandatory and advisory interception when OFF (task flag %s)', async requiresApproval => {
    const dependencies = params(requiresApproval);
    const { result } = renderHook(() => useTaskStatusChange(dependencies));
    await act(async () => { await result.current.handleStatusChange('done'); });
    expect(dependencies.updateTask).toHaveBeenCalledWith(expect.objectContaining({ statusId: 'done' }));
    expect(dependencies.getRuleForTransition).not.toHaveBeenCalled();
    expect(dependencies.requestApproval).not.toHaveBeenCalled();
    expect(result.current.approvalConfirmState).toBeNull();
    expect(result.current.advisoryState).toBeNull();
  });
  it('still intercepts and submits mandatory approvals when ON', async () => {
    state.approvalsEnabled = true;
    const dependencies = params();
    const { result } = renderHook(() => useTaskStatusChange(dependencies));
    await act(async () => { await result.current.handleStatusChange('done'); });
    expect(dependencies.updateTask).not.toHaveBeenCalled();
    expect(result.current.approvalConfirmState?.toStatusId).toBe('done');
    await act(async () => { await result.current.handleApprovalConfirm(); });
    expect(dependencies.requestApproval).toHaveBeenCalledWith('task-1', 'rule-1', 'todo', 'done', dependencies.task);
  });
  it('still shows the advisory dialog when ON', async () => {
    state.approvalsEnabled = true;
    const dependencies = params(false);
    const { result } = renderHook(() => useTaskStatusChange(dependencies));
    await act(async () => { await result.current.handleStatusChange('done'); });
    expect(result.current.advisoryState?.ruleId).toBe('rule-1');
    expect(dependencies.updateTask).not.toHaveBeenCalled();
  });
  it('closes an open confirmation after a live OFF update', async () => {
    state.approvalsEnabled = true;
    const dependencies = params();
    const { result, rerender } = renderHook(() => useTaskStatusChange(dependencies));
    await act(async () => { await result.current.handleStatusChange('done'); });
    state.approvalsEnabled = false;
    rerender();
    expect(result.current.approvalConfirmState).toBeNull();
    await act(async () => { await result.current.handleApprovalConfirm(); });
    expect(dependencies.requestApproval).not.toHaveBeenCalled();
  });
  it('does not bypass approvals while settings have not loaded', async () => {
    state.featureTogglesReady = false;
    const dependencies = params();
    const { result } = renderHook(() => useTaskStatusChange(dependencies));
    await act(async () => { await result.current.handleStatusChange('done'); });
    expect(dependencies.updateTask).not.toHaveBeenCalled();
  });
  it('blocks stale board approval actions when OFF', async () => {
    const dependencies = params();
    const { result } = renderHook(() => useBoardApproval({
      ...dependencies, requestApproval: vi.fn(async () => null), allTasks: [dependencies.task], updateTaskInDb: vi.fn(), t: key => key,
    }));
    const payload = { taskId: 'task-1', fromStatusId: 'todo', toStatusId: 'done', projectId: 'project-1', toStatusName: 'Done' };
    await act(async () => {
      await result.current.handleApprovalSubmit(payload);
      await result.current.handleMandatoryApproval(payload);
    });
    expect(dependencies.requestApproval).not.toHaveBeenCalled();
    expect(dependencies.getRuleForTransition).not.toHaveBeenCalled();
  });
  it('does not enable the requirement or show pending after a failed advisory submit', async () => {
    state.approvalsEnabled = true;
    const dependencies = params(false);
    dependencies.requestApproval = vi.fn(async () => null);
    const {result} = renderHook(() => useTaskStatusChange(dependencies));
    await act(async () => {await result.current.handleStatusChange('done');});
    await act(async () => {await result.current.handleAdvisorySubmitApproval();});
    expect(dependencies.requestApproval).toHaveBeenCalledWith('task-1','rule-1','todo','done',dependencies.task,true);
    expect(dependencies.setAllTasks).not.toHaveBeenCalled();
    expect(dependencies.setSelectedTask).not.toHaveBeenCalled();
    expect(dependencies.updateTask).not.toHaveBeenCalled();
  });

});
