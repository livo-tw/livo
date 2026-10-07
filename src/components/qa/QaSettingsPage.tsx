import { useCallback, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ArrowLeft, ListChecks, Settings2, UserCog } from 'lucide-react';
import { toast } from 'sonner';
import { useConfirmDialog } from '@/components/ConfirmDialog';
import { useQaNavigationGuard } from '@/hooks/useQaNavigationGuard';
import type { QaActor } from '@/lib/qa/domain';
import type { QaClient } from '@/lib/qa/client';
import type { QaWorkflow } from '@/lib/qa/workflow';
import { canManageQaConfiguration } from '@/lib/qa/fields';
import QaCustomFieldManager from './QaCustomFieldManager';
import QaWorkflowSettings from './QaWorkflowSettings';
import QaManualStateVisibilitySettings from './QaManualStateVisibilitySettings';
import QaCoordinatorSettings from './QaCoordinatorSettings';
import { qaButton, QaSelect } from './QaFields';
import { useProjectContext } from '@/context/ProjectContext';
import { ProjectSelectOptions } from '@/components/project/ProjectOptions';
import { groupProjectsByLine } from '@/lib/projectGroups';

export default function QaSettingsPage({ client, actor, workflow, onWorkflowSaved, onCoordinationSaved, onClose }: {
  client: QaClient; actor: QaActor; workflow: QaWorkflow;
  onWorkflowSaved: (workflow: QaWorkflow) => void; onCoordinationSaved?: () => void; onClose: () => void;
}) {
  const { t } = useTranslation();
  const { confirm, ConfirmDialog } = useConfirmDialog();
  const [tab, setTab] = useState<'workflow' | 'fields' | 'coordinators' | 'manualStates'>('workflow');
  // Coordinators are chosen per project here, without selecting a project elsewhere first.
  const canSetCoordinators = actor.role === 'admin' || actor.role === 'super_admin';

  const [fieldsVisited, setFieldsVisited] = useState(false), [dirty, setDirty] = useState(false);
  const [manualStatesVisited, setManualStatesVisited] = useState(false);
  const [busy, setBusy] = useState(false);
  const pending = useRef({ workflow: false, fields: false, manualStates: false });
  const workflowBusy = useCallback((value: boolean) => { pending.current.workflow = value; setBusy(Object.values(pending.current).some(Boolean)); }, []);
  const fieldsBusy = useCallback((value: boolean) => { pending.current.fields = value; setBusy(Object.values(pending.current).some(Boolean)); }, []);
  const changes = useRef({ workflow: false, fields: false, manualStates: false });
  const workflowChanged = useCallback((value: boolean) => { changes.current.workflow = value; setDirty(Object.values(changes.current).some(Boolean)); }, []);
  const fieldsChanged = useCallback((value: boolean) => { changes.current.fields = value; setDirty(Object.values(changes.current).some(Boolean)); }, []);
  const manualStatesBusy = useCallback((value: boolean) => { pending.current.manualStates = value; setBusy(Object.values(pending.current).some(Boolean)); }, []);
  const manualStatesChanged = useCallback((value: boolean) => { changes.current.manualStates = value; setDirty(Object.values(changes.current).some(Boolean)); }, []);
  useQaNavigationGuard(dirty);
  const close = async () => {
    if (Object.values(pending.current).some(Boolean)) { toast.info(t('qa.finishPending')); return; }
    if (Object.values(changes.current).some(Boolean)) {
      if (!await confirm({ title: t('qa.customFields.discardTitle'), description: t('qa.customFields.discardHint'), destructive: true })) return;
    }
    onClose();
  };
  if (!canManageQaConfiguration(actor)) return <p className="p-5 text-sm text-muted-foreground">{t('qa.customFields.forbidden')}</p>;
  return <div className="min-w-0 flex-1 overflow-y-auto bg-board p-3 md:p-5"><div className="w-full space-y-4">
    <header className="flex flex-wrap items-center justify-between gap-3"><div className="flex items-center gap-3"><div className="rounded-xl bg-primary/10 p-2.5 text-primary"><Settings2 size={22} aria-hidden="true" /></div><div><h1 className="text-xl font-bold">{t('qa.settingsTitle')}</h1><p className="mt-1 text-xs text-muted-foreground">{t('qa.settingsHint')}</p></div></div><button type="button" className={qaButton} disabled={busy} onClick={() => void close()}><ArrowLeft size={15} aria-hidden="true" />{t('qa.back')}</button></header>
    <div className="flex flex-wrap gap-2" role="tablist" aria-label={t('qa.settingsTitle')}>
      {([{ id: 'workflow', label: 'qa.workflowTitle', icon: Settings2 }, { id: 'fields', label: 'qa.customFields.title', icon: ListChecks },
        { id: 'manualStates', label: 'qa.manualStates.title', icon: Settings2 },
        ...(canSetCoordinators ? [{ id: 'coordinators', label: 'qaHandoff.coordinatorTitle', icon: UserCog }] as const : [])] as const).map(({ id, label, icon: Icon }) =>
        <button type="button" key={id} role="tab" id={`qa-settings-tab-${id}`} aria-controls={`qa-settings-panel-${id}`} aria-selected={tab === id}
          className={`${qaButton} ${tab === id ? 'border-primary/30 bg-primary/10 text-primary' : 'text-muted-foreground'}`}
          onClick={() => { setTab(id); if (id === 'fields') setFieldsVisited(true); if (id === 'manualStates') setManualStatesVisited(true); }}><Icon size={15} aria-hidden="true" />{t(label)}</button>)}
    </div>
    <div id="qa-settings-panel-workflow" role="tabpanel" aria-labelledby="qa-settings-tab-workflow" hidden={tab !== 'workflow'}>
      <QaWorkflowSettings client={client} actor={actor} workflow={workflow} onDirtyChange={workflowChanged} onBusyChange={workflowBusy} onSaved={value => { workflowChanged(false); workflowBusy(false); onWorkflowSaved(value); }} onClose={() => void close()} />
    </div>
    {fieldsVisited && <div id="qa-settings-panel-fields" role="tabpanel" aria-labelledby="qa-settings-tab-fields" hidden={tab !== 'fields'}><QaCustomFieldManager client={client} actor={actor} onDirtyChange={fieldsChanged} onBusyChange={fieldsBusy} /></div>}
    {manualStatesVisited && <div id="qa-settings-panel-manualStates" role="tabpanel" aria-labelledby="qa-settings-tab-manualStates" hidden={tab !== 'manualStates'}><QaManualStateVisibilitySettings client={client} actor={actor} workflow={workflow} onDirtyChange={manualStatesChanged} onBusyChange={manualStatesBusy} onClose={() => void close()} /></div>}
    {canSetCoordinators && tab === 'coordinators'  && <div id="qa-settings-panel-coordinators" role="tabpanel" aria-labelledby="qa-settings-tab-coordinators"><QaCoordinatorsPanel client={client} onSaved={onCoordinationSaved} /></div>}
  </div>{ConfirmDialog}</div>;
}

/** Pick a project, then its QA coordinator; no project has to be selected elsewhere first. */
function QaCoordinatorsPanel({ client, onSaved }: { client: QaClient; onSaved?: () => void }) {
  const { t } = useTranslation();
  const { allProjects, productLines } = useProjectContext();
  const [projectId, setProjectId] = useState('');
  return <div className="space-y-4">
    <div className="max-w-md rounded-xl border border-border/80 bg-card p-4 shadow-sm">
      <QaSelect label={t('qa.project')} value={projectId} onChange={event => setProjectId(event.target.value)}>
        <option value="">{t('qa.choose')}</option><ProjectSelectOptions groups={groupProjectsByLine(productLines, allProjects)} />
      </QaSelect>
      <p className="mt-2 text-xs text-muted-foreground">{t('qaHandoff.coordinatorButtonHint')}</p>
    </div>
    {projectId && <QaCoordinatorSettings key={projectId} client={client} projectId={projectId} onSaved={() => { toast.success(t('qaHandoff.coordinatorSaved')); onSaved?.(); }} onClose={() => setProjectId('')} />}
  </div>;
}
