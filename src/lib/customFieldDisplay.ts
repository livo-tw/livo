import type { CustomField, TaskCustomFieldValue, User } from '@/types';

type Translate = (key: string) => string;

/**
 * A task's custom field value as short text (task cards, exports), by field
 * type. Returns null when the task has no value for the field.
 */
export function formatCustomFieldValue(field: CustomField, value: TaskCustomFieldValue | undefined, users: User[], t: Translate): string | null {
  if (!value) return null;
  switch (field.fieldType) {
    case 'boolean': return value.valueBoolean === undefined ? null : t(value.valueBoolean ? 'customField.booleanYes' : 'customField.booleanNo');
    case 'user': return users.find(user => user.id === value.valueUserId)?.name ?? null;
    case 'number': return value.valueNumber === undefined || value.valueNumber === null ? null : String(value.valueNumber);
    case 'date': return value.valueDate || null;
    default: return value.valueText || null;
  }
}
