import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { randomUUID } from '@/lib/generateId';
import { groupProjectsByLine } from '@/lib/projectGroups';
import { ProjectSelectOptions } from '@/components/project/ProjectOptions';
import type { ProductLine, Project, Task, User } from '@/types';
import type { ReleaseBatch, ReleaseComponent, ReleaseManifest, ReleaseTarget } from '@/lib/releases/core';
import { ReleaseField, ReleaseSelect, ReleaseFailure, SubmitFooter, releaseButton, useReleaseSubmit, type ReleaseClient } from './ReleaseFields';

export type ReleaseResources = { projects: Project[]; productLines: ProductLine[]; tasks: Task[]; users: User[]; environments: string[]; environmentsReady: boolean };
const emptyTarget = (): ReleaseTarget => ({ environment: '', build: '', config: '', data: '' });
const emptyComponent = (): ReleaseComponent => ({ id: randomUUID(), name: '', projectId: '', taskIds: [], targets: [emptyTarget()] });

export default function ReleaseManifestForm({ batch, actorId, resources, client, onSaved, onCancel }: {
  batch?: ReleaseBatch; actorId: string; resources: ReleaseResources; client: ReleaseClient; onSaved: (batch: ReleaseBatch) => void; onCancel: () => void;
}) {
  const { t } = useTranslation();
  const [base] = useState(() => ({ batchId: batch?.id ?? randomUUID(), expectedVersion: batch?.version ?? 0 }));
  const [manifest, setManifest] = useState<ReleaseManifest>(() => batch ? structuredClone({ title: batch.title, ownerId: batch.ownerId, components: batch.components }) : { title: '', ownerId: actorId, components: [emptyComponent()] });
  const { busy, uncertain, error, submit } = useReleaseSubmit(client, onSaved);
  const patchComponent = (id: string, patch: Partial<ReleaseComponent>) => setManifest(m => ({ ...m, components: m.components.map(c => c.id === id ? { ...c, ...patch } : c) }));
  const patchTarget = (c: ReleaseComponent, index: number, patch: Partial<ReleaseTarget>) => patchComponent(c.id, { targets: c.targets.map((v, i) => i === index ? { ...v, ...patch } : v) });
  const currentOwner = resources.users.find(u => u.id === manifest.ownerId);
  return <form className="space-y-4 rounded-xl border bg-card p-4" onSubmit={e => { e.preventDefault(); void submit({ ...base, operation: batch ? 'edit_manifest' : 'create', manifest }); }}>
    <h2 className="text-lg font-semibold">{t(batch ? 'releaseWorkspace.editManifest' : 'releaseWorkspace.create')}</h2>
    <p className="text-sm text-muted-foreground">{t('releaseWorkspace.manifestHint')}</p>
    {error !== null && <ReleaseFailure error={error} />}
    <fieldset disabled={busy || uncertain} className="space-y-4">
      <div className="grid gap-3 md:grid-cols-2"><ReleaseField label={t('releaseWorkspace.titleField')} value={manifest.title} maxLength={250} required onChange={e => setManifest(m => ({ ...m, title: e.target.value }))} /><ReleaseSelect label={t('releaseWorkspace.owner')} value={manifest.ownerId} required onChange={e => setManifest(m => ({ ...m, ownerId: e.target.value }))}><option value="">{t('releaseWorkspace.choose')}</option>{(!currentOwner || !currentOwner.isActive) && manifest.ownerId && <option value={manifest.ownerId}>{currentOwner?.name ?? t('releaseWorkspace.unavailable')}</option>}{resources.users.filter(u => u.isActive).map(u => <option value={u.id} key={u.id}>{u.name}</option>)}</ReleaseSelect></div>
      {manifest.components.map((c, index) => <fieldset key={c.id} className="space-y-3 rounded-lg border p-3"><legend className="px-2 text-sm font-semibold">{t('releaseWorkspace.componentNumber', { n: index + 1 })}</legend>
        <div className="grid gap-3 md:grid-cols-2"><ReleaseField label={t('releaseWorkspace.component')} required maxLength={120} value={c.name} onChange={e => patchComponent(c.id, { name: e.target.value })} /><ReleaseSelect label={t('releaseWorkspace.project')} required value={c.projectId} onChange={e => patchComponent(c.id, { projectId: e.target.value, taskIds: [] })}><option value="">{t('releaseWorkspace.choose')}</option><ProjectSelectOptions groups={groupProjectsByLine(resources.productLines, resources.projects, { keepIds: [c.projectId] })} /></ReleaseSelect></div>
        <details><summary className="cursor-pointer text-sm">{t('releaseWorkspace.tasks')} · {c.taskIds.length}/50</summary><div className="mt-2 max-h-56 space-y-1 overflow-y-auto rounded border p-2">{resources.tasks.filter(task => task.projectId === c.projectId).map(task => <label className="flex items-center gap-2 text-sm" key={task.id}><input type="checkbox" checked={c.taskIds.includes(task.id)} disabled={!c.taskIds.includes(task.id) && c.taskIds.length >= 50} onChange={e => patchComponent(c.id, { taskIds: e.target.checked ? [...c.taskIds, task.id] : c.taskIds.filter(id => id !== task.id) })} />{task.taskKey} · {task.title}</label>)}{c.taskIds.filter(id => !resources.tasks.some(task => task.id === id && task.projectId === c.projectId)).map(id => <p key={id} className="text-sm text-destructive">{t('releaseWorkspace.unavailableTask')}</p>)}</div></details>
        {c.targets.map((target, targetIndex) => <div key={targetIndex} className="grid items-end gap-3 rounded-md bg-muted/40 p-3 sm:grid-cols-2 xl:grid-cols-5"><ReleaseSelect label={t('releaseWorkspace.environment')} required value={target.environment} onChange={e => patchTarget(c, targetIndex, { environment: e.target.value })}><option value="">{t('releaseWorkspace.choose')}</option>{target.environment && !resources.environments.includes(target.environment) && <option value={target.environment}>{target.environment} · {t('releaseWorkspace.inactive')}</option>}{resources.environments.map(env => <option value={env} key={env}>{env}</option>)}</ReleaseSelect>{(['build', 'config', 'data'] as const).map(field => <ReleaseField key={field} label={t(`releaseWorkspace.${field}`)} required maxLength={160} value={target[field]} onChange={e => patchTarget(c, targetIndex, { [field]: e.target.value })} />)}<button className={releaseButton} type="button" disabled={c.targets.length === 1} onClick={() => patchComponent(c.id, { targets: c.targets.filter((_, i) => i !== targetIndex) })}>{t('releaseWorkspace.removeTarget')}</button></div>)}
        <div className="flex flex-wrap gap-2"><button className={releaseButton} type="button" disabled={c.targets.length >= 15} onClick={() => patchComponent(c.id, { targets: [...c.targets, emptyTarget()] })}>{t('releaseWorkspace.addTarget')}</button><button className={releaseButton} type="button" disabled={manifest.components.length === 1} onClick={() => setManifest(m => ({ ...m, components: m.components.filter(v => v.id !== c.id) }))}>{t('releaseWorkspace.removeComponent')}</button></div>
      </fieldset>)}
      <button className={releaseButton} type="button" disabled={manifest.components.length >= 30} onClick={() => setManifest(m => ({ ...m, components: [...m.components, emptyComponent()] }))}>{t('releaseWorkspace.addComponent')}</button>
      <label className="flex items-start gap-2 text-sm"><input type="checkbox" required className="mt-1" />{t('releaseWorkspace.confirmManifest')}</label>
    </fieldset>
    {!resources.environmentsReady && <p role="alert">{t('releaseWorkspace.environmentsUnavailable')}</p>}
    <SubmitFooter busy={busy} submitDisabled={!resources.environmentsReady && !uncertain} uncertain={uncertain} onCancel={onCancel} />
  </form>;
}
