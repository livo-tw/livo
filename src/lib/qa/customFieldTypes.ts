/** Shared task/QA field types; no browser or framework dependencies. */
export type CustomFieldType = 'text' | 'textarea' | 'number' | 'select' | 'date' | 'boolean' | 'user';
export type CustomFieldScalar = string | number | boolean | null;
export const isCustomFieldEmpty = (value: unknown): boolean => value == null || (typeof value === 'string' && !value.trim());
export function isCustomFieldScalarValid(type: CustomFieldType, value: unknown, options: readonly string[] = []): boolean {
  if (value === null) return true;
  if (type === 'boolean') return typeof value === 'boolean';
  if (type === 'number') return typeof value === 'number' && Number.isFinite(value);
  if (typeof value !== 'string' || value.includes('\u0000')) return false;
  if (type === 'text') return value.length <= 4000;
  if (type === 'textarea') return value.length <= 20000;
  if (type === 'select') return value === '' || options.includes(value);
  if (type === 'user') return value === '' || /^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/.test(value);
  return value === '' || (/^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value);
}
