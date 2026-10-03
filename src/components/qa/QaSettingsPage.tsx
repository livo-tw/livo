import { useCallback, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ArrowLeft, ListChecks, Settings2 } from 'lucide-react';
import { toast } from 'sonner';
import { useConfirmDialog } from '@/components/ConfirmDialog';
import { useQaNavigationGuard } from '@/hooks/useQaNavigationGuard';
import type { QaActor } from '@/lib/qa/domain';
import type { QaClient } from '@/lib/qa/client';
import type { QaWorkflow } from '@/lib/qa/workflow';
import { canManageQaConfiguration } from '@/lib/qa/fields';
import QaCustomFieldManager from './QaCustomFieldManager';
import QaWorkflowSettings from './QaWorkflowSettings';
import { qaButton } from './QaFields';

export default function QaSettingsPage({ client, actor, workflow, onWorkflowSaved, onClose }: {
  client: QaClient; actor: QaActor; workflow: QaWorkflow;
  onWorkflowSaved: (workflow: QaWorkflow) => void; onClose: () => void;
}) {
  const { t } = useTranslation();
  const { confirm, ConfirmDialog } = useConfirmDialog();
  const [tab, setTab] = useState<'workflow' | 'fields'>('workflow');
  const [fieldsVisited, setFieldsVisited] = useState(false), [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const pending = useRef({ workflow: false, fields: false });
  const workflowBusy = useCallback((value: boolean) => { pending.current.workflow = value; setBusy(pending.current.workflow || pending.current.fields); }, []);
  const fieldsBusy = useCallback((value: boolean) => { pending.current.fields = value; setBusy(pending.current.workflow || pending.current.fields); }, []);
  const changes = useRef({ workflow: false, fields: false });
  const workflowChanged = useCallback((value: boolean) => { changes.current.workflow = value; setDirty(changes.current.workflow || changes.current.fields); }, []);
  const fieldsChanged = useCallback((value: boolean) => { changes.current.fields = value; setDirty(changes.current.workflow || changes.current.fields); }, []);
  useQaNavigationGuard(dirty);
  const close = async () => {
    if (pending.current.workflow || pending.current.fields) { toast.info(t('qa.finishPending')); return; }
    if (changes.current.workflow || changes.current.fields) {
      if (!await confirm({ title: t('qa.customFields.discardTitle'), description: t('qa.customFields.discardHint'), destructive: true })) return;
    }
    onClose();
  };
  if (!canManageQaConfiguration(actor)) return <p className="p-5 text-sm text-muted-foreground">{t('qa.customFields.forbidden')}</p>;
  return <div className="min-w-0 flex-1 overflow-y-auto bg-board p-3 md:p-5"><div className="w-full space-y-4">
    <header className="flex flex-wrap items-center justify-between gap-3"><div className="flex items-center gap-3"><div className="rounded-xl bg-primary/10 p-2.5 text-primary"><Settings2 size={22} aria-hidden="true" /></div><div><h1 className="text-xl font-bold">{t('qa.settingsTitle')}</h1><p className="mt-1 text-xs text-muted-foreground">{t('qa.settingsHint')}</p></div></div><button type="button" className={qaButton} disabled={busy} onClick={() => void close()}><ArrowLeft size={15} aria-hidden="true" />{t('qa.back')}</button></header>
    <div className="flex flex-wrap gap-2" role="tablist" aria-label={t('qa.settingsTitle')}>
      {([{ id: 'workflow', label: 'qa.workflowTitle', icon: Settings2 }, { id: 'fields', label: 'qa.customFields.title', icon: ListChecks }] as const).map(({ id, label, icon: Icon }) =>
        <button type="button" key={id} role="tab" id={`qa-settings-tab-${id}`} aria-controls={`qa-settings-panel-${id}`} aria-selected={tab === id}
          className={`${qaButton} ${tab === id ? 'border-primary/30 bg-primary/10 text-primary' : 'text-muted-foreground'}`}
          onClick={() => { setTab(id); if (id === 'fields') setFieldsVisited(true); }}><Icon size={15} aria-hidden="true" />{t(label)}</button>)}
    </div>
    <div id="qa-settings-panel-workflow" role="tabpanel" aria-labelledby="qa-settings-tab-workflow" hidden={tab !== 'workflow'}>
      <QaWorkflowSettings client={client} actor={actor} workflow={workflow} onDirtyChange={workflowChanged} onBusyChange={workflowBusy} onSaved={value => { workflowChanged(false); workflowBusy(false); onWorkflowSaved(value); }} onClose={() => void close()} />
    </div>
    {fieldsVisited && <div id="qa-settings-panel-fields" role="tabpanel" aria-labelledby="qa-settings-tab-fields" hidden={tab !== 'fields'}><QaCustomFieldManager client={client} actor={actor} onDirtyChange={fieldsChanged} onBusyChange={fieldsBusy} /></div>}
  </div>{ConfirmDialog}</div>;
}
