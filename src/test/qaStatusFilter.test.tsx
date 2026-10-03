import { useState } from 'react';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { ColoredStatusSelect } from '@/components/ui/colored-status-select';
import { qaStateColors } from '@/components/qa/QaBadges';
import { QA_STATES, type QaListInput } from '@/lib/qa/domain';
import { DEFAULT_QA_WORKFLOW, type QaWorkflow } from '@/lib/qa/workflow';
import type { ProductLine, Project } from '@/types';

const mocks = vi.hoisted(() => ({ getWorkflow: vi.fn() }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('@/context/UIContext', () => ({ useUIContext: () => ({ featureToggles: { qa: true }, featureTogglesReady: true }) }));
vi.mock('@/context/ProjectContext', () => ({ useProjectContext: () => ({ allProjects: [] as Project[], productLines: [] as ProductLine[], selectedProjectId: null as string | null, setSelectedProjectId: vi.fn() }) }));
vi.mock('@/integrations/supabase/client', () => ({ USING_MOCK_BACKEND: true, supabase: {} }));
vi.mock('@/hooks/useQa', () => {
  const client = { getWorkflow: mocks.getWorkflow };
  return { useQa: () => ({ client, actor: { id: 'example-admin', role: 'admin' } }) };
});
vi.mock('@/components/qa/QaKanban', () => ({ default: ({ filters }: { filters: QaListInput }) => <output aria-label="Filtered canonical state">{filters.state || 'all'}</output> }));
vi.mock('@/components/qa/QaIssueDetail', () => ({ default: (): null => null, QaFailure: (): null => null }));
vi.mock('@/components/qa/QaCreatePanel', () => ({ default: (): null => null }));
vi.mock('@/components/qa/QaWorkflowSettings', () => ({ default: (): null => null }));
import QaWorkspace from '@/components/qa/QaWorkspace';

const originalScrollIntoView = Object.getOwnPropertyDescriptor(Element.prototype, 'scrollIntoView');
beforeAll(() => Object.defineProperty(Element.prototype, 'scrollIntoView', { configurable: true, value: vi.fn() }));
afterAll(() => {
  if (originalScrollIntoView) Object.defineProperty(Element.prototype, 'scrollIntoView', originalScrollIntoView);
  else Reflect.deleteProperty(Element.prototype, 'scrollIntoView');
});
afterEach(() => { cleanup(); vi.clearAllMocks(); window.history.replaceState({}, '', '/'); });

async function open(label: string) {
  const trigger = screen.getByRole('combobox', { name: label });
  fireEvent.keyDown(trigger, { key: 'ArrowDown' });
  return screen.findByRole('listbox', { name: label });
}

describe('shared coloured status select', () => {
  it('supports arbitrary task status IDs, keyboard selection, disabled options and a collision-free empty value', async () => {
    const change = vi.fn();
    function TaskStatusFilter() {
      const [value, setValue] = useState('');
      return <ColoredStatusSelect label="Task status" value={value} onValueChange={next => { setValue(next); change(next); }} options={[
        { value: '', label: 'All task states' },
        { value: 'not-selectable', label: 'Unavailable', color: '#999999', disabled: true },
        { value: 'option:', label: 'Ready for review', color: '#6554C0' },
      ]} />;
    }
    render(<TaskStatusFilter />);
    const trigger = screen.getByRole('combobox', { name: 'Task status' });
    expect(trigger).toHaveTextContent('All task states');
    expect(trigger.querySelector('[data-status-dot]')).toBeNull();
    const listbox = await open('Task status');
    expect(within(listbox).getByRole('option', { name: 'Unavailable' })).toHaveAttribute('aria-disabled', 'true');
    await waitFor(() => expect(within(listbox).getByRole('option', { name: 'All task states' })).toHaveFocus());
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowDown' });
    const ready = within(listbox).getByRole('option', { name: 'Ready for review' });
    await waitFor(() => expect(ready).toHaveFocus());
    fireEvent.keyDown(ready, { key: 'Enter' });
    await waitFor(() => expect(trigger).toHaveFocus());
    expect(change).toHaveBeenLastCalledWith('option:');
    expect(trigger).toHaveTextContent('Ready for review');
    expect(trigger.querySelector('[data-status-dot]')).toHaveStyle({ backgroundColor: '#6554C0' });
    const reopened = await open('Task status');
    fireEvent.keyDown(reopened, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('listbox')).toBeNull());
    expect(change).toHaveBeenCalledTimes(1);
    expect(trigger).toHaveFocus();
  });

  it('does not open a disabled picker', () => {
    const change = vi.fn();
    render(<ColoredStatusSelect disabled label="Status" value="ready" onValueChange={change} options={[{ value: 'ready', label: 'Ready', color: '#00875A' }]} />);
    expect(screen.getByRole('combobox', { name: 'Status' })).toBeDisabled();
    expect(change).not.toHaveBeenCalled();
  });
});

describe('QA status filtering', () => {
  it('keeps all eight canonical states and custom labels despite grouped columns, with the board colours in options and selection', async () => {
    const workflow: QaWorkflow = {
      ...DEFAULT_QA_WORKFLOW, order: [...QA_STATES].reverse(),
      labels: { ...DEFAULT_QA_WORKFLOW.labels, verified: 'QA accepted', failed: 'QA rejected' },
      groups: [{ id: 'triaged', label: 'Incoming group', states: ['new', 'triaged'] }],
    };
    mocks.getWorkflow.mockResolvedValue(workflow);
    render(<QaWorkspace />);
    await screen.findByLabelText('Filtered canonical state');
    const trigger = screen.getByRole('combobox', { name: 'qa.allStates' });
    const listbox = await open('qa.allStates');
    const options = within(listbox).getAllByRole('option');
    expect(options).toHaveLength(9);
    expect(options.map(option => option.textContent)).toEqual(['qa.allStates', ...workflow.order.map(state => workflow.labels[state] || `qa.state.${state}`)]);
    expect(within(listbox).queryByText('Incoming group')).toBeNull();
    for (const state of QA_STATES) {
      const option = within(listbox).getByRole('option', { name: workflow.labels[state] || `qa.state.${state}` });
      expect(option.querySelector('[data-status-dot]')).toHaveStyle({ backgroundColor: qaStateColors[state] });
    }
    fireEvent.keyDown(within(listbox).getByRole('option', { name: 'QA accepted' }), { key: 'Enter' });
    await waitFor(() => expect(trigger).toHaveTextContent('QA accepted'));
    expect(trigger.querySelector('[data-status-dot]')).toHaveStyle({ backgroundColor: qaStateColors.verified });
    expect(screen.getByLabelText('Filtered canonical state')).toHaveTextContent('verified');
    const reopened = await open('qa.allStates');
    fireEvent.keyDown(within(reopened).getByRole('option', { name: 'qa.allStates' }), { key: 'Enter' });
    await waitFor(() => expect(trigger).toHaveTextContent('qa.allStates'));
    expect(trigger.querySelector('[data-status-dot]')).toBeNull();
    expect(screen.getByLabelText('Filtered canonical state')).toHaveTextContent('all');
  });
});
