import { useCallback, useRef } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { toast } from 'sonner';
import i18n from '@/i18n';
import { getDepartment } from '@/lib/department';
import type { Task, Status, StatusLog, User, Project } from '@/types';
import { randomUUID } from '@/lib/generateId';
import { deadlineTaskFields, planningErrorCode, setTaskDeadline } from '@/lib/taskPlanning/client';
import { createTaskWorkCommandRunner, taskWorkErrorCode } from '@/lib/taskWork/client';
import { subtaskQuickCreateFields, type SubtaskRequiredFields, type SubtaskCreateValues } from '@/lib/taskWork/subtaskDefaults';
import { mapTask, type TaskRow } from '@/context/mappers';
import { taskWriteErrorText } from '@/lib/approval/feedback';
import type { TaskContextType, TaskStatusSnapshot } from '../TaskContext';

interface TaskCRUDDeps {
  allTasks: Task[];
  statuses: Status[];
  setAllTasks: React.Dispatch<React.SetStateAction<Task[]>>;
  refreshTasks: () => Promise<void>;
  appendStatusLog: (log: StatusLog) => void;
}

export function useTaskCRUD({
  allTasks, statuses, setAllTasks, refreshTasks, appendStatusLog,
}: TaskCRUDDeps) {
  const allTasksRef = useRef(allTasks);
  allTasksRef.current = allTasks;
  const subtaskRunners = useRef(new Map<string, ReturnType<typeof createTaskWorkCommandRunner>>());
  const subtaskActor = useRef('');

  const createTaskInDb = useCallback<TaskContextType['createTaskInDb']>(async (task, { recovering, isCurrent }) => {
    // Undefined means the exact row could not be verified. Null means this read found no row.
    const readStoredKey = async (): Promise<string | null | undefined> => {
      try {
        const { data, error } = await supabase.from('tasks').select('id,task_key,creator_id').eq('id', task.id).maybeSingle();
        if (error) return undefined;
        if (!data) return null;
        if (data.id === task.id && data.creator_id === task.creatorId && data.task_key) return data.task_key;
      } catch { /* A failed read cannot settle the result of an earlier insert. */ }
    };
    const acknowledge = (storedKey: string | null | undefined) => {
      if (!isCurrent()) return null;
      const created = storedKey && storedKey !== task.taskKey ? { ...task, taskKey: storedKey } : task;
      setAllTasks(prev => {
        if (!prev.some(row => row.id === task.id)) return [...prev, created];
        if (!storedKey) return prev;
        return prev.map(row => row.id === task.id && row.taskKey !== storedKey ? { ...row, taskKey: storedKey } : row);
      });
      return created;
    };
    if (recovering) {
      const storedKey = await readStoredKey();
      if (!isCurrent()) return null;
      if (storedKey === undefined) throw new Error('task_create_unconfirmed');
      if (storedKey !== null) return acknowledge(storedKey);
    }

    let inserted: { error: { message: string; code?: string } | null } | undefined;
    try {
      inserted = await supabase.from('tasks').insert({
        id: task.id,
        task_key: task.taskKey,
        project_id: task.projectId,
        title: task.title,
        status_id: task.statusId,
        priority: task.priority,
        creator_id: task.creatorId,
        assignee_id: task.assigneeId || null,
        reviewer_id: task.reviewerId || null,
        due_date: task.dueDate || null,
        due_date_kind: task.dueDate ? task.dueDateKind ?? null : null,
        started_at: task.startedAt || null,
        completed_at: task.completedAt || null,
        gitlab_url: task.gitlabUrl || null,
        sort_order: task.sortOrder,
        created_at: task.createdAt,
        comment_count: task.commentCount,
        sprint_id: task.sprintId || null,
        parent_task_id: task.parentTaskId || null,
      } as Record<string, unknown>);
    } catch { /* Transport failure may occur after the row was committed. */ }
    if (!isCurrent()) return null;

    const error = inserted?.error;
    const sprintConflict = error?.message.includes('sprint_conflict');
    if (!recovering && sprintConflict) throw new Error('sprint_conflict');
    const storedKey = await readStoredKey();
    if (!isCurrent()) return null;
    if (storedKey || (!recovering && inserted && !error)) return acknowledge(storedKey);

    // An inactive sprint cannot accept an earlier request after this rejection.
    // Only offer to reselect after an exact read also confirms the task is absent.
    if (recovering && sprintConflict && storedKey === null) throw new Error('sprint_conflict');

    // Other rejections cannot disprove an earlier attempt whose response was lost.
    if (!recovering && error && (
      /^(?:(?:22|23|28|42)[A-Z0-9]{3}|PT4\d{2})$/.test(error.code ?? '') ||
      /\b(?:FOREIGN KEY|NOT NULL|CHECK) constraint failed\b/i.test(error.message)
    )) {
      toast.error(i18n.t('task.createFailed') + error.message);
      await refreshTasks().catch(() => {});
      return null;
    }
    throw new Error('task_create_unconfirmed');
  }, [refreshTasks, setAllTasks]);

  const createUpdateTaskInDb = useCallback(
    (
      currentMemberId: string,
      users: User[],
      setSelectedTask: (fn: (prev: Task | null) => Task | null) => void,
    ) =>
      // Resolves true once the task row (and any deployments) is saved, false when the
      // save was refused or failed; callers gate notifications on it.
      async (taskId: string, updates: Partial<Task>, expectedStatus?: TaskStatusSnapshot): Promise<boolean> => {
        if (expectedStatus && (!updates.statusId || Object.keys(updates).some(key => !['statusId', 'startedAt', 'completedAt'].includes(key)))) return false;
        const dbUpdates: Record<string, string | number | boolean | null | undefined> = {};
        if ('statusId' in updates) {
          dbUpdates.status_id = updates.statusId;
          const oldTask = allTasksRef.current.find(t => t.id === taskId);
          const newIsDone = statuses.find(s => s.id === updates.statusId)?.isDone ?? false;
          const oldIsDone = statuses.find(s => s.id === (expectedStatus?.statusId ?? oldTask?.statusId))?.isDone ?? false;
          if (!('completedAt' in updates)) {
            if (newIsDone && !oldIsDone) {
              const now = new Date().toISOString();
              dbUpdates.completed_at = now;
              updates.completedAt = now;
            } else if (!newIsDone && oldIsDone) {
              dbUpdates.completed_at = null;
              updates.completedAt = undefined;
            }
          }
        }
        if ('projectId' in updates) dbUpdates.project_id = updates.projectId;
        if ('title' in updates) dbUpdates.title = updates.title;
        if ('priority' in updates) dbUpdates.priority = updates.priority;
        if ('assigneeId' in updates) {
          dbUpdates.assignee_id = updates.assigneeId || null;
          if (!('department' in updates)) {
            const assignee = users.find(u => u.id === updates.assigneeId);
            if (assignee) {
              const dept = getDepartment(assignee);
              if (dept) {
                dbUpdates.department = dept;
                updates.department = dept;
              }
            }
          }
        }
        if ('reviewerId' in updates) dbUpdates.reviewer_id = updates.reviewerId || null;
        if ('dueDate' in updates) dbUpdates.due_date = updates.dueDate || null;
        if ('startedAt' in updates) dbUpdates.started_at = updates.startedAt || null;
        if ('completedAt' in updates) dbUpdates.completed_at = updates.completedAt || null;
        if ('gitlabUrl' in updates) dbUpdates.gitlab_url = updates.gitlabUrl || null;
        if ('sortOrder' in updates) dbUpdates.sort_order = updates.sortOrder;
        if ('sprintId' in updates) dbUpdates.sprint_id = updates.sprintId || null;
        if ('department' in updates) dbUpdates.department = updates.department || null;
        if ('parentTaskId' in updates) dbUpdates.parent_task_id = updates.parentTaskId || null;
        if ('approvalStatus' in updates) dbUpdates.approval_status = updates.approvalStatus ?? null;
        if ('currentApprovalId' in updates) dbUpdates.current_approval_id = updates.currentApprovalId ?? null;
        if ('requiresApproval' in updates) dbUpdates.requires_approval = updates.requiresApproval ?? false;

        if ('dueDate' in updates || 'dueDateKind' in updates) {
          const before = allTasksRef.current.find(task => task.id === taskId);
          if (!before) { await refreshTasks(); return false; }
          try {
            const date = 'dueDate' in updates ? updates.dueDate || null : before.dueDate || null;
            const row = await setTaskDeadline(taskId,
              { dueDate: before.dueDate || null, kind: before.dueDateKind ?? null, version: updates.dueDateVersion ?? before.dueDateVersion ?? 0 },
              date, date ? ('dueDateKind' in updates ? updates.dueDateKind ?? null : before.dueDateKind ?? null) : null,
              updates.dueDateChangeReason ?? null,
              'startedAt' in updates ? { before: before.startedAt || null, next: updates.startedAt || null } : undefined);
            updates = { ...updates, ...deadlineTaskFields(row) };
            delete dbUpdates.due_date; delete dbUpdates.started_at;
          } catch (error) {
            toast.error(i18n.t(`taskPlanning.errors.${planningErrorCode(error)}`));
            await refreshTasks(); return false;
          }
        }

        const applyLocalUpdate = (task: Task) => {
          if (task.id !== taskId) return task;
          // A later realtime update may already be visible after the guarded write.
          if (expectedStatus && (
            task.projectId !== expectedStatus.projectId || task.statusId !== expectedStatus.statusId ||
            task.startedAt !== expectedStatus.startedAt || task.completedAt !== expectedStatus.completedAt
          )) return task;
          return { ...task, ...updates };
        };
        const updateLocalTask = () => {
          setAllTasks(prev => prev.map(applyLocalUpdate));
          setSelectedTask(prev => prev ? applyLocalUpdate(prev) : prev);
        };

        if (!expectedStatus && Object.keys(updates).length > 0) updateLocalTask();

        if (Object.keys(dbUpdates).length > 0) {
          const write = supabase.from('tasks').update(dbUpdates).eq('id', taskId);
          if (expectedStatus) {
            let guarded = write.eq('project_id', expectedStatus.projectId).eq('status_id', expectedStatus.statusId);
            guarded = expectedStatus.startedAt == null ? guarded.is('started_at', null) : guarded.eq('started_at', expectedStatus.startedAt);
            guarded = expectedStatus.completedAt == null ? guarded.is('completed_at', null) : guarded.eq('completed_at', expectedStatus.completedAt);
            const { data, error } = await guarded.select('id,status_id,started_at,completed_at').maybeSingle();
            const confirmed = data?.id === taskId && data.status_id === updates.statusId &&
              (!('startedAt' in updates) || data.started_at === (updates.startedAt ?? null)) &&
              (!('completedAt' in updates) || data.completed_at === (updates.completedAt ?? null));
            if (error || !confirmed) {
              if (error) toast.error(taskWriteErrorText(error.message));
              await refreshTasks().catch(() => {});
              return false;
            }
            updateLocalTask();
          } else {
            const { error } = await write;
            if (error) {
              toast.error(taskWriteErrorText(error.message));
              await refreshTasks();
              return false;
            }
          }
        }

        // Preserve row identity and historical environments; never delete before validation succeeds.
        if ('deployments' in updates) {
          const deployments = updates.deployments ?? [];
          const stored = await supabase.from('task_deployments').select('*').eq('task_id', taskId);
          let deploymentError = stored.error;
          if (!deploymentError) {
            const previous = stored.data ?? [];
            for (const deployment of deployments) {
              const existing = previous.find(row => row.environment === deployment.environment);
              const row = { task_id: taskId, environment: deployment.environment, status: deployment.status, deploy_date: deployment.deployDate ?? null };
              if (existing && existing.status === row.status && existing.deploy_date === row.deploy_date) continue;
              const result = existing
                ? await supabase.from('task_deployments').update(row).eq('id', existing.id).eq('task_id', taskId)
                : await supabase.from('task_deployments').insert(row);
              if (result.error) { deploymentError = result.error; break; }
            }
            if (!deploymentError) {
              const removed = previous.filter(row => !deployments.some(deployment => deployment.environment === row.environment));
              if (removed.length) deploymentError = (await supabase.from('task_deployments').delete().eq('task_id', taskId).in('id', removed.map(row => row.id))).error;
            }
          }
          if (deploymentError) {
            toast.error(i18n.t('error.updateFailed') + deploymentError.message);
            await refreshTasks();
            return false;
          }
        }

        // Record status log
        if ('statusId' in updates) {
          const oldTask = allTasksRef.current.find(t => t.id === taskId);
          const logId = `sl-${randomUUID()}`;
          const changedAt = new Date().toISOString();
          const { error: logError } = await supabase.from('status_logs').insert({
            id: logId,
            task_id: taskId,
            from_status_id: expectedStatus?.statusId ?? oldTask?.statusId ?? null,
            to_status_id: updates.statusId!,
            changed_by: currentMemberId || 'unknown',
            changed_at: changedAt,
          });
          if (logError) {
            console.error('[LIVO] Status log insert failed:', logError);
          } else {
            appendStatusLog({
              id: logId,
              taskId,
              fromStatusId: expectedStatus?.statusId ?? oldTask?.statusId,
              toStatusId: updates.statusId!,
              changedBy: currentMemberId || 'unknown',
              changedAt,
            });
          }
        }

        // Webhooks are sent by the server (Integrations → Webhooks), never from a member's browser.
        return true;
      },
    [refreshTasks, appendStatusLog, statuses],
  );

  const createCreateSubtask = useCallback(
    (allProjects: Project[], currentMemberId: string, requiredFields?: SubtaskRequiredFields) => {
      subtaskActor.current = currentMemberId;
      let run = subtaskRunners.current.get(currentMemberId);
      if (!run) { run = createTaskWorkCommandRunner(supabase); subtaskRunners.current.set(currentMemberId, run); }
      return async (parentTaskId: string, title: string, projectId: string, statusId: string, parentTaskOverride?: Task, values?: SubtaskCreateValues): Promise<Task | null> => {
        const parent = parentTaskOverride ?? allTasks.find(t => t.id === parentTaskId);
        if (!parent || !currentMemberId || subtaskActor.current !== currentMemberId || !title.trim() || parent.projectId !== projectId) return null;
        if (parent.parentTaskId) {
          toast.error(i18n.t('task.noNestedSubtasks', { defaultValue: 'Nested subtasks are not allowed' }));
          return null;
        }
        const project = allProjects.find(p => p.id === projectId);
        if (!project) return null;
        try {
          const result = await run!({ operation: 'create_subtask', taskId: parentTaskId, title: title.trim(), statusId, priority: values?.priority ?? 'medium',
            ...subtaskQuickCreateFields(parent, requiredFields),
            ...(values?.dueDate !== undefined ? { dueDate: values.dueDate } : {}),
            ...(values?.assigneeId !== undefined ? { assigneeId: values.assigneeId } : {}),
            ...(values?.reviewerId !== undefined ? { reviewerId: values.reviewerId } : {}),
            ...(values?.details !== undefined ? { details: values.details } : {}) });
          if (subtaskActor.current !== currentMemberId) return null;
          const newTask = mapTask(result.record as TaskRow);
          setAllTasks(prev => [...prev.filter(item => item.id !== newTask.id), newTask]);
          return newTask;
        } catch (error) {
          if (subtaskActor.current === currentMemberId) toast.error(i18n.t(`taskWork.errors.${taskWorkErrorCode(error)}`));
          // Complete forms distinguish a rejected command from an uncertain transport
          // result so they can reconcile the original intent before editing/retrying.
          if (values) throw error;
          return null;
        }
      };
    },
    [allTasks, setAllTasks],
  );

  return { createUpdateTaskInDb, createTaskInDb, createCreateSubtask };
}
