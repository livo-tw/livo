import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ArrowDown, ArrowUp, Pencil, Plus } from 'lucide-react';
import { toast } from 'sonner';
import { CUSTOM_FIELD_TYPE_ICONS, CUSTOM_FIELD_TYPE_KEYS } from '@/lib/customFieldPresentation';
import { canManageQaConfiguration, validateQaFieldConfiguration, type QaFieldConfiguration, type QaFieldDefinition } from '@/lib/qa/fields';
import type { QaActor } from '@/lib/qa/domain';
import { qaId, type QaClient } from '@/lib/qa/client';
import { useQaNavigationGuard } from '@/hooks/useQaNavigationGuard';
import { QaFailure } from './QaIssueDetail';
import { QaField, QaSelect, qaButton, qaPrimary } from './QaFields';

const TYPES: QaFieldDefinition['fieldType'][] = ['text', 'textarea', 'number', 'select', 'date', 'boolean'];
type Editor = { field: QaFieldDefinition; optionsText: string; creating: boolean };

export default function QaCustomFieldManager({ client, actor, onDirtyChange, onBusyChange }: {
  client: QaClient; actor: QaActor; onDirtyChange?: (dirty: boolean) => void; onBusyChange?: (busy: boolean) => void;
}) {
  const { t } = useTranslation();
  const canManage = canManageQaConfiguration(actor);
  const [configuration, setConfiguration] = useState<QaFieldConfiguration | null>(null);
  const [editor, setEditor] = useState<Editor | null>(null);
  const [busy, setBusy] = useState(false), [error, setError] = useState<unknown>(null), [revision, setRevision] = useState(0);
  useQaNavigationGuard(busy);
  useEffect(() => { onBusyChange?.(busy); return () => onBusyChange?.(false); }, [busy, onBusyChange]);
  useEffect(() => { onDirtyChange?.(!!editor); return () => onDirtyChange?.(false); }, [!!editor, onDirtyChange]);
  useEffect(() => {
    if (!canManage) return;
    const controller = new AbortController(); setError(null);
    void client.getFieldConfiguration(controller.signal).then(value => { if (!controller.signal.aborted) setConfiguration(value); })
      .catch(failure => { if (!controller.signal.aborted) setError(failure); });
    return () => controller.abort();
  }, [client, canManage, revision]);
  const save = async (next: QaFieldConfiguration): Promise<boolean> => {
    if (!configuration || busy || !canManage) return false;
    setBusy(true); setError(null);
    try {
      const saved = await client.saveFieldConfiguration(validateQaFieldConfiguration(next, configuration));
      setConfiguration(saved); toast.success(t('qa.customFields.saved')); return true;
    } catch (failure) { setError(failure); toast.error(t('qa.failed'), { position: 'top-center' }); return false; }
    finally { setBusy(false); }
  };
  const fields = [...(configuration?.fields ?? [])].sort((a, b) => a.sortOrder - b.sortOrder);
  const move = (index: number, direction: -1 | 1) => {
    const reordered = [...fields]; [reordered[index], reordered[index + direction]] = [reordered[index + direction], reordered[index]];
    void save({ version: 1, fields: reordered.map((field, sortOrder) => ({ ...field, sortOrder })) });
  };
  const submitEditor = async (event: React.FormEvent) => {
    event.preventDefault(); if (!editor || !configuration || busy) return;
    const field = { ...editor.field, fieldName: editor.field.fieldName.trim() };
    if (field.fieldType === 'select') field.options = editor.optionsText.split(/\r?\n/).map(value => value.trim()).filter(Boolean);
    else delete field.options;
    const next = editor.creating ? [...configuration.fields, field] : configuration.fields.map(old => old.id === field.id ? field : old);
    if (await save({ version: 1, fields: next })) setEditor(null);
  };
  if (!canManage) return <p className="text-sm text-muted-foreground">{t('qa.customFields.forbidden')}</p>;
  return <section className="rounded-xl border border-border bg-card p-4 shadow-sm" aria-labelledby="qa-custom-fields-title">
    <header className="flex flex-wrap items-center justify-between gap-3"><div><h2 id="qa-custom-fields-title" className="text-lg font-semibold">{t('qa.customFields.title')}</h2><p className="mt-1 text-sm text-muted-foreground">{t('qa.customFields.hint')}</p></div>
      <button type="button" className={qaPrimary} disabled={!configuration || busy || !!editor || fields.length >= 50} onClick={() => {
        setError(null); setEditor({ creating: true, optionsText: '', field: { id: `qaf_${qaId()}`, fieldName: '', fieldType: 'text', isRequired: false, isEnabled: true, sortOrder: fields.length ? Math.max(...fields.map(field => field.sortOrder)) + 1 : 0 } });
      }}><Plus size={15} aria-hidden="true" />{t('customField.manager.addField')}</button>
    </header>
    {error !== null && <div className="mt-4 space-y-2"><QaFailure error={error} />{!configuration && <button type="button" className={qaButton} onClick={() => setRevision(value => value + 1)}>{t('qa.refresh')}</button>}</div>}
    {!configuration && error === null && <p role="status" className="py-6 text-sm text-muted-foreground">{t('qa.loading')}</p>}
    {configuration && <fieldset disabled={busy} className="mt-4 space-y-3">
      {!fields.length && !editor && <p className="rounded-lg border border-dashed border-border px-4 py-8 text-center text-sm text-muted-foreground">{t('customField.manager.empty')}</p>}
      {fields.map((field, index) => <div key={field.id} className={`flex flex-wrap items-center gap-3 rounded-lg border border-border px-3 py-3 ${field.isEnabled ? 'bg-background' : 'bg-muted/40 text-muted-foreground'}`}>
        <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-muted text-sm font-bold text-muted-foreground" aria-hidden="true">{CUSTOM_FIELD_TYPE_ICONS[field.fieldType]}</span>
        <div className="min-w-[140px] flex-1"><p className="break-words text-sm font-medium">{field.fieldName}{field.isRequired && <span className="ml-2 rounded bg-destructive/10 px-1.5 py-0.5 text-[10px] text-destructive">{t('common.required')}</span>}</p><p className="text-xs text-muted-foreground">{t(CUSTOM_FIELD_TYPE_KEYS[field.fieldType])}</p></div>
        <label className="inline-flex items-center gap-2 text-sm"><input type="checkbox" checked={field.isEnabled} disabled={!!editor} className="accent-primary" onChange={event => void save({ ...configuration, fields: configuration.fields.map(old => old.id === field.id ? { ...old, isEnabled: event.target.checked } : old) })} />{t('qa.customFields.enabled')}</label>
        <div className="flex gap-1"><button type="button" className={qaButton} disabled={!!editor || index === 0} aria-label={t('qa.workflowMoveUp', { name: field.fieldName })} onClick={() => move(index, -1)}><ArrowUp size={14} aria-hidden="true" /></button><button type="button" className={qaButton} disabled={!!editor || index === fields.length - 1} aria-label={t('qa.workflowMoveDown', { name: field.fieldName })} onClick={() => move(index, 1)}><ArrowDown size={14} aria-hidden="true" /></button><button type="button" className={qaButton} disabled={!!editor} aria-label={t('qa.customFields.editField', { name: field.fieldName })} onClick={() => { setError(null); setEditor({ field: { ...field }, optionsText: (field.options ?? []).join('\n'), creating: false }); }}><Pencil size={14} aria-hidden="true" /></button></div>
      </div>)}
      {editor && <form className="rounded-xl border border-primary/30 bg-primary/5 p-4" onSubmit={event => void submitEditor(event)}>
        <h3 className="mb-3 text-sm font-semibold">{t(editor.creating ? 'customField.manager.addField' : 'qa.customFields.editTitle')}</h3>
        <div className="grid gap-3 sm:grid-cols-2"><QaField label={t('customField.manager.fieldNameLabel')} value={editor.field.fieldName} required maxLength={120} autoFocus onChange={event => setEditor({ ...editor, field: { ...editor.field, fieldName: event.target.value } })} />
          <QaSelect label={t('customField.manager.fieldTypeLabel')} value={editor.field.fieldType} disabled={!editor.creating} onChange={event => setEditor({ ...editor, field: { ...editor.field, fieldType: event.target.value as QaFieldDefinition['fieldType'] } })}>{TYPES.map(type => <option key={type} value={type}>{t(CUSTOM_FIELD_TYPE_KEYS[type])}</option>)}</QaSelect>
          {editor.field.fieldType === 'select' && <div className="sm:col-span-2"><QaField label={t('customField.manager.optionsLabel')} hint={t('qa.customFields.optionsHint')} multiline required value={editor.optionsText} onChange={event => setEditor({ ...editor, optionsText: event.target.value })} /></div>}
        </div>
        <label className="mt-3 inline-flex items-center gap-2 text-sm"><input type="checkbox" className="accent-primary" checked={editor.field.isRequired} onChange={event => setEditor({ ...editor, field: { ...editor.field, isRequired: event.target.checked } })} />{t('customField.manager.requiredField')}</label>
        {!editor.creating && <p className="mt-2 text-xs text-muted-foreground">{t('qa.customFields.typeLocked')}</p>}
        <div className="mt-4 flex gap-2"><button type="submit" className={qaPrimary}>{t(busy ? 'qa.saving' : 'qa.save')}</button><button type="button" className={qaButton} onClick={() => { setEditor(null); setError(null); }}>{t('qa.cancel')}</button></div>
      </form>}
    </fieldset>}
    <p className="mt-3 text-xs text-muted-foreground">{t('qa.customFields.preserveHint')}</p>
  </section>;
}
