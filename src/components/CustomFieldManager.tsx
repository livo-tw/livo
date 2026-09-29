import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useTaskContext } from '@/context/TaskContext';
import { useConfirmDialog } from '@/components/ConfirmDialog';
import { CustomField, CustomFieldType } from '@/types';
import { X, Plus, Pencil, Trash2, GripVertical, ChevronDown, ChevronUp, Calendar } from 'lucide-react';
import { toast } from 'sonner';
const FIELD_TYPE_KEYS: Record<CustomFieldType, string> = {
  text: 'customField.types.text',
  textarea: 'customField.types.textarea',
  number: 'customField.types.number',
  select: 'customField.types.select',
  date: 'customField.types.date',
  boolean: 'customField.types.boolean',
  user: 'customField.types.user',
};

const FIELD_TYPE_ICONS: Record<CustomFieldType, string> = {
  text: 'T',
  textarea: '¶',
  number: '#',
  select: '▾',
  date: 'D',
  boolean: '☑',
  user: 'U',
};

interface Props {
  projectId: string;
  onClose: () => void;
}

const CustomFieldManager = ({ projectId, onClose }: Props) => {
  const { t } = useTranslation();
  const { customFields, createCustomField, updateCustomField, deleteCustomField } = useTaskContext();
  const { confirm, ConfirmDialog } = useConfirmDialog();

  const projectFields = customFields
    .filter(f => f.projectId === projectId)
    .sort((a, b) => a.sortOrder - b.sortOrder);

  const [creating, setCreating] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);

  // Form state for create/edit
  const [formName, setFormName] = useState('');
  const [formType, setFormType] = useState<CustomFieldType>('text');
  const [formRequired, setFormRequired] = useState(false);
  const [formDefault, setFormDefault] = useState('');
  const [formOptions, setFormOptions] = useState('');  // comma-separated string

  const resetForm = () => {
    setFormName('');
    setFormType('text');
    setFormRequired(false);
    setFormDefault('');
    setFormOptions('');
  };

  const startCreate = () => {
    resetForm();
    setEditingId(null);
    setCreating(true);
  };

  const startEdit = (field: CustomField) => {
    setFormName(field.fieldName);
    setFormType(field.fieldType);
    setFormRequired(field.isRequired);
    setFormDefault(field.defaultValue || '');
    setFormOptions(field.options ? field.options.join(', ') : '');
    setEditingId(field.id);
    setCreating(false);
  };

  const cancelForm = () => {
    setCreating(false);
    setEditingId(null);
    resetForm();
  };

  const parseOptions = (raw: string): string[] =>
    raw.split(',').map(s => s.trim()).filter(Boolean);

  const handleSave = async () => {
    if (!formName.trim()) { toast.error(t('customField.manager.nameRequired')); return; }
    if (formType === 'select' && parseOptions(formOptions).length === 0) {
      toast.error(t('customField.manager.selectRequiresOptions')); return;
    }

    const options = formType === 'select' ? parseOptions(formOptions) : undefined;

    try {
      if (creating) {
        const maxOrder = projectFields.length > 0 ? Math.max(...projectFields.map(f => f.sortOrder)) : -1;
        await createCustomField({
          projectId,
          fieldName: formName.trim(),
          fieldType: formType,
          options,
          isRequired: formRequired,
          defaultValue: formDefault.trim() || undefined,
          sortOrder: maxOrder + 1,
        });
        toast.success(t('customField.manager.created', { name: formName.trim() }));
      } else if (editingId) {
        await updateCustomField(editingId, {
          fieldName: formName.trim(),
          fieldType: formType,
          options,
          isRequired: formRequired,
          defaultValue: formDefault.trim() || undefined,
        });
        toast.success(t('customField.manager.updated'));
      }
      cancelForm();
    } catch (err: any) {
      toast.error(t('error.operationFailed'));
      console.error(err);
    }
  };

  const handleDelete = async (field: CustomField) => {
    if (!(await confirm({ title: t('project.deleteTitle'), description: t('customField.manager.deleteConfirm', { name: field.fieldName }), destructive: true }))) return;
    try {
      await deleteCustomField(field.id);
      toast.success(t('customField.manager.deleted', { name: field.fieldName }));
    } catch (err: any) {
      toast.error(t('error.operationFailed'));
      console.error(err);
    }
  };

  const moveField = async (field: CustomField, direction: 'up' | 'down') => {
    const idx = projectFields.findIndex(f => f.id === field.id);
    const swapIdx = direction === 'up' ? idx - 1 : idx + 1;
    if (swapIdx < 0 || swapIdx >= projectFields.length) return;
    const swapField = projectFields[swapIdx];
    try {
      await Promise.all([
        updateCustomField(field.id, { sortOrder: swapField.sortOrder }),
        updateCustomField(swapField.id, { sortOrder: field.sortOrder }),
      ]);
    } catch (err: any) {
      toast.error(t('error.operationFailed'));
      console.error(err);
    }
  };

  const isFormOpen = creating || editingId !== null;

  return (
    <>
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <div className="bg-card border border-border rounded-xl shadow-2xl w-full max-w-lg flex flex-col max-h-[90vh]">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-border flex-shrink-0">
          <h2 className="text-base font-semibold text-foreground">{t('customField.manager.title')}</h2>
          <button onClick={onClose} className="text-muted-foreground hover:text-foreground transition-colors">
            <X size={18} />
          </button>
        </div>

        {/* Field list */}
        <div className="flex-1 overflow-y-auto px-5 py-3 space-y-2 min-h-0">
          {projectFields.length === 0 && !isFormOpen && (
            <p className="text-sm text-muted-foreground text-center py-6">
              {t('customField.manager.empty')}<br />
              <span className="text-xs">{t('customField.manager.emptyHint')}</span>
            </p>
          )}

          {projectFields.map((field, idx) => {
            const isEditing = editingId === field.id;
            return (
              <div key={field.id} className={`rounded-lg border transition-colors ${isEditing ? 'border-primary/50 bg-primary/5' : 'border-border bg-muted/30'}`}>
                {isEditing ? (
                  <div className="p-3">
                    <FieldForm
                      formName={formName} setFormName={setFormName}
                      formType={formType} setFormType={setFormType}
                      formRequired={formRequired} setFormRequired={setFormRequired}
                      formDefault={formDefault} setFormDefault={setFormDefault}
                      formOptions={formOptions} setFormOptions={setFormOptions}
                      onSave={handleSave} onCancel={cancelForm}
                      saveLabel={t('common.save')}
                    />
                  </div>
                ) : (
                  <div className="flex items-center gap-2 px-3 py-2.5">
                    {/* Sort buttons */}
                    <div className="flex flex-col gap-0.5 flex-shrink-0">
                      <button
                        onClick={() => moveField(field, 'up')}
                        disabled={idx === 0}
                        className="text-muted-foreground hover:text-foreground disabled:opacity-20 transition-colors"
                      >
                        <ChevronUp size={12} />
                      </button>
                      <button
                        onClick={() => moveField(field, 'down')}
                        disabled={idx === projectFields.length - 1}
                        className="text-muted-foreground hover:text-foreground disabled:opacity-20 transition-colors"
                      >
                        <ChevronDown size={12} />
                      </button>
                    </div>

                    {/* Type icon */}
                    <span className="w-6 h-6 rounded flex items-center justify-center text-xs font-bold bg-muted text-muted-foreground flex-shrink-0">
                      {FIELD_TYPE_ICONS[field.fieldType]}
                    </span>

                    {/* Field info */}
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-1.5">
                        <span className="text-sm font-medium text-foreground truncate">{field.fieldName}</span>
                        {field.isRequired && (
                          <span className="text-[10px] px-1 py-0.5 rounded bg-destructive/15 text-destructive font-medium flex-shrink-0">{t('common.required')}</span>
                        )}
                      </div>
                      <span className="text-[11px] text-muted-foreground">{t(FIELD_TYPE_KEYS[field.fieldType])}</span>
                      {field.fieldType === 'select' && field.options && field.options.length > 0 && (
                        <span className="text-[10px] text-muted-foreground ml-1">
                          ({field.options.slice(0, 3).join('、')}{field.options.length > 3 ? `…+${field.options.length - 3}` : ''})
                        </span>
                      )}
                    </div>

                    {/* Actions */}
                    <div className="flex items-center gap-1 flex-shrink-0">
                      <button
                        onClick={() => startEdit(field)}
                        className="p-1 text-muted-foreground hover:text-foreground transition-colors"
                        title={t('common.edit')}
                      >
                        <Pencil size={13} />
                      </button>
                      <button
                        onClick={() => handleDelete(field)}
                        className="p-1 text-muted-foreground hover:text-destructive transition-colors"
                        title={t('common.delete')}
                      >
                        <Trash2 size={13} />
                      </button>
                    </div>
                  </div>
                )}
              </div>
            );
          })}

          {/* Create form */}
          {creating && (
            <div className="rounded-lg border border-primary/50 bg-primary/5 p-3">
              <p className="text-xs font-medium text-primary mb-2">{t('customField.manager.addField')}</p>
              <FieldForm
                formName={formName} setFormName={setFormName}
                formType={formType} setFormType={setFormType}
                formRequired={formRequired} setFormRequired={setFormRequired}
                formDefault={formDefault} setFormDefault={setFormDefault}
                formOptions={formOptions} setFormOptions={setFormOptions}
                onSave={handleSave} onCancel={cancelForm}
                saveLabel={t('common.create')}
              />
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="px-5 py-3 border-t border-border flex-shrink-0">
          {!isFormOpen ? (
            <button
              onClick={startCreate}
              className="w-full flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg text-sm font-medium border border-dashed border-primary/50 text-primary hover:bg-primary/5 transition-colors"
            >
              <Plus size={14} />
              {t('customField.manager.addField')}
            </button>
          ) : (
            <p className="text-xs text-muted-foreground text-center">{t('customField.manager.fillFormHint', { action: creating ? t('common.create') : t('common.save') })}</p>
          )}
        </div>
      </div>
    </div>
    {ConfirmDialog}
    </>
  );
};

// Sub-component: the create/edit form
interface FieldFormProps {
  formName: string; setFormName: (v: string) => void;
  formType: CustomFieldType; setFormType: (v: CustomFieldType) => void;
  formRequired: boolean; setFormRequired: (v: boolean) => void;
  formDefault: string; setFormDefault: (v: string) => void;
  formOptions: string; setFormOptions: (v: string) => void;
  onSave: () => void;
  onCancel: () => void;
  saveLabel: string;
}

const FieldForm = ({
  formName, setFormName, formType, setFormType,
  formRequired, setFormRequired, formDefault, setFormDefault,
  formOptions, setFormOptions, onSave, onCancel, saveLabel,
}: FieldFormProps) => {
  const { t } = useTranslation();
  return (
  <div className="space-y-2.5">
    {/* Name */}
    <div>
      <label className="text-[11px] font-medium text-muted-foreground uppercase tracking-wider">{t('customField.manager.fieldNameLabel')}</label>
      <input
        type="text"
        value={formName}
        onChange={e => setFormName(e.target.value)}
        placeholder={t('customField.manager.fieldNamePlaceholder')}
        className="w-full mt-1 text-sm rounded px-2.5 py-1.5 border border-border bg-background text-foreground placeholder:text-muted-foreground/50 outline-none focus:ring-1 focus:ring-primary"
        autoFocus
      />
    </div>

    {/* Type */}
    <div>
      <label className="text-[11px] font-medium text-muted-foreground uppercase tracking-wider">{t('customField.manager.fieldTypeLabel')}</label>
      <select
        value={formType}
        onChange={e => setFormType(e.target.value as CustomFieldType)}
        className="w-full mt-1 text-sm rounded px-2.5 py-1.5 border border-border bg-background text-foreground outline-none focus:ring-1 focus:ring-primary"
      >
        {(Object.keys(FIELD_TYPE_KEYS) as CustomFieldType[]).map(ft => (
          <option key={ft} value={ft}>{FIELD_TYPE_ICONS[ft]} {t(FIELD_TYPE_KEYS[ft])}</option>
        ))}
      </select>
    </div>

    {/* Options (only for select) */}
    {formType === 'select' && (
      <div>
        <label className="text-[11px] font-medium text-muted-foreground uppercase tracking-wider">{t('customField.manager.optionsLabel')}</label>
        <input
          type="text"
          value={formOptions}
          onChange={e => setFormOptions(e.target.value)}
          placeholder={t('customField.manager.optionsPlaceholder')}
          className="w-full mt-1 text-sm rounded px-2.5 py-1.5 border border-border bg-background text-foreground placeholder:text-muted-foreground/50 outline-none focus:ring-1 focus:ring-primary"
        />
      </div>
    )}

    {/* Default value (not for boolean/user) */}
    {formType !== 'boolean' && formType !== 'user' && formType !== 'select' && (
      <div>
        <label className="text-[11px] font-medium text-muted-foreground uppercase tracking-wider">{t('customField.manager.defaultValueLabel')}</label>
        <input
          type={formType === 'number' ? 'number' : formType === 'date' ? 'date' : 'text'}
          value={formDefault}
          onChange={e => setFormDefault(e.target.value)}
          placeholder={t('customField.manager.defaultValuePlaceholder')}
          className="w-full mt-1 text-sm rounded px-2.5 py-1.5 border border-border bg-background text-foreground placeholder:text-muted-foreground/50 outline-none focus:ring-1 focus:ring-primary"
        />
      </div>
    )}

    {/* Required */}
    <label className="flex items-center gap-2 cursor-pointer select-none">
      <input
        type="checkbox"
        checked={formRequired}
        onChange={e => setFormRequired(e.target.checked)}
        className="rounded border-border accent-primary"
      />
      <span className="text-sm text-foreground">{t('customField.manager.requiredField')}</span>
    </label>

    {/* Actions */}
    <div className="flex gap-2 pt-1">
      <button
        onClick={onSave}
        className="flex-1 px-3 py-1.5 rounded text-xs font-medium bg-primary text-primary-foreground hover:bg-primary/90 transition-colors"
      >
        {saveLabel}
      </button>
      <button
        onClick={onCancel}
        className="flex-1 px-3 py-1.5 rounded text-xs font-medium border border-border text-muted-foreground hover:bg-accent transition-colors"
      >
        {t('common.cancel')}
      </button>
    </div>
  </div>
  );
};

export default CustomFieldManager;
