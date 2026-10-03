import { useTranslation } from 'react-i18next';
import { SearchableSelect } from '@/components/ui/searchable-select';
import { isCustomFieldScalarValid } from '@/lib/qa/customFieldTypes';
import type { QaCustomFieldValues, QaFieldDefinition } from '@/lib/qa/fields';
import { QaField, qaInput } from './QaFields';

const hasValue = (value: unknown) => value !== undefined && value !== null && value !== '';
const ordered = (fields: readonly QaFieldDefinition[]) => [...fields].sort((a, b) => a.sortOrder - b.sortOrder);

export function QaCustomFieldInputs({ fields, values, onChange, disabled = false }: {
  fields: readonly QaFieldDefinition[]; values: QaCustomFieldValues;
  onChange: (values: QaCustomFieldValues) => void; disabled?: boolean;
}) {
  const { t } = useTranslation();
  const update = (id: string, value: QaCustomFieldValues[string]) => onChange({ ...values, [id]: value });
  const active = ordered(fields).filter(field => field.isEnabled);
  const historical = ordered(fields).filter(field => !field.isEnabled && hasValue(values[field.id]));
  if (!active.length && !historical.length) return null;
  return <div className="space-y-4">
    <div className="grid min-w-0 gap-4 sm:grid-cols-2">{active.map(field => {
      const value = values[field.id];
      if (field.fieldType === 'boolean' || field.fieldType === 'select') {
        const chosen = hasValue(value) ? String(value) : '';
        const options = field.options ?? [];
        const legacy = field.fieldType === 'select' && !!chosen && !options.includes(chosen);
        return <label key={field.id} className="block min-w-0 space-y-1 text-sm"><span className="font-medium">{field.fieldName}{field.isRequired ? ' *' : ''}</span>
          <SearchableSelect name={`qa_custom_${field.id}`} aria-label={field.fieldName} className={qaInput} value={chosen} disabled={disabled} required={field.isRequired}
            onChange={event => update(field.id, event.target.value === '' ? null : field.fieldType === 'boolean' ? event.target.value === 'true' : event.target.value)}>
            <option value="">{t('qa.choose')}</option>
            {field.fieldType === 'boolean' ? <><option value="true">{t('qa.customFields.yes')}</option><option value="false">{t('qa.customFields.no')}</option></>
              : <>{legacy && <option value={chosen}>{t('qa.customFields.historicalChoice', { value: chosen })}</option>}{options.map(option => <option key={option} value={option}>{option}</option>)}</>}
          </SearchableSelect>
        </label>;
      }
      return <div key={field.id} className={field.fieldType === 'textarea' ? 'sm:col-span-2' : undefined}>
        <QaField name={`qa_custom_${field.id}`} label={field.fieldName} multiline={field.fieldType === 'textarea'}
          type={field.fieldType === 'date' ? 'date' : field.fieldType === 'number' ? 'number' : 'text'}
          step={field.fieldType === 'number' ? 'any' : undefined} maxLength={field.fieldType === 'textarea' ? 20000 : field.fieldType === 'text' ? 4000 : undefined}
          value={hasValue(value) ? String(value) : ''} disabled={disabled} required={field.isRequired}
          onChange={event => {
            const raw = event.target.value;
            const next = raw === '' ? null : field.fieldType === 'number' ? Number(raw) : raw;
            if (isCustomFieldScalarValid(field.fieldType, next)) { event.target.setCustomValidity(''); update(field.id, next); }
            else event.target.setCustomValidity(t('qa.customFields.invalidValue'));
          }} />
      </div>;
    })}</div>
    {!!historical.length && <div className="rounded-lg border border-border/60 bg-muted/20 p-3 text-sm">
      <h3 className="mb-2 text-xs font-medium text-muted-foreground">{t('qa.customFields.disabledTitle')}</h3>
      <QaCustomFieldDisplay fields={historical} values={values} />
    </div>}
  </div>;
}

export function QaCustomFieldDisplay({ fields, values }: { fields: readonly QaFieldDefinition[]; values: QaCustomFieldValues }) {
  const { t } = useTranslation();
  const visible = ordered(fields).filter(field => field.isEnabled || hasValue(values[field.id]));
  if (!visible.length) return null;
  return <dl className="grid min-w-0 gap-3 sm:grid-cols-2">{visible.map(field => {
    const value = values[field.id];
    return <div key={field.id} className={field.fieldType === 'textarea' ? 'sm:col-span-2' : undefined}>
      <dt className="mb-1 text-xs text-muted-foreground">{field.fieldName}{!field.isEnabled && <span className="ml-1">· {t('qa.customFields.disabled')}</span>}</dt>
      <dd className="whitespace-pre-wrap break-words text-sm">{!hasValue(value) ? t('qa.notProvided') : typeof value === 'boolean' ? t(value ? 'qa.customFields.yes' : 'qa.customFields.no') : String(value)}</dd>
    </div>;
  })}</dl>;
}
