import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ArrowDown, ArrowUp, Plus, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { useDeploymentEnvironments } from '@/context/DeploymentEnvironmentContext';
import { useAuthContext } from '@/context/AuthContext';
import { parseDeploymentEnvironments } from '@/lib/deploymentEnvironments';

export default function DeploymentEnvironmentSettings() {
  const { t } = useTranslation();
  const { permissions } = useAuthContext();
  const config = useDeploymentEnvironments();
  const [draft, setDraft] = useState(config.values);
  const [revision, setRevision] = useState(config.revision);
  const [dirty, setDirty] = useState(false), [saving, setSaving] = useState(false);
  useEffect(() => { if (!dirty) { setDraft(config.values); setRevision(config.revision); } }, [config.values, config.revision, dirty]);
  if (!permissions.canManageStatuses) return null;
  const change = (values: string[]) => { setDirty(true); setDraft(values); };
  const move = (index: number, offset: number) => { const next = [...draft]; [next[index], next[index + offset]] = [next[index + offset], next[index]]; change(next); };
  const save = async () => {
    const next = draft.map(value => value.trim());
    if (!parseDeploymentEnvironments({ version: 1, values: next })) { toast.error(t('deploymentEnvironments.invalid')); return; }
    setSaving(true);
    try { await config.save(next, revision); setDirty(false); toast.success(t('deploymentEnvironments.saved')); }
    catch (error) { toast.error(t(error instanceof Error && error.message === 'environment-conflict' ? 'deploymentEnvironments.conflict' : 'deploymentEnvironments.saveFailed')); }
    finally { setSaving(false); }
  };
  return <section className="rounded-lg border border-border bg-card p-4 shadow-sm md:p-6">
    <h3 className="text-base font-semibold text-foreground">{t('deploymentEnvironments.title')}</h3>
    <p className="mt-1 text-sm text-muted-foreground">{t('deploymentEnvironments.description')}</p>
    <p className="mt-2 text-xs text-muted-foreground">{t('deploymentEnvironments.historyHint')}</p>
    {config.loadError && <p role="alert" className="mt-3 text-sm text-destructive">{t('deploymentEnvironments.loadFailed')} <button type="button" onClick={() => void config.reload()} className="underline">{t('deploymentEnvironments.reload')}</button></p>}
    <div className="mt-4 space-y-2">
      {draft.map((value, index) => <div key={index} className="flex items-center gap-2">
        <input aria-label={t('deploymentEnvironments.name', { number: index + 1 })} value={value} maxLength={120} disabled={saving || !config.ready}
          onChange={event => change(draft.map((item, i) => i === index ? event.target.value : item))} className="min-w-0 flex-1 rounded-md border border-border bg-background px-3 py-2 text-sm" />
        <button type="button" aria-label={t('deploymentEnvironments.moveUp')} disabled={!index || saving || !config.ready} onClick={() => move(index, -1)} className="p-2 disabled:opacity-30"><ArrowUp size={16} /></button>
        <button type="button" aria-label={t('deploymentEnvironments.moveDown')} disabled={index === draft.length - 1 || saving || !config.ready} onClick={() => move(index, 1)} className="p-2 disabled:opacity-30"><ArrowDown size={16} /></button>
        <button type="button" aria-label={t('deploymentEnvironments.remove')} disabled={draft.length <= 1 || saving || !config.ready} onClick={() => change(draft.filter((_, i) => i !== index))} className="p-2 text-destructive disabled:opacity-30"><Trash2 size={16} /></button>
      </div>)}
    </div>
    <div className="mt-4 flex flex-wrap gap-2">
      <button type="button" disabled={draft.length >= 30 || saving || !config.ready} onClick={() => change([...draft, ''])} className="inline-flex items-center gap-1 rounded-md border px-3 py-2 text-sm disabled:opacity-40"><Plus size={14} />{t('deploymentEnvironments.add')}</button>
      <button type="button" disabled={!dirty || saving || !config.ready} onClick={() => void save()} className="rounded-md bg-primary px-3 py-2 text-sm text-primary-foreground disabled:opacity-40">{t('deploymentEnvironments.save')}</button>
      {dirty && <button type="button" disabled={saving} onClick={() => { setDirty(false); void config.reload(); }} className="px-3 py-2 text-sm">{t('deploymentEnvironments.reload')}</button>}
    </div>
  </section>;
}
