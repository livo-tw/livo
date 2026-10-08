import type { QaDisplaySettings } from '@/lib/qa/displaySettings';
import { useState } from 'react';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { ColoredStatusSelect } from '@/components/ui/colored-status-select';
import { qaStateColors } from '@/components/qa/QaBadges';
import { QA_STATES, type QaListInput } from '@/lib/qa/domain';
import { DEFAULT_QA_WORKFLOW, type QaWorkflow } from '@/lib/qa/workflow';
import type { ProductLine, Project } from '@/types';

const mocks = vi.hoisted(() => ({ getDisplaySettings: async (): Promise<QaDisplaySettings> => ({ version: 1, showSeverity: true, hiddenPriorityChoices: [], hiddenBoardStates: [] }), getWorkflow: vi.fn() }));
// Keep initialization exports available when an import graph loads the real i18n singleton.
vi.mock('react-i18next', async (importOriginal) => ({
  ...await importOriginal<typeof import('react-i18next')>(),
  useTranslation: () => ({ t: (key: string) => key }),
}));
import '@/i18n';
vi.mock('@/context/UIContext', () => ({ useUIContext: () => ({ featureToggles: { qa: true }, featureTogglesReady: true, taskDisplayMode: 'modal', setTaskDisplayMode: vi.fn() }) }));
vi.mock('@/context/ProjectContext', () => ({ useProjectContext: () => ({ allProjects: [] as Project[], productLines: [] as ProductLine[], selectedProjectId: null as string | null, selectedLineId: null as string | null, setSelectedProjectId: vi.fn(), setSelectedLineId: vi.fn() }) }));
vi.mock('@/context/MemberContext', () => ({ useMemberContext: () => ({ users: [] as never[] }) }));
vi.mock('@/integrations/supabase/client', () => ({ USING_MOCK_BACKEND: true, supabase: {} }));
vi.mock('@/hooks/useQa', () => {
  const client = { getDisplaySettings: async (): Promise<QaDisplaySettings> => ({ version: 1, showSeverity: true, hiddenPriorityChoices: [], hiddenBoardStates: [] }), getWorkflow: mocks.getWorkflow };
  return { useQa: () => ({ client, actor: { id: 'example-admin', role: 'admin' } }) };
});
vi.mock('@/components/qa/QaKanban', () => ({ default: ({ filters }: { filters: QaListInput }) => <output aria-label="Filtered canonical state">{filters.states?.join(',') || 'all'}</output> }));
vi.mock('@/components/qa/QaIssueDetail', () => ({ default: (): null => null, QaFailure: (): null => null }));
vi.mock('@/components/qa/QaCreatePanel', () => ({ default: (): null => null }));
vi.mock('@/components/qa/QaWorkflowSettings', () => ({ default: (): null => null }));
import QaWorkspace from '@/components/qa/QaWorkspace';

const originalScrollIntoView = Object.getOwnPropertyDescriptor(Element.prototype, 'scrollIntoView');
beforeAll(() => { vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} }); Object.defineProperty(Element.prototype, 'scrollIntoView', { configurable: true, value: vi.fn() }); });
afterAll(() => {
  vi.unstubAllGlobals();
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
  it('offers all eight canonical states with custom labels and board colours, and filters several at once', async () => {
    const workflow: QaWorkflow = {
      ...DEFAULT_QA_WORKFLOW, order: [...QA_STATES].reverse(),
      labels: { ...DEFAULT_QA_WORKFLOW.labels, verified: 'QA accepted', failed: 'QA rejected' },
      groups: [{ id: 'triaged', label: 'Incoming group', states: ['new', 'triaged'] }],
    };
    mocks.getWorkflow.mockResolvedValue(workflow);
    render(<QaWorkspace />);
    await screen.findByLabelText('Filtered canonical state');
    // The shared board filter chip (same control as the task board).
    const chip = screen.getByRole('button', { name: 'common.all filter.status' });
    fireEvent.click(chip);
    // Look inside the open dropdown only: role queries over the whole workspace are slow.
    const menu = within(chip.parentElement!);
    const labels = workflow.order.map(state => workflow.labels[state] || `qa.state.${state}`);
    for (const [index, state] of workflow.order.entries()) {
      const option = menu.getByRole('button', { name: labels[index] });
      expect(option.querySelector('span.rounded-full')).toHaveStyle({ backgroundColor: qaStateColors[state] });
    }
    expect(screen.queryByText('Incoming group')).toBeNull();
    fireEvent.click(menu.getByRole('button', { name: 'QA accepted' }));
    fireEvent.click(menu.getByRole('button', { name: 'QA rejected' }));
    await waitFor(() => expect(screen.getByLabelText('Filtered canonical state')).toHaveTextContent('verified,failed'));
    fireEvent.click(screen.getByRole('button', { name: 'button.clearFilters' }));
    await waitFor(() => expect(screen.getByLabelText('Filtered canonical state')).toHaveTextContent('all'));
  });
});
