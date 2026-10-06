import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { supabase } from '@/integrations/supabase/client';
import { mapTask, type TaskRow } from '@/context/mappers';
import type { Task } from '@/types';
import { useAuthContext } from '@/context/AuthContext';
import { useUIContext } from '@/context/UIContext';
import { useTaskContext } from '@/context/TaskContext';
import { useProjectContext } from '@/context/ProjectContext';
import { useProjectScope } from '@/hooks/useProjectScope';
import { useDeploymentQueueSettings } from '@/hooks/useDeploymentQueueSettings';
import { useQa } from '@/hooks/useQa';
import { qaId } from '@/lib/qa/client';
import { canQaCommand } from '@/lib/qa/domain';
import { pendingDeploymentTasks, pendingQaDeployments, readCompletePages, readPendingQa, type QaDeploymentRow } from '@/lib/deploymentQueueRows';
import DeploymentQueueSettings from './DeploymentQueueSettings';

type ReadState<T> = { identity: string; status: 'loading' | 'ready' | 'error'; rows: T[] };
const button = 'rounded-md border px-3 py-2 text-sm hover:bg-accent disabled:opacity-50';
export default function DeploymentQueueView() {
  const { t } = useTranslation();
  const { currentMember, realMemberId } = useAuthContext();
  const { setCurrentView, setSelectedTask, featureToggles, featureTogglesReady } = useUIContext();
  const { allTasks } = useTaskContext();
  const { allProjects } = useProjectContext();
  const scope = useProjectScope();
  const settings = useDeploymentQueueSettings();
  const { client, enabled: qaEnabled, actor } = useQa();
  const [revision, setRevision] = useState(0), [busy, setBusy] = useState<string | null>(null), [writeFailed, setWriteFailed] = useState(false);
  const scopedIds = useMemo(() => scope.projectIds ? [...scope.projectIds].sort() : undefined, [scope.projectIds]);
  const identity = `${realMemberId || ''}:${currentMember?.id || ''}:${JSON.stringify(scopedIds)}:${JSON.stringify(settings.config)}:${settings.status}:${qaEnabled}`;
  const latest = useRef(identity); latest.current = identity;
  const [tasks, setTasks] = useState<ReadState<Task>>({ identity: '', status: 'loading', rows: [] });
  const [qa, setQa] = useState<ReadState<QaDeploymentRow>>({ identity: '', status: 'loading', rows: [] });
  useEffect(() => { setBusy(null); setWriteFailed(false); }, [identity]);
  const reload = useCallback(() => setRevision(value => value + 1), []);
  useEffect(() => {
    if (settings.status !== 'ready' || !settings.config?.enabled || !currentMember?.isActive) return;
    const controller = new AbortController(), signal = controller.signal;
    setTasks({ identity, status: 'loading', rows: [] }); setQa({ identity, status: 'loading', rows: [] });
    const store = <T,>(setter: (value: ReadState<T>) => void, status: 'ready' | 'error', rows: T[] = []) => { if (!signal.aborted && latest.current === identity) setter({ identity, status, rows }); };
    const ids = settings.config.taskStatusIds;
    if (!ids.length || scopedIds?.length === 0) store(setTasks, 'ready');
    else void (async () => {
      try {
        const [rows, statuses] = await Promise.all([
          readCompletePages<TaskRow>(async (offset, limit) => {
            let query = supabase.from('tasks').select('*', { count: 'exact' }).in('status_id', ids).order('id');
            if (scopedIds) query = query.in('project_id', scopedIds);
            const result = await query.range(offset, offset + limit - 1); return { data: result.data, error: result.error, count: result.count ?? null };
          }, signal),
          readCompletePages<{ id: string; is_done: boolean }>(async (offset, limit) => { const result = await supabase.from('statuses').select('id,is_done', { count: 'exact' }).order('id').range(offset, offset + limit - 1); return { data: result.data, error: result.error, count: result.count ?? null }; }, signal),
        ]);
        store(setTasks, 'ready', pendingDeploymentTasks(rows.map(mapTask), statuses.map(status => ({ id: status.id, isDone: status.is_done })), ids));
      } catch { store(setTasks, 'error'); }
    })();
    if (!qaEnabled || scopedIds?.length === 0) store(setQa, 'ready');
    else void readPendingQa(client.list, scopedIds, signal).then(issues => store(setQa, 'ready', pendingQaDeployments(issues)), () => store(setQa, 'error'));
    return () => controller.abort();
  }, [identity, revision, client, qaEnabled]);
  useEffect(() => {
    const onChange = () => reload();
    window.addEventListener('livo:qa-changed', onChange);
    const channel = supabase.channel(`deployment-queue-tasks-${currentMember?.id || 'none'}`).on('postgres_changes', { event: '*', schema: 'public', table: 'tasks' }, onChange).subscribe();
    return () => { window.removeEventListener('livo:qa-changed', onChange); void supabase.removeChannel(channel); };
  }, [currentMember?.id, reload]);
  // QA is read only through the member API; restricted QA tables do not expose Realtime.
  useEffect(() => {
    if (settings.status !== 'ready' || !settings.config?.enabled || !qaEnabled) return;
    const refreshVisible = () => { if (document.visibilityState === 'visible' && !busy) reload(); };
    const timer = window.setInterval(refreshVisible, 30000);
    window.addEventListener('focus', refreshVisible);
    document.addEventListener('visibilitychange', refreshVisible);
    return () => { window.clearInterval(timer); window.removeEventListener('focus', refreshVisible); document.removeEventListener('visibilitychange', refreshVisible); };
  }, [identity, settings.status, settings.config?.enabled, qaEnabled, busy, reload]);
  const taskState = tasks.identity === identity ? tasks : { status: 'loading' as const, rows: [] as Task[] };
  const qaState = qa.identity === identity ? qa : { status: 'loading' as const, rows: [] as QaDeploymentRow[] };
  const open = (id: string, kind: 'task' | 'qa', task?: Task) => {
    const url = new URL(window.location.href);
    ['qa', 'qaCreate', 'kb', 'anchor', 'knowledge', 'task'].forEach(key => url.searchParams.delete(key));
    if (kind === 'qa') { url.searchParams.set('qa', id); window.history.pushState({}, '', url.toString()); setSelectedTask(null); setCurrentView('qa'); window.dispatchEvent(new Event('livo:qa-navigation')); }
    else if (task) { window.history.replaceState({}, '', url.toString()); setCurrentView('my-tasks'); setSelectedTask(allTasks.find(value => value.id === id) || task); }
  };
  const deploy = async (row: QaDeploymentRow) => {
    if (busy || !settings.isOperator && actor.role !== 'super_admin') return;
    const owner = identity; setBusy(row.id); setWriteFailed(false);
    try {
      const fresh = await client.get(row.issue.id);
      if (latest.current !== owner) return;
      const target = fresh.issue.targets.find(value => value.id === row.target.id);
      if (!target || target.deployedAt || !canQaCommand(fresh.issue, actor, 'record_deployment')) throw new Error('deployment-queue-stale-target');
      await client.command(fresh.issue, { type: 'record_deployment', targetId: target.id, build: target.build, evidence: '' }, qaId());
      if (latest.current === owner) { reload(); window.dispatchEvent(new Event('livo:qa-changed')); }
    } catch { if (latest.current === owner) { setWriteFailed(true); reload(); } }
    finally { if (latest.current === owner) setBusy(null); }
  };
  if (!featureTogglesReady || !featureToggles.deploymentQueue) return <p className="p-6">{t('deploymentQueue.disabled')}</p>;
  return <section className="flex-1 overflow-auto p-4 md:p-6"><div className="mx-auto max-w-6xl space-y-4">
    <header className="flex flex-wrap items-center justify-between gap-3"><div><h1 className="text-xl font-semibold">{t('deploymentQueue.title')}</h1><p className="mt-1 text-sm text-muted-foreground">{t('deploymentQueue.description')}</p></div><button className={button} disabled={!!busy} onClick={() => { void settings.refresh(); reload(); }}>{t('deploymentQueue.refresh')}</button></header>
    <DeploymentQueueSettings settings={settings} />
    {settings.status === 'loading' && <p role="status">{t('deploymentQueue.loading')}</p>}
    {settings.status === 'error' && <p role="alert">{t('deploymentQueue.settingsUnknown')}</p>}
    {(settings.status === 'missing' || settings.status === 'ready' && !settings.config?.enabled) && <p>{t('deploymentQueue.notConfigured')}</p>}
    {settings.status === 'ready' && settings.config?.enabled && <>
      {!settings.config.taskStatusIds.length && <p className="text-sm text-muted-foreground">{t('deploymentQueue.noTaskStatuses')}</p>}
      {!qaEnabled && <p className="text-sm text-muted-foreground">{t('deploymentQueue.qaDisabled')}</p>}
      {writeFailed && <p role="alert" className="text-sm text-destructive">{t('deploymentQueue.writeFailed')}</p>}
      <h2 className="text-base font-semibold">{t('deploymentQueue.tasks')} · {taskState.status === 'ready' ? taskState.rows.length : t('deploymentQueue.unknownCount')}</h2>
      {taskState.status === 'loading' && <p role="status">{t('deploymentQueue.loading')}</p>}{taskState.status === 'error' && <p role="alert" className="text-sm text-destructive">{t('deploymentQueue.incomplete')}</p>}
      {taskState.rows.map(task => <article key={task.id} className="flex flex-wrap items-center justify-between gap-3 rounded-lg border bg-card p-4"><div><p className="font-medium">{task.taskKey} · {task.title}</p><p className="text-sm text-muted-foreground">{allProjects.find(project => project.id === task.projectId)?.name || task.projectId}</p></div><button className={button} onClick={() => open(task.id, 'task', task)}>{t('deploymentQueue.openCard')}</button></article>)}
      <h2 className="text-base font-semibold">{t('deploymentQueue.bugs')} · {qaState.status === 'ready' ? qaState.rows.length : t('deploymentQueue.unknownCount')}</h2>
      {qaState.status === 'loading' && <p role="status">{t('deploymentQueue.loading')}</p>}{qaState.status === 'error' && <p role="alert" className="text-sm text-destructive">{t('deploymentQueue.incomplete')}</p>}
      {qaState.rows.map(row => <article key={row.id} className="flex flex-wrap items-center justify-between gap-3 rounded-lg border bg-card p-4"><div><p className="font-medium">{row.issue.title}</p><p className="text-sm text-muted-foreground">{allProjects.find(project => project.id === row.issue.projectId)?.name || row.issue.projectId} · {row.target.environment} · {row.target.build || t('deploymentQueue.versionMissing')}{row.target.component && ` · ${row.target.component}`}</p><p className="text-xs text-muted-foreground">{row.target.required ? t('deploymentQueue.requiredTarget') : t('deploymentQueue.optionalTarget')}</p></div><div className="flex flex-wrap gap-2"><button className={button} onClick={() => open(row.issue.id, 'qa')}>{t('deploymentQueue.openCard')}</button>{canQaCommand(row.issue, actor, 'record_deployment') && (settings.isOperator || actor.role === 'super_admin') && <button className={button} disabled={!!busy} onClick={() => { void deploy(row); }}>{busy === row.id ? t('deploymentQueue.saving') : t('deploymentQueue.confirmDeployed')}</button>}</div></article>)}
      {taskState.status === 'ready' && qaState.status === 'ready' && !taskState.rows.length && !qaState.rows.length && <p>{t('deploymentQueue.empty')}</p>}
      <p className="text-xs text-muted-foreground">{t('deploymentQueue.auditHelp')}</p>
    </>}
  </div></section>;
}
