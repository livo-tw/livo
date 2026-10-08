import type { QaDisplaySettings } from '@/lib/qa/displaySettings';
import { useState } from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { QaClient } from '@/lib/qa/client';
import type { QaActor } from '@/lib/qa/domain';
import type { QaCustomFieldValues, QaFieldConfiguration, QaFieldDefinition } from '@/lib/qa/fields';
import { QaCustomFieldDisplay, QaCustomFieldInputs } from '@/components/qa/QaCustomFieldInputs';
import QaCustomFieldManager from '@/components/qa/QaCustomFieldManager';
import QaSettingsPage from '@/components/qa/QaSettingsPage';
import { DEFAULT_QA_WORKFLOW } from '@/lib/qa/workflow';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string, values?: { value?: string }) => key === 'qa.customFields.historicalChoice' ? `${values?.value} (historical)` : key }) }));
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn(), info: vi.fn() }));
vi.mock('sonner', () => ({ toast }));
const confirm = vi.hoisted(() => vi.fn());
vi.mock('@/components/ConfirmDialog', () => ({ useConfirmDialog: () => ({ confirm, ConfirmDialog: null as null }) }));

afterEach(cleanup);
beforeEach(() => { vi.clearAllMocks(); confirm.mockResolvedValue(false); });
const field = (overrides: Partial<QaFieldDefinition> = {}): QaFieldDefinition => ({
  id: 'example_field', fieldName: 'Example field', fieldType: 'text', isEnabled: true, isRequired: false, sortOrder: 0, ...overrides,
});
const admin: QaActor = { id: 'example-admin', role: 'admin' };
const qaAdmin: QaActor = { id: 'example-qa-admin', role: 'member', qaAdmin: true };

describe('Controlled QA custom fields use shared choices and preserve historical data', () => {
  it('treats a required Yes/No answer as a choice, including No', () => {
    const fields = [field({ fieldType: 'boolean', isRequired: true, fieldName: 'Is reproducible' })];
    const changes = vi.fn();
    const Form = () => { const [values, setValues] = useState<QaCustomFieldValues>({}); return <form aria-label="Bug form"><QaCustomFieldInputs fields={fields} values={values} onChange={next => { setValues(next); changes(next); }} /></form>; };
    render(<Form />);
    const form = screen.getByRole('form', { name: 'Bug form' }) as HTMLFormElement;
    expect(form.checkValidity()).toBe(false);
    fireEvent.change(screen.getByRole('combobox', { name: 'Is reproducible' }), { target: { value: 'false' } });
    expect(changes).toHaveBeenLastCalledWith({ example_field: false }); expect(form.checkValidity()).toBe(true);
    expect(screen.queryByRole('checkbox')).toBeNull();
  });
  it('preserves disabled and unknown historical values while editing an enabled field', () => {
    const fields = [field(), field({ id: 'example_disabled', fieldName: 'Old field', fieldType: 'number', isEnabled: false, sortOrder: 1 })];
    const values = { example_field: 'Old text', example_disabled: 0, example_legacy: false };
    const change = vi.fn(); render(<QaCustomFieldInputs fields={fields} values={values} onChange={change} />);
    fireEvent.change(screen.getByLabelText('Example field'), { target: { value: 'New text' } });
    expect(change).toHaveBeenCalledWith({ ...values, example_field: 'New text' });
    expect(screen.getByText('0')).toBeTruthy(); expect(screen.queryByLabelText('Old field')).toBeNull();
  });
  it('keeps a removed select option visible until the user chooses a current option', () => {
    const change = vi.fn(); render(<QaCustomFieldInputs fields={[field({ fieldType: 'select', options: ['Current A', 'Current B'] })]} values={{ example_field: 'Historical choice' }} onChange={change} />);
    const select = screen.getByRole('combobox', { name: 'Example field' }) as HTMLSelectElement;
    expect(select.value).toBe('Historical choice'); expect(screen.getByRole('option', { name: 'Historical choice (historical)' })).toBeTruthy();
    fireEvent.change(select, { target: { value: 'Current A' } }); expect(change).toHaveBeenCalledWith({ example_field: 'Current A' });
  });
  it('emits zero as a number and clearing as null, without emitting NaN', () => {
    const change = vi.fn(); render(<QaCustomFieldInputs fields={[field({ fieldType: 'number' })]} values={{}} onChange={change} />);
    fireEvent.change(screen.getByLabelText('Example field'), { target: { value: '0' } }); expect(change).toHaveBeenLastCalledWith({ example_field: 0 });
    fireEvent.change(screen.getByLabelText('Example field'), { target: { value: '' } });
    expect(change.mock.calls.every(([values]) => values.example_field === null || Number.isFinite(values.example_field))).toBe(true);
  });
  it('displays false and disabled historic data explicitly rather than treating them as empty', () => {
    render(<QaCustomFieldDisplay fields={[field({ fieldType: 'boolean', isEnabled: false })]} values={{ example_field: false }} />);
    expect(screen.getByText('qa.customFields.no')).toBeTruthy(); expect(screen.getByText('· qa.customFields.disabled')).toBeTruthy();
  });
});

describe('QA field configuration has a scoped, compact settings flow', () => {
  const getFieldConfiguration = vi.fn(), saveFieldConfiguration = vi.fn(), saveWorkflow = vi.fn();
  const client = { getDisplaySettings: async (): Promise<QaDisplaySettings> => ({ version: 1, showSeverity: true, hiddenPriorityChoices: [], hiddenBoardStates: [] }), getFieldConfiguration, saveFieldConfiguration, saveWorkflow } as unknown as QaClient;
  let configuration: QaFieldConfiguration;
  beforeEach(() => {
    configuration = { version: 1, fields: [] };
    getFieldConfiguration.mockImplementation(async () => configuration);
    saveFieldConfiguration.mockImplementation(async (next: QaFieldConfiguration) => { configuration = next; return next; });
    saveWorkflow.mockImplementation(async next => next);
  });
  it('does not fetch configuration for an ordinary member, while a QA administrator can create a field', async () => {
    const view = render(<QaCustomFieldManager client={client} actor={{ id: 'example-member', role: 'member' }} />);
    expect(getFieldConfiguration).not.toHaveBeenCalled(); expect(screen.getByText('qa.customFields.forbidden')).toBeTruthy();
    view.rerender(<QaCustomFieldManager client={client} actor={qaAdmin} />);
    await waitFor(() => expect(screen.getByRole('button', { name: 'customField.manager.addField' })).not.toBeDisabled());
    fireEvent.click(screen.getByRole('button', { name: 'customField.manager.addField' }));
    fireEvent.change(screen.getByLabelText(/customField.manager.fieldNameLabel/), { target: { value: 'Device type' } });
    fireEvent.click(screen.getByRole('button', { name: 'qa.save' }));
    await waitFor(() => expect(saveFieldConfiguration).toHaveBeenCalledWith({ version: 1, fields: [expect.objectContaining({ id: expect.stringMatching(/^qaf_/), fieldName: 'Device type', fieldType: 'text', isRequired: false, isEnabled: true })] }));
    expect(await screen.findByText('Device type')).toBeTruthy(); expect(toast.success).toHaveBeenCalledWith('qa.customFields.saved');
  });
  it('disables an existing field without deleting its definition and fixes its type while editing', async () => {
    configuration = { version: 1, fields: [field({ fieldType: 'number', fieldName: 'Frequency' })] };
    const view = render(<QaCustomFieldManager client={client} actor={admin} />); await screen.findByText('Frequency');
    fireEvent.click(screen.getByRole('checkbox', { name: 'qa.customFields.enabled' }));
    await waitFor(() => expect(saveFieldConfiguration).toHaveBeenCalledWith({ version: 1, fields: [{ ...field({ fieldType: 'number', fieldName: 'Frequency' }), isEnabled: false }] }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'qa.customFields.editField' })).not.toBeDisabled());
    fireEvent.click(screen.getByRole('button', { name: 'qa.customFields.editField' }));
    expect(view.container.querySelector('select')?.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText(/customField.manager.fieldNameLabel/), { target: { value: 'Occurrences' } });
    fireEvent.click(screen.getByRole('button', { name: 'qa.save' }));
    await waitFor(() => expect(saveFieldConfiguration).toHaveBeenLastCalledWith({ version: 1, fields: [{ ...field({ fieldType: 'number', fieldName: 'Occurrences' }), isEnabled: false }] }));
  });
  it('retains a failed new-field draft and its identity for retry', async () => {
    saveFieldConfiguration.mockRejectedValueOnce({ status: 503, code: 'qa_unavailable' });
    render(<QaCustomFieldManager client={client} actor={admin} />); await waitFor(() => expect(screen.getByRole('button', { name: 'customField.manager.addField' })).not.toBeDisabled());
    fireEvent.click(screen.getByRole('button', { name: 'customField.manager.addField' }));
    fireEvent.change(screen.getByLabelText(/customField.manager.fieldNameLabel/), { target: { value: 'Device type' } });
    fireEvent.click(screen.getByRole('button', { name: 'qa.save' })); await screen.findByRole('alert');
    const attempted = saveFieldConfiguration.mock.calls[0][0]; expect((screen.getByLabelText(/customField.manager.fieldNameLabel/) as HTMLInputElement).value).toBe('Device type');
    fireEvent.click(screen.getByRole('button', { name: 'qa.save' }));
    await waitFor(() => expect(saveFieldConfiguration).toHaveBeenCalledTimes(2)); expect(saveFieldConfiguration.mock.calls[1][0]).toEqual(attempted);
  });
  it('reorders fields in one configuration write', async () => {
    configuration = { version: 1, fields: [field({ id: 'example_one', fieldName: 'One' }), field({ id: 'example_two', fieldName: 'Two', sortOrder: 1 })] };
    render(<QaCustomFieldManager client={client} actor={admin} />); await screen.findByText('Two');
    fireEvent.click(screen.getAllByRole('button', { name: 'qa.workflowMoveDown' })[0]);
    await waitFor(() => expect(saveFieldConfiguration).toHaveBeenCalledWith({ version: 1, fields: [expect.objectContaining({ id: 'example_two', sortOrder: 0 }), expect.objectContaining({ id: 'example_one', sortOrder: 1 })] }));
  });
  it('retains edits across settings tabs and blocks closing during a save', async () => {
    let finish!: (next: QaFieldConfiguration) => void;
    const close = vi.fn(); render(<QaSettingsPage client={client} actor={qaAdmin} workflow={DEFAULT_QA_WORKFLOW} onWorkflowSaved={vi.fn()} onClose={close} />);
    fireEvent.click(screen.getByRole('tab', { name: 'qa.customFields.title' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'customField.manager.addField' })).not.toBeDisabled());
    fireEvent.click(screen.getByRole('button', { name: 'customField.manager.addField' }));
    fireEvent.change(screen.getByLabelText(/customField.manager.fieldNameLabel/), { target: { value: 'Device type' } });
    fireEvent.click(screen.getByRole('tab', { name: 'qa.workflowTitle' })); fireEvent.click(screen.getByRole('tab', { name: 'qa.customFields.title' }));
    expect((screen.getByLabelText(/customField.manager.fieldNameLabel/) as HTMLInputElement).value).toBe('Device type');
    fireEvent.click(screen.getByRole('button', { name: 'qa.back' })); await waitFor(() => expect(confirm).toHaveBeenCalled()); expect(close).not.toHaveBeenCalled();
    saveFieldConfiguration.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; })); fireEvent.click(screen.getByRole('button', { name: 'qa.save' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'qa.back' })).toBeDisabled());
    await act(async () => finish({ version: 1, fields: [] }));
  });
});
