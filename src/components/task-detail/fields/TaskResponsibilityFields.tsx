import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { supabase } from '@/integrations/supabase/client';
import type { Task } from '@/types';
import { createTaskWorkCommandRunner, getTaskResponsibility, taskWorkErrorCode, type ResponsibilityRole, type TaskResponsibility } from '@/lib/taskWork/client';

type Props = { task: Task; memberId: string | null; role: ResponsibilityRole; onSaved: (row: TaskResponsibility) => void };
export default function TaskResponsibilityFields({ task, memberId, role, onSaved }: Props) {
  const { t, i18n } = useTranslation();
  const assignedId = role === 'assignee' ? task.assigneeId : task.reviewerId;
  const revision = role === 'assignee' ? task.assigneeRevision : task.reviewerRevision;
  const propAt = role === 'assignee' ? task.assigneeAcknowledgedAt : task.reviewerAcknowledgedAt;
  const scope = `${memberId || ''}:${task.id}:${role}:${assignedId || ''}:${revision ?? 0}`;
  const activeScope = useRef(scope); activeScope.current = scope;
  const generation = useRef(0);
  const run = useMemo(() => createTaskWorkCommandRunner(supabase), [memberId, task.id, role]);
  const [state, setState] = useState<{ scope: string; row: TaskResponsibility | null; loading: boolean; error: string }>({ scope: '', row: null, loading: false, error: '' });
  const [saving, setSaving] = useState(false);
  const [reload, setReload] = useState(0);
  useEffect(() => {
    const token = ++generation.current;
    setState({ scope, row: null, loading: !!memberId, error: '' }); setSaving(false);
    if (memberId) void getTaskResponsibility(supabase, task.id).then(row => {
      if (generation.current === token && activeScope.current === scope) setState({ scope, row, loading: false, error: '' });
    }).catch(error => {
      if (generation.current === token && activeScope.current === scope) setState({ scope, row: null, loading: false, error: taskWorkErrorCode(error) });
    });
    return () => { ++generation.current; };
  }, [scope, task.id, memberId, propAt, reload]);
  const visible = state.scope === scope ? state : null;
  const row = visible?.row;
  const liveId = row?.[`${role}_id`];
  const liveRevision = row?.[`${role}_revision`];
  const acknowledged = row?.[`${role}_acknowledged_at`];
  const accept = async () => {
    if (activeScope.current !== scope || !row || !memberId || liveId !== memberId || acknowledged || saving) return;
    const captured = scope, token = generation.current;
    setSaving(true); setState(previous => ({ ...previous, error: '' }));
    try {
      const result = await run({ operation: 'acknowledge', taskId: task.id, role, expectedRevision: liveRevision! });
      if (activeScope.current !== captured || generation.current !== token) return;
      const saved = result.task as TaskResponsibility;
      setState({ scope, row: saved, loading: false, error: '' });
      onSaved(saved);
    } catch (error) {
      if (activeScope.current === captured && generation.current === token) setState(previous => ({ ...previous, error: taskWorkErrorCode(error) }));
    } finally {
      if (activeScope.current === captured && generation.current === token) setSaving(false);
    }
  };
  if (!memberId || (!assignedId && !liveId)) return null;
  return <div className="mt-2 space-y-1 text-xs">
    {visible?.loading && <p className="text-muted-foreground">{t('taskWork.loading')}</p>}
    {row && <p className="text-muted-foreground">{acknowledged ? t('taskWork.acknowledgedAt', { date: new Date(acknowledged).toLocaleString(i18n.language) }) : t('taskWork.awaitingAcknowledgement')}</p>}
    {row && liveId === memberId && !acknowledged && <Button type="button" size="sm" variant="outline" disabled={saving} onClick={() => void accept()}>{t(saving ? 'taskWork.saving' : role === 'assignee' ? 'taskWork.acceptAssignment' : 'taskWork.acceptReview')}</Button>}
    {row && liveId === memberId && <p className="text-muted-foreground">{t('taskWork.acknowledgementDescription')}</p>}
    {visible?.error && <div><p role="alert">{t(`taskWork.errors.${visible.error}`)}</p>{visible.error !== 'work_transport_error' && <button type="button" disabled={saving} className="underline" onClick={() => setReload(value => value + 1)}>{t('taskWork.reload')}</button>}</div>}
  </div>;
}
