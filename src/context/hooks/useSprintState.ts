import { useState, useCallback, useMemo, useRef, useEffect } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { toast } from 'sonner';
import i18n from '@/i18n';
import { randomUUID } from '@/lib/generateId';
import { createSprintCommandRunner, sprintError } from '@/lib/sprintCommands';
import type { SprintIntent, SprintCommandResult } from '@/lib/sprintLifecycle';
import type { Task, Status } from '@/types';
import type { Sprint, SprintCommandState } from '../SprintContext';
import type { SprintRow } from '../mappers';

type SetAllTasks = React.Dispatch<React.SetStateAction<Task[]>>;
export type PendingTaskAction = 'backlog' | 'next-sprint';

export function useSprintState(actorKey?: string | null) {
  const [sprintActive, setSprintActive] = useState(false);
  const [sprintStartedAt, setSprintStartedAt] = useState<string | null>(null);
  const [sprints, setSprints] = useState<Sprint[]>([]);
  const [commandState, setCommandState] = useState<SprintCommandState>({ busy: false, unresolved: false });
  const runner = useMemo(() => createSprintCommandRunner({ rpc: (name, args) => supabase.rpc(name, args as never) }), [actorKey]);
  const activeRunner = useRef(runner);
  activeRunner.current = runner;
  const inFlight = useRef<typeof runner | null>(null);
  const readVisit = useRef(0);
  const currentSprint = useMemo(() => sprints.find(sprint => sprint.isActive) || null, [sprints]);

  const refreshSprints = useCallback(async (keepActiveState = false) => {
    const owner = activeRunner.current;
    const visit = ++readVisit.current;
    const { data, error } = await supabase.from('sprints').select('*').order('started_at', { ascending: false });
    if (activeRunner.current !== owner || visit !== readVisit.current) return;
    if (error || !data) throw new Error('sprint_refresh_failed');
    const mapped: Sprint[] = data.map((row: SprintRow) => ({
      id: row.id, name: row.name ?? '', startedAt: row.started_at, completedAt: row.completed_at,
      completedCount: row.completed_count, pendingCount: row.pending_count, isActive: row.is_active,
      cancelledCount: row.cancelled_count ?? null, historyCapturedAt: row.history_captured_at ?? null,
      version: row.version ?? 0,
    }));
    setSprints(mapped);
    if (!keepActiveState) {
      const active = mapped.find(sprint => sprint.isActive);
      setSprintActive(!!active);
      setSprintStartedAt(active?.startedAt || null);
    }
  }, []);

  useEffect(() => {
    setCommandState({ busy: false, unresolved: false });
    setSprints([]); setSprintActive(false); setSprintStartedAt(null);
    // Member binding may finish after the one-time initial loader started.
    // Replace its now-stale read with a read for the actual current actor.
    if (actorKey) void refreshSprints().catch(() => toast.error(i18n.t('sprint.refreshFailed')));
  }, [runner, actorKey, refreshSprints]);

  const getDefaultSprintName = useCallback(() => {
    const today = new Date();
    const prefix = `${today.getFullYear()}${String(today.getMonth() + 1).padStart(2, '0')}`;
    return `${prefix}W${sprints.filter(sprint => sprint.name.startsWith(prefix + 'W')).length + 1}`;
  }, [sprints]);

  const mutate = useCallback(async (intent: SprintIntent, refreshTasks: () => Promise<void>): Promise<SprintCommandResult | null> => {
    if (inFlight.current === runner) return null;
    inFlight.current = runner;
    const owner = runner;
    setCommandState({ busy: true, unresolved: !!runner.pending(), operation: intent.operation });
    let result: SprintCommandResult;
    try {
      result = await runner.run(intent);
    } catch (error) {
      if (activeRunner.current === owner) {
        const failure = sprintError(error);
        setCommandState({ busy: false, unresolved: failure.uncertain, operation: intent.operation });
        toast.error(i18n.t(failure.uncertain ? 'sprint.commandUncertain' : `sprint.errors.${failure.code}`, { defaultValue: i18n.t('sprint.operationFailed') }));
      }
      return null;
    } finally { if (inFlight.current === owner) inFlight.current = null; }
    if (activeRunner.current !== owner) return null;
    setCommandState({ busy: false, unresolved: false });
    // A committed command must not be sent again merely because the view refresh failed.
    const refreshed = await Promise.allSettled([refreshSprints(), refreshTasks()]);
    if (activeRunner.current !== owner) return null;
    if (refreshed.some(item => item.status === 'rejected')) toast.error(i18n.t('sprint.savedRefreshFailed'));
    else toast.success(i18n.t(intent.operation === 'start' ? 'sprint.started' : 'sprint.completed'));
    return result;
  }, [runner, refreshSprints]);

  const createStartSprint = useCallback((_statuses: Status[], _allTasks: Task[], refreshTasks: () => Promise<void>) =>
    async (name: string, carryOverTaskIds: string[] = [], includeBacklog = false): Promise<boolean> => {
      const frozen = runner.pending();
      const sprintId = frozen?.operation === 'start' ? frozen.sprintId : randomUUID();
      return !!await mutate({ operation: 'start', sprintId, name: name.trim(), taskIds: [...new Set(carryOverTaskIds)].sort(), includeBacklog }, refreshTasks);
    }, [runner, mutate]);

  const createCompleteSprint = useCallback((_statuses: Status[], _allTasks: Task[], refreshTasks: () => Promise<void>, _setAllTasks?: SetAllTasks) =>
    async (_pendingAction: PendingTaskAction = 'backlog'): Promise<{ pendingIds: string[]; carryIds?: string[] } | null> => {
      const frozen = runner.pending();
      const sprintId = frozen?.operation === 'complete' ? frozen.sprintId : currentSprint?.id;
      const expectedVersion = frozen?.operation === 'complete' ? frozen.expectedVersion : currentSprint?.version ?? 0;
      if (!sprintId) return null;
      const result = await mutate({ operation: 'complete', sprintId, expectedVersion }, refreshTasks);
      return result ? { pendingIds: result.pendingIds, carryIds: result.carryIds } : null;
    }, [runner, currentSprint, mutate]);

  const renameSprint = useCallback(async (sprintId: string, name: string) => {
    if (sprints.some(sprint => sprint.id !== sprintId && sprint.name === name)) { toast.error(i18n.t('sprint.nameDuplicate')); return; }
    const { error } = await supabase.from('sprints').update({ name }).eq('id', sprintId);
    if (error) { toast.error(i18n.t('sprint.renameFailed') + error.message); return; }
    try { await refreshSprints(); toast.success(i18n.t('sprint.renamed')); }
    catch { toast.error(i18n.t('sprint.savedRefreshFailed')); }
  }, [sprints, refreshSprints]);

  return { sprintActive, setSprintActive, sprintStartedAt, setSprintStartedAt, sprints, setSprints, currentSprint,
    commandState, refreshSprints, getDefaultSprintName, createStartSprint, createCompleteSprint, renameSprint };
}
