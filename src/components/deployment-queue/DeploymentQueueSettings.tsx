import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useAuthContext } from '@/context/AuthContext';
import { useTaskContext } from '@/context/TaskContext';
import { useMemberContext } from '@/context/MemberContext';
import { defaultDeploymentQueueSettings } from '@/lib/deploymentQueue';
import type { useDeploymentQueueSettings } from '@/hooks/useDeploymentQueueSettings';

type Settings = ReturnType<typeof useDeploymentQueueSettings>;
export default function DeploymentQueueSettings({ settings }: { settings: Settings }) {
  const { t } = useTranslation();
  const { currentMember } = useAuthContext();
  const { statuses } = useTaskContext();
  const { users } = useMemberContext();
  const [draft, setDraft] = useState(settings.config || defaultDeploymentQueueSettings());
  const [busy, setBusy] = useState(false), [failed, setFailed] = useState(false);
  useEffect(() => { setDraft(settings.config || defaultDeploymentQueueSettings()); }, [settings.config, settings.revision]);
  if (currentMember?.role !== 'super_admin') return null;
  const editable = ['ready', 'missing'].includes(settings.status) && !busy;
  const toggle = (key: 'taskStatusIds' | 'operatorMemberIds', id: string, selected: boolean) => setDraft(value => ({ ...value, [key]: selected ? [...value[key], id] : value[key].filter(current => current !== id) }));
  return <details className="rounded-lg border bg-card p-4"><summary className="cursor-pointer text-sm font-medium">{t('deploymentQueue.settings')}</summary><form className="mt-4 space-y-4" onSubmit={async event => { event.preventDefault(); if (!editable || currentMember?.role !== 'super_admin') return; setBusy(true); setFailed(false); try { await settings.save(draft, settings.revision); } catch { setFailed(true); } finally { setBusy(false); } }}>
    <p className="text-sm text-muted-foreground">{t('deploymentQueue.settingsHelp')}</p>
    <label className="flex gap-2 text-sm"><input type="checkbox" checked={draft.enabled} disabled={!editable} onChange={event => setDraft(value => ({ ...value, enabled: event.target.checked }))} />{t('deploymentQueue.enableQueue')}</label>
    <fieldset disabled={!editable} className="space-y-2"><legend className="mb-2 text-sm font-medium">{t('deploymentQueue.taskStatuses')}</legend><p className="text-xs text-muted-foreground">{t('deploymentQueue.taskStatusesHelp')}</p>{statuses.filter(status => !status.isDone || draft.taskStatusIds.includes(status.id)).map(status => <label key={status.id} className="flex gap-2 text-sm"><input type="checkbox" checked={draft.taskStatusIds.includes(status.id)} disabled={status.isDone && !draft.taskStatusIds.includes(status.id)} onChange={event => toggle('taskStatusIds', status.id, event.target.checked)} />{status.name}</label>)}</fieldset>
    <fieldset disabled={!editable} className="space-y-2"><legend className="mb-2 text-sm font-medium">{t('deploymentQueue.operators')}</legend><p className="text-xs text-muted-foreground">{t('deploymentQueue.operatorsHelp')}</p>{users.filter(user => user.isActive || draft.operatorMemberIds.includes(user.id)).map(user => <label key={user.id} className="flex gap-2 text-sm"><input type="checkbox" checked={draft.operatorMemberIds.includes(user.id)} disabled={!user.isActive && !draft.operatorMemberIds.includes(user.id)} onChange={event => toggle('operatorMemberIds', user.id, event.target.checked)} />{user.name}{!user.isActive && ` (${t('deploymentQueue.inactive')})`}</label>)}</fieldset>
    {failed && <p role="alert" className="text-sm text-destructive">{t('deploymentQueue.settingsFailed')}</p>}
    <button type="submit" disabled={!editable} className="rounded-md bg-primary px-3 py-2 text-sm text-primary-foreground disabled:opacity-50">{busy ? t('deploymentQueue.saving') : t('deploymentQueue.save')}</button>
  </form></details>;
}
