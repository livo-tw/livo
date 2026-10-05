import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_REQUIRED_FIELDS } from '@/context/UIContext';

const mocks = vi.hoisted(() => ({ saveBuiltin: vi.fn(), updateField: vi.fn(), upsert: vi.fn(), legacy: [] as string[] }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('@/i18n', () => ({ default: { t: (key: string) => key, language: 'zh-TW' } }));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock('@/context/UIContext', async importOriginal => ({ ...(await importOriginal<object>()), useUIContext: () => ({ requiredFields: DEFAULT_REQUIRED_FIELDS, saveRequiredFields: mocks.saveBuiltin }) }));
vi.mock('@/context/AuthContext', () => ({ useAuthContext: () => ({ permissions: { canManageStatuses: true } }) }));
vi.mock('@/context/TaskContext', () => ({ useTaskContext: () => ({
  customFields: [
    { id: 'f-browser', projectId: 'p1', fieldName: 'Browser', fieldType: 'text', isRequired: false, sortOrder: 1, createdAt: '' },
    { id: 'f-points', projectId: 'p1', fieldName: 'Points', fieldType: 'number', isRequired: true, sortOrder: 2, createdAt: '' },
  ],
  updateCustomField: mocks.updateField,
}) }));
vi.mock('@/integrations/supabase/client', () => ({ supabase: { from: () => {
  const chain = { select: () => chain, eq: () => chain, maybeSingle: async () => ({ data: { value: mocks.legacy } }), upsert: (row: unknown) => { mocks.upsert(row); return Promise.resolve({ error: null }); } };
  return chain;
} } }));
import RequiredFieldsSettings from '@/components/RequiredFieldsSettings';

beforeEach(() => { vi.clearAllMocks(); mocks.legacy = []; mocks.updateField.mockResolvedValue(undefined); });

describe('required custom fields', () => {
  it('saves a change to a custom field alone, on the field itself', async () => {
    render(<RequiredFieldsSettings />);
    expect(screen.queryByRole('button', { name: 'requiredFields.saveButton' })).toBeNull();
    expect(screen.getByRole('checkbox', { name: 'Points' })).toBeChecked();
    fireEvent.click(screen.getByRole('checkbox', { name: 'Browser' }));
    fireEvent.click(screen.getByRole('button', { name: 'requiredFields.saveButton' }));
    await waitFor(() => expect(mocks.updateField).toHaveBeenCalledWith('f-browser', { isRequired: true }));
    expect(mocks.updateField).toHaveBeenCalledTimes(1);
    expect(mocks.saveBuiltin).not.toHaveBeenCalled();
  });

  it('shows choices from the old setting and moves them onto the fields when saved', async () => {
    mocks.legacy = ['f-browser'];
    render(<RequiredFieldsSettings />);
    await waitFor(() => expect(screen.getByRole('checkbox', { name: 'Browser' })).toBeChecked());
    fireEvent.click(screen.getByRole('button', { name: 'requiredFields.saveButton' }));
    await waitFor(() => expect(mocks.updateField).toHaveBeenCalledWith('f-browser', { isRequired: true }));
    await waitFor(() => expect(mocks.upsert).toHaveBeenCalledWith(expect.objectContaining({ key: 'required_custom_fields', value: [] })));
  });
});
