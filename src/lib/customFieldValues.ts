import type { CustomField, TaskCustomFieldValue } from '@/types';

export type CustomFieldDraft = Partial<Pick<TaskCustomFieldValue, 'valueText' | 'valueNumber' | 'valueDate' | 'valueBoolean' | 'valueUserId'>>;

/** The field's default value (stored as text) in the shape of its type; empty when there is none or it does not fit. */
export function customFieldDefault(field: CustomField): CustomFieldDraft {
  const raw = field.defaultValue?.trim();
  if (!raw) return {};
  switch (field.fieldType) {
    case 'text': case 'textarea': return { valueText: raw };
    case 'select': return (field.options || []).includes(raw) ? { valueText: raw } : {};
    case 'number': return Number.isFinite(Number(raw)) ? { valueNumber: Number(raw) } : {};
    case 'date': return /^\d{4}-\d{2}-\d{2}$/.test(raw) ? { valueDate: raw } : {};
    case 'boolean': return ['true', '1', 'yes', 'y'].includes(raw.toLowerCase()) ? { valueBoolean: true } : ['false', '0', 'no', 'n'].includes(raw.toLowerCase()) ? { valueBoolean: false } : {};
    case 'user': return { valueUserId: raw };
    default: return {};
  }
}

/** Whether a value counts as filled in for a required field. A checkbox always has an answer. */
export function customFieldFilled(field: CustomField, value: CustomFieldDraft | undefined): boolean {
  if (field.fieldType === 'boolean') return true;
  if (!value) return false;
  switch (field.fieldType) {
    case 'number': return value.valueNumber !== undefined && Number.isFinite(value.valueNumber);
    case 'date': return !!value.valueDate;
    case 'user': return !!value.valueUserId;
    default: return !!value.valueText?.trim();
  }
}

/** Whether there is anything to save for the field (a default or something typed). */
export function customFieldHasValue(value: CustomFieldDraft | undefined): boolean {
  return !!value && Object.values(value).some(v => v !== undefined && v !== '');
}
