import { isCustomFieldEmpty, isCustomFieldScalarValid, type CustomFieldScalar, type CustomFieldType } from './customFieldTypes.ts';

export type QaFieldType = Exclude<CustomFieldType, 'user'>;
export interface QaFieldDefinition {
  id: string; fieldName: string; fieldType: QaFieldType; options?: string[];
  isRequired: boolean; isEnabled: boolean; sortOrder: number;
}
export interface QaFieldConfiguration { version: 1; fields: QaFieldDefinition[]; }
export type QaCustomFieldValues = Record<string, CustomFieldScalar>;
export const DEFAULT_QA_FIELD_CONFIGURATION: QaFieldConfiguration = { version: 1, fields: [] };
export const canManageQaConfiguration = (actor: { role: string; qaAdmin?: boolean }): boolean => ['admin', 'super_admin'].includes(actor.role) || actor.qaAdmin === true;
export class QaFieldError extends Error {
  constructor(public readonly code: string) { super(code); this.name = 'QaFieldError'; }
}
const invalid = (code = 'qa_invalid_field_configuration'): never => { throw new QaFieldError(code); };
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const known = (value: Record<string, unknown>, keys: string[]) => Object.keys(value).every(key => keys.includes(key));
const label = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0 && value.length <= 120 && !value.includes('\u0000');

export function validateQaFieldConfiguration(value: unknown, previous?: QaFieldConfiguration): QaFieldConfiguration {
  if (!object(value) || !known(value, ['version', 'fields']) || value.version !== 1 || !Array.isArray(value.fields) || value.fields.length > 50) return invalid();
  const ids = new Set<string>();
  const fields = value.fields.map((raw): QaFieldDefinition => {
    if (!object(raw) || !known(raw, ['id', 'fieldName', 'fieldType', 'options', 'isRequired', 'isEnabled', 'sortOrder'])
      || typeof raw.id !== 'string' || !/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(raw.id) || ids.has(raw.id)
      || !label(raw.fieldName) || !['text', 'textarea', 'number', 'select', 'date', 'boolean'].includes(String(raw.fieldType))
      || typeof raw.isRequired !== 'boolean' || typeof raw.isEnabled !== 'boolean' || !Number.isSafeInteger(raw.sortOrder)
      || Number(raw.sortOrder) < 0 || Number(raw.sortOrder) > 100000) return invalid();
    ids.add(raw.id);
    const options = raw.options ?? [];
    if (!Array.isArray(options) || options.length > 100 || options.some(option => !label(option)) || new Set(options).size !== options.length
      || (raw.fieldType === 'select' ? options.length === 0 : options.length !== 0)) return invalid();
    return { id: raw.id, fieldName: raw.fieldName, fieldType: raw.fieldType as QaFieldType,
      ...(raw.options !== undefined ? { options: [...options] as string[] } : {}),
      isRequired: raw.isRequired, isEnabled: raw.isEnabled, sortOrder: raw.sortOrder as number };
  });
  if (previous?.fields.some(old => !fields.some(field => field.id === old.id && field.fieldType === old.fieldType))) return invalid('qa_field_identity_immutable');
  return { version: 1, fields };
}

/** Missing settings are empty; malformed configured settings fail closed. */
export function parseQaFieldConfiguration(value: unknown): QaFieldConfiguration {
  if (value == null) return { version: 1, fields: [] };
  if (typeof value === 'string') {
    try { value = JSON.parse(value); } catch { return invalid(); }
  }
  return validateQaFieldConfiguration(value);
}

export function validateQaCustomFieldValues(value: unknown, configuration: QaFieldConfiguration, previous: QaCustomFieldValues = {}): QaCustomFieldValues {
  const submitted = value === undefined ? previous : value;
  if (!object(submitted) || Object.keys(submitted).length > 100 || new TextEncoder().encode(JSON.stringify(submitted)).byteLength > 100000) return invalid('qa_invalid_custom_fields');
  const result: QaCustomFieldValues = { ...previous };
  const fields = new Map(configuration.fields.map(field => [field.id, field]));
  for (const [id, raw] of Object.entries(submitted)) {
    const field = fields.get(id), unchanged = Object.prototype.hasOwnProperty.call(previous, id) && previous[id] === raw;
    if (!field || !field.isEnabled) {
      if (!unchanged) return invalid('qa_custom_field_unavailable');
    } else if (!unchanged && !isCustomFieldScalarValid(field.fieldType, raw, field.options)) return invalid('qa_invalid_custom_field_value');
    if (!['string', 'number', 'boolean'].includes(typeof raw) && raw !== null) return invalid('qa_invalid_custom_field_value');
    result[id] = raw as CustomFieldScalar;
  }
  for (const field of configuration.fields) if (field.isEnabled && field.isRequired && isCustomFieldEmpty(result[field.id])) return invalid('qa_custom_field_required');
  return result;
}
