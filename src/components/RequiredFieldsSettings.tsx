import { useState, useEffect, useMemo, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { useUIContext, type RequiredFieldsConfig } from '@/context/UIContext';
import { useAuthContext } from '@/context/AuthContext';
import { useTaskContext } from '@/context/TaskContext';
import { REQUIRED_FIELD_DEFS } from '@/lib/fieldRegistry';
import { toast } from 'sonner';
import { supabase } from '@/integrations/supabase/client';

interface RequiredFieldsSettingsProps {
  projectId?: string; // if provided, only show custom fields for this project
}

const RequiredFieldsSettings = ({ projectId }: RequiredFieldsSettingsProps = {}) => {
  const { t } = useTranslation();
  const { requiredFields, saveRequiredFields } = useUIContext();
  const { permissions } = useAuthContext();
  const { customFields } = useTaskContext();
  const [localBuiltin, setLocalBuiltin] = useState<RequiredFieldsConfig>(requiredFields);
  const [localCustom, setLocalCustom] = useState<Set<string>>(new Set());
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setLocalBuiltin(requiredFields);
    loadCustomRequiredFields();
  }, [requiredFields]);

  const loadCustomRequiredFields = useCallback(async () => {
    try {
      const { data } = await supabase
        .from('system_settings')
        .select('value')
        .eq('key', 'required_custom_fields')
        .maybeSingle();
      if (data?.value && typeof data.value === 'object' && Array.isArray(data.value)) {
        setLocalCustom(new Set(data.value));
      }
    } catch {
      // If the setting doesn't exist, that's fine
      setLocalCustom(new Set());
    }
  }, []);

  const canEdit = permissions.canManageStatuses; // admin or super_admin

  // Filter custom fields based on projectId if provided
  const relevantCustomFields = useMemo(() => {
    if (projectId) {
      return customFields.filter(f => f.projectId === projectId);
    }
    return customFields;
  }, [customFields, projectId]);

  const handleToggleBuiltin = (key: keyof RequiredFieldsConfig) => {
    // title and project are always required, can't be toggled off
    if (key === 'title' || key === 'project') return;
    setLocalBuiltin(prev => ({ ...prev, [key]: !prev[key] }));
  };

  const handleToggleCustom = (fieldId: string) => {
    setLocalCustom(prev => {
      const next = new Set(prev);
      if (next.has(fieldId)) {
        next.delete(fieldId);
      } else {
        next.add(fieldId);
      }
      return next;
    });
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      // Save builtin fields
      await saveRequiredFields(localBuiltin);

      // Save custom required fields separately
      await supabase
        .from('system_settings')
        .upsert({
          key: 'required_custom_fields',
          value: Array.from(localCustom),
          updated_at: new Date().toISOString()
        } as Parameters<typeof supabase.from<'system_settings'>>[0] extends string ? never : Record<string, unknown>);

      toast.success(t('requiredFields.saveSuccess'));
    } catch (error) {
      console.error('Error saving required fields:', error);
      toast.error(t('requiredFields.saveError'));
    } finally {
      setSaving(false);
    }
  };

  const builtinHasChanges = JSON.stringify(localBuiltin) !== JSON.stringify(requiredFields);
  const hasChanges = builtinHasChanges; // Custom field changes are tracked automatically

  const groups = [...new Set(REQUIRED_FIELD_DEFS.map(f => f.group))];

  return (
    <div className="space-y-4">
      {groups.map(group => (
        <div key={group}>
          <h4 className="text-sm font-semibold text-muted-foreground mb-2">{group}</h4>
          <div className="grid grid-cols-2 md:grid-cols-3 gap-2">
            {REQUIRED_FIELD_DEFS.filter(f => f.group === group).map(field => {
              const fieldKey = field.key as keyof RequiredFieldsConfig;
              const isLocked = field.key === 'title' || field.key === 'project';
              const checked = localBuiltin[fieldKey] ?? false;
              return (
                <label
                  key={field.key}
                  className={`flex items-center gap-2 px-3 py-2 rounded-lg border transition-colors cursor-pointer ${
                    checked ? 'border-primary/40 bg-primary/5' : 'border-border bg-card'
                  } ${isLocked ? 'opacity-60 cursor-not-allowed' : 'hover:bg-accent'}`}
                >
                  <input
                    type="checkbox"
                    checked={checked}
                    onChange={() => handleToggleBuiltin(fieldKey)}
                    disabled={!canEdit || isLocked}
                    className="rounded border-border text-primary focus:ring-primary"
                  />
                  <span className="text-sm text-foreground">{field.label}</span>
                  {isLocked && <span className="text-[10px] text-muted-foreground ml-auto">{t('requiredFields.locked')}</span>}
                </label>
              );
            })}
          </div>
        </div>
      ))}

      {relevantCustomFields.length > 0 && (
        <div>
          <h4 className="text-sm font-semibold text-muted-foreground mb-2">{t('requiredFields.customFieldsLabel')}</h4>
          <div className="grid grid-cols-2 md:grid-cols-3 gap-2">
            {relevantCustomFields.map(field => {
              const checked = localCustom.has(field.id);
              return (
                <label
                  key={field.id}
                  className={`flex items-center gap-2 px-3 py-2 rounded-lg border transition-colors cursor-pointer ${
                    checked ? 'border-primary/40 bg-primary/5' : 'border-border bg-card'
                  } ${!canEdit ? 'opacity-60 cursor-not-allowed' : 'hover:bg-accent'}`}
                >
                  <input
                    type="checkbox"
                    checked={checked}
                    onChange={() => handleToggleCustom(field.id)}
                    disabled={!canEdit}
                    className="rounded border-border text-primary focus:ring-primary"
                  />
                  <span className="text-sm text-foreground">{field.fieldName}</span>
                </label>
              );
            })}
          </div>
        </div>
      )}

      {canEdit && hasChanges && (
        <div className="flex justify-end pt-2">
          <button
            onClick={handleSave}
            disabled={saving}
            className="px-4 py-2 text-sm font-medium rounded-lg bg-primary text-primary-foreground hover:bg-primary/90 transition-colors disabled:opacity-50"
          >
            {saving ? t('common.saving') : t('requiredFields.saveButton')}
          </button>
        </div>
      )}
    </div>
  );
};

export default RequiredFieldsSettings;
