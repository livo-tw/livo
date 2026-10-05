import { describe, expect, it } from 'vitest';
import type { CustomField } from '@/types';
import { customFieldDefault, customFieldFilled, customFieldHasValue } from '@/lib/customFieldValues';

const field = (fieldType: CustomField['fieldType'], defaultValue?: string, options?: string[]) => ({ id: 'f', projectId: 'p', fieldName: 'F', fieldType, defaultValue, options, isRequired: true, sortOrder: 0, createdAt: '' }) as CustomField;

describe('custom field values', () => {
  it('reads a default in the shape of the field type and ignores one that does not fit', () => {
    expect(customFieldDefault(field('text', ' Hello '))).toEqual({ valueText: 'Hello' });
    expect(customFieldDefault(field('number', '2.5'))).toEqual({ valueNumber: 2.5 });
    expect(customFieldDefault(field('number', 'many'))).toEqual({});
    expect(customFieldDefault(field('date', '2026-10-04'))).toEqual({ valueDate: '2026-10-04' });
    expect(customFieldDefault(field('date', 'tomorrow'))).toEqual({});
    expect(customFieldDefault(field('select', 'B', ['A', 'B']))).toEqual({ valueText: 'B' });
    expect(customFieldDefault(field('select', 'C', ['A', 'B']))).toEqual({});
    expect(customFieldDefault(field('boolean', 'true'))).toEqual({ valueBoolean: true });
    expect(customFieldDefault(field('text'))).toEqual({});
  });

  it('knows when a required field is filled in', () => {
    expect(customFieldFilled(field('text'), { valueText: '  ' })).toBe(false);
    expect(customFieldFilled(field('number'), { valueNumber: 0 })).toBe(true);
    expect(customFieldFilled(field('user'), {})).toBe(false);
    expect(customFieldFilled(field('boolean'), undefined)).toBe(true);
    expect(customFieldHasValue({ valueBoolean: false })).toBe(true);
    expect(customFieldHasValue({})).toBe(false);
  });
});
