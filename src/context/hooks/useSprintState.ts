import { useState, useCallback, useMemo } from 'react';
import { sprintBacklogTaskIds } from '@/lib/sprintBacklog';
import { supabase } from '@/integrations/supabase/client';
import { toast } from 'sonner';
import i18n from '@/i18n';
import type { Task, Status } from '@/types';
import type { Sprint } from '../SprintContext';
import type { SprintRow } from '../mappers';

type SetAllTasks = React.Dispatch<React.SetStateAction<Task[]>>;

export type PendingTaskAction = 'backlog' | 'keep' | 'next-sprint';

export function useSprintState() {
  const [sprintActive, setSprintActive] = useState<boolean>(false);
  const [sprintStartedAt, setSprintStartedAt] = useState<string | null>(null);
  const [sprints, setSprints] = useState<Sprint[]>([]);

  const currentSprint = useMemo(() => sprints.find(s => s.isActive) || null, [sprints]);

  const refreshSprints = useCallback(async (keepActiveState = false) => {
    const { data } = await supabase.from('sprints').select('*').order('started_at', { ascending: false });
    if (data) {
      const mapped: Sprint[] = data.map((r: SprintRow) => ({
        id: r.id,
        name: r.name ?? '',
        startedAt: r.started_at,
        completedAt: r.completed_at,
        completedCount: r.completed_count,
        pendingCount: r.pending_count,
        isActive: r.is_active,
      }));
      setSprints(mapped);
      if (!keepActiveState) {
        const active = mapped.find(s => s.isActive);
        setSprintActive(!!active);
        setSprintStartedAt(active?.startedAt || null);
      }
    }
  }, []);

  const getDefaultSprintName = useCallback(() => {
    const today = new Date();
    const year = today.getFullYear();
    const month = String(today.getMonth() + 1).padStart(2, '0');
    const prefix = `${year}${month}`;
    const sameMonthCount = sprints.filter(s => s.name.startsWith(prefix + 'W')).length;
    return `${prefix}W${sameMonthCount + 1}`;
  }, [sprints]);

  /** Update sprint_id in batches of 100; returns how many tasks could not be moved. */
  const batchUpdateSprintId = useCallback(async (taskIds: string[], sprintId: string | null): Promise<number> => {
    const chunkSize = 100;
    let failed = 0;
    for (let i = 0; i < taskIds.length; i += chunkSize) {
      const chunk = taskIds.slice(i, i + chunkSize);
      const { error } = await supabase.from('tasks').update({ sprint_id: sprintId }).in('id', chunk);
      if (error) { console.error('[LIVO] batchUpdateSprintId error:', error); failed += chunk.length; }
    }
    if (failed) toast.error(i18n.t('sprint.moveTasksFailed', { count: failed }));
    return failed;
  }, []);

  const createStartSprint = useCallback(
    (statuses: Status[], allTasks: Task[], refreshTasks: () => Promise<void>) =>
      async (name: string, carryOverTaskIds?: string[], includeBacklog: boolean = true): Promise<boolean> => {
        if (sprints.some(s => s.name === name)) {
          toast.error(i18n.t('sprint.nameDuplicate'));
          return false;
        }
        setSprintActive(true);
        const { data, error } = await supabase.from('sprints').insert({
          name,
          is_active: true,
        }).select().single();
        if (error) { toast.error(i18n.t('sprint.createFailed') + error.message); setSprintActive(false); return false; }
        const newSprintId = data?.id;
        // Collect task IDs to assign to the new sprint
        let allIds: string[] = [...(carryOverTaskIds || [])];
        if (includeBacklog) {
          // Only the open backlog: never finished tasks or tasks of earlier sprints.
          allIds = [...new Set([...allIds, ...sprintBacklogTaskIds(allTasks, statuses)])];
        }
        if (allIds.length > 0) {
          await batchUpdateSprintId(allIds, newSprintId);
        }
        await Promise.all([refreshSprints(), refreshTasks()]);
        toast.success(i18n.t('sprint.started'));
        return true;
      },
    [sprints, refreshSprints, batchUpdateSprintId],
  );

  const createCompleteSprint = useCallback(
    (statuses: Status[], allTasks: Task[], refreshTasks: () => Promise<void>, setAllTasks?: SetAllTasks) =>
      async (pendingAction: PendingTaskAction = 'backlog'): Promise<{ pendingIds: string[] } | null> => {
        if (!currentSprint) return null;
        const doneIds = statuses.filter(s => s.isDone).map(s => s.id);
        const sprintTasks = allTasks.filter(t => t.sprintId === currentSprint.id);
        const completedCount = sprintTasks.filter(t => doneIds.includes(t.statusId)).length;
        const pendingTasks = sprintTasks.filter(t => !doneIds.includes(t.statusId));

        // Mark sprint as completed
        const { error } = await supabase.from('sprints').update({
          is_active: false,
          completed_at: new Date().toISOString(),
          completed_count: completedCount,
          pending_count: pendingTasks.length,
        }).eq('id', currentSprint.id);
        if (error) { toast.error(i18n.t('sprint.completeFailed') + error.message); return null; }

        // Handle pending tasks based on user's choice
        const pendingIds = pendingTasks.map(t => t.id);
        if (pendingIds.length > 0) {
          switch (pendingAction) {
            case 'backlog':
            case 'next-sprint':
              // Remove sprint association — tasks go back to backlog
              await batchUpdateSprintId(pendingIds, null);
              // Optimistic local state update so UI reflects immediately
              if (setAllTasks) {
                const idSet = new Set(pendingIds);
                setAllTasks(prev => prev.map(t => idSet.has(t.id) ? { ...t, sprintId: undefined } : t));
              }
              break;
            case 'keep':
              // Leave tasks in the completed sprint record (no change)
              break;
          }
        }

        await Promise.all([refreshSprints(), refreshTasks()]);
        toast.success(i18n.t('sprint.completed'));

        // The unfinished tasks, which the caller offers to the next sprint for 'next-sprint'.
        return { pendingIds };
      },
    [currentSprint, refreshSprints, batchUpdateSprintId],
  );

  const renameSprint = useCallback(async (sprintId: string, newName: string) => {
    if (sprints.some(s => s.id !== sprintId && s.name === newName)) {
      toast.error(i18n.t('sprint.nameDuplicate'));
      return;
    }
    const { error } = await supabase.from('sprints').update({ name: newName }).eq('id', sprintId);
    if (error) { toast.error(i18n.t('sprint.renameFailed') + error.message); return; }
    await refreshSprints();
    toast.success(i18n.t('sprint.renamed'));
  }, [sprints, refreshSprints]);

  return {
    sprintActive, setSprintActive,
    sprintStartedAt, setSprintStartedAt,
    sprints, setSprints,
    currentSprint,
    refreshSprints, getDefaultSprintName,
    createStartSprint, createCompleteSprint, renameSprint,
  };
}
