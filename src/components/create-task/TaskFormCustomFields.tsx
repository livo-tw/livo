import { useTranslation } from 'react-i18next';
import type { CustomField } from '@/types';
import type { CustomFieldDraft } from '@/lib/customFieldValues';
import { customFieldFilled } from '@/lib/customFieldValues';
import { CustomFieldInput } from '@/components/task-detail/fields/CustomFieldInput';

/** The project's custom fields when creating a task: defaults filled in, required ones checked. */
export default function TaskFormCustomFields({ fields, values, onChange, showValidationErrors }: {
  fields: CustomField[];
  values: Record<string, CustomFieldDraft>;
  onChange: (fieldId: string, value: CustomFieldDraft) => void;
  showValidationErrors: boolean;
}) {
  const { t } = useTranslation();
  if (!fields.length) return null;
  const noop = () => {};
  return <div className="space-y-3">
    <h4 className="text-xs font-semibold text-muted-foreground">{t('taskDetail.sidebar.customFields')}</h4>
    {fields.map(field => {
      const missing = showValidationErrors && field.isRequired && !customFieldFilled(field, values[field.id]);
      return <div key={field.id} className={missing ? 'rounded ring-1 ring-destructive/60 p-1 -m-1' : undefined}>
        <CustomFieldInput field={field} cv={{ id: '', taskId: '', fieldId: field.id, ...values[field.id] }} isLocked={false} locker={undefined}
          onChange={partial => onChange(field.id, { ...values[field.id], ...partial })} onFocus={noop} onBlur={noop} />
      </div>;
    })}
  </div>;
}
