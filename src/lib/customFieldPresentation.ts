import type { CustomFieldType } from '@/types';

/** Task and QA field editors share the same type names and visual cues. */
export const CUSTOM_FIELD_TYPE_KEYS: Record<CustomFieldType, string> = {
  text: 'customField.types.text', textarea: 'customField.types.textarea', number: 'customField.types.number',
  select: 'customField.types.select', date: 'customField.types.date', boolean: 'customField.types.boolean', user: 'customField.types.user',
};
export const CUSTOM_FIELD_TYPE_ICONS: Record<CustomFieldType, string> = {
  text: 'T', textarea: '¶', number: '#', select: '▾', date: 'D', boolean: '☑', user: 'U',
};
