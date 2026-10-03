import { useCallback, useRef } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { toast } from 'sonner';
import i18n from '@/i18n';
import { getDepartment } from '@/lib/department';
import { getWebhookConfig, triggerWebhook, type WebhookConfig } from '@/lib/webhook';
import type { Task, Status, StatusLog, User, Project } from '@/types';
import { randomUUID } from '@/lib/generateId';
import { deadlineTaskFields, planningErrorCode, setTaskDeadline } from '@/lib/taskPlanning/client';
import { createTaskWorkCommandRunner, taskWorkErrorCode } from '@/lib/taskWork/client';
import { mapTask, type TaskRow } from '@/context/mappers';

interface TaskCRUDDeps {
  allTasks: Task[];
  statuses: Status[];
  setAllTasks: React.Dispatch<React.SetStateAction<Task[]>>;
  refreshTasks: () => Promise<void>;
  appendStatusLog: (log: StatusLog) => void;
  webhookConfigRef: React.MutableRefObject<WebhookConfig | null>;
}

export function useTaskCRUD({
  allTasks, statuses, setAllTasks, refreshTasks, appendStatusLog, webhookConfigRef,
}: TaskCRUDDeps) {
  const allTasksRef = useRef(allTasks);
  allTasksRef.current = allTasks;
  const subtaskRunners = useRef(new Map<string, ReturnType<typeof createTaskWorkCommandRunner>>());
  const subtaskActor = useRef('');

  const createTaskInDb = useCallback(async (task: Task) => {
    const { error } = await supabase.from('tasks').insert({
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
    if (error) {
      toast.error(i18n.t('task.createFailed') + error.message);
      await refreshTasks();
      return;
    }
    // Webhook: task_created (advertised in the integrations UI, but previously
    // never dispatched from anywhere). getWebhookConfig() fallback picks up a
    // config saved in this session (the ref is only hydrated at initial load).
    const wbCfg = webhookConfigRef.current ?? getWebhookConfig();
    if (wbCfg?.enabled) {
      triggerWebhook(wbCfg, 'task_created', {
        task: {
          id: task.id,
          taskKey: task.taskKey,
          title: task.title,
          status: task.statusId,
          priority: task.priority,
          assigneeId: task.assigneeId,
          projectId: task.projectId,
        },
      }).catch((_err: unknown) => { console.error('[LIVO] webhook trigger failed:', _err); });
    }
  }, [refreshTasks, webhookConfigRef]);

  const createUpdateTaskInDb = useCallback(
    (
      currentMemberId: string,
      users: User[],
      setSelectedTask: (fn: (prev: Task | null) => Task | null) => void,
    ) =>
      async (taskId: string, updates: Partial<Task>) => {
        const dbUpdates: Record<string, string | number | boolean | null | undefined> = {};
        // Captured BEFORE the optimistic update / awaits so the webhook
        // dispatch below can't misread the already-updated task state.
        let crossedToDone = false;
        if ('statusId' in updates) {
          dbUpdates.status_id = updates.statusId;
          const oldTask = allTasksRef.current.find(t => t.id === taskId);
          const newIsDone = statuses.find(s => s.id === updates.statusId)?.isDone ?? false;
          const oldIsDone = oldTask ? (statuses.find(s => s.id === oldTask.statusId)?.isDone ?? false) : false;
          crossedToDone = newIsDone && !oldIsDone;
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
          if (!before) { await refreshTasks(); return; }
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
            await refreshTasks(); return;
          }
        }

        // Optimistic update
        if (Object.keys(updates).length > 0) {
          setAllTasks(prev => prev.map(t => t.id === taskId ? { ...t, ...updates } : t));
          setSelectedTask(prev => prev && prev.id === taskId ? { ...prev, ...updates } : prev);
        }

        if (Object.keys(dbUpdates).length > 0) {
          const { error } = await supabase.from('tasks').update(dbUpdates).eq('id', taskId);
          if (error) {
            toast.error(i18n.t('error.updateFailed') + error.message);
            await refreshTasks();
            return;
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
            return;
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
            from_status_id: oldTask?.statusId || null,
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
              fromStatusId: oldTask?.statusId,
              toStatusId: updates.statusId!,
              changedBy: currentMemberId || 'unknown',
              changedAt,
            });
          }
        }

        // Trigger webhook (getWebhookConfig() fallback: config saved in this
        // session, before any reload re-hydrates the ref)
        const wbCfg = webhookConfigRef.current ?? getWebhookConfig();
        if (wbCfg?.enabled && Object.keys(dbUpdates).length > 0) {
          const task = allTasksRef.current.find(t => t.id === taskId);
          const events = ['statusId' in updates ? 'status_changed' : 'task_updated'];
          // task_completed (advertised in the integrations UI, previously never
          // dispatched): fires when the status crosses from not-done to done.
          if (crossedToDone) events.push('task_completed');
          const payload = {
            task: {
              id: taskId,
              title: updates.title ?? task?.title,
              status: updates.statusId ?? task?.statusId,
              priority: updates.priority ?? task?.priority,
              assigneeId: updates.assigneeId ?? task?.assigneeId,
            },
          };
          for (const event of events) {
            triggerWebhook(wbCfg, event, payload)
              .catch((_err: unknown) => { console.error('[LIVO] webhook trigger failed:', _err); });
          }
        }
      },
    [refreshTasks, appendStatusLog, statuses, webhookConfigRef],
  );

  const createCreateSubtask = useCallback(
    (allProjects: Project[], currentMemberId: string) => {
      subtaskActor.current = currentMemberId;
      let run = subtaskRunners.current.get(currentMemberId);
      if (!run) { run = createTaskWorkCommandRunner(supabase); subtaskRunners.current.set(currentMemberId, run); }
      return async (parentTaskId: string, title: string, projectId: string, statusId: string, parentTaskOverride?: Task): Promise<Task | null> => {
        const parent = parentTaskOverride ?? allTasks.find(t => t.id === parentTaskId);
        if (!parent || !currentMemberId || subtaskActor.current !== currentMemberId || !title.trim() || parent.projectId !== projectId) return null;
        if (parent.parentTaskId) {
          toast.error(i18n.t('task.noNestedSubtasks', { defaultValue: 'Nested subtasks are not allowed' }));
          return null;
        }
        const project = allProjects.find(p => p.id === projectId);
        if (!project) return null;
        try {
          const result = await run!({ operation: 'create_subtask', taskId: parentTaskId, title: title.trim(), statusId, priority: 'medium', assigneeId: null, reviewerId: null, dueDate: null });
          if (subtaskActor.current !== currentMemberId) return null;
          const newTask = mapTask(result.record as TaskRow);
          setAllTasks(prev => [...prev.filter(item => item.id !== newTask.id), newTask]);
          return newTask;
        } catch (error) { if (subtaskActor.current === currentMemberId) toast.error(i18n.t(`taskWork.errors.${taskWorkErrorCode(error)}`)); return null; }
      };
    },
    [allTasks, setAllTasks],
  );

  return { createUpdateTaskInDb, createTaskInDb, createCreateSubtask };
}
