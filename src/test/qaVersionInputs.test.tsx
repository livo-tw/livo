import type { QaDisplaySettings } from '@/lib/qa/displaySettings';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('@/context/MemberContext', () => ({ useMemberContext: () => ({ users: [] as never[] }) }));
import QaReportForm from '@/components/qa/QaReportForm';
import { createQaIssue } from '@/lib/qa/domain';
import type { Project } from '@/types';

const projects: Project[] = ['a', 'b'].map(id => ({ id, lineId: 'line', key: id, name: `Project ${id}`, color: '#000', isArchived: false }));
const issue = createQaIssue({ projectId: 'a', title: 'Bug', actual: 'Broken', observedEnvironment: 'Stage', observedVersion: 'old-custom' }, 'bug-a', {
  actor: { id: 'admin', role: 'admin' }, workspaceId: 'default', now: '2026-10-03T00:00:00.000Z', newId: () => 'id', memberIds: new Set(['admin']), projectIds: new Set(['a']), taskIds: new Set<string>(),
});
afterEach(cleanup);
const deferred = () => { let resolve!: (values: string[]) => void; const promise = new Promise<string[]>(done => { resolve = done; }); return { promise, resolve }; };

describe('QA free-text version suggestions', () => {
  it('preserves an existing custom version when suggestions arrive and allows blank or arbitrary edits', async () => {
    const result = deferred(), client = { getDisplaySettings: async (): Promise<QaDisplaySettings> => ({ version: 1, showSeverity: true, hiddenPriorityChoices: [], hiddenBoardStates: [] }), getFieldConfiguration: vi.fn().mockResolvedValue({ version: 1, fields: [] }), versions: vi.fn(() => result.promise) }, save = vi.fn();
    render(<QaReportForm initial={issue} projects={projects} productLines={[]} client={client} busy={false} onSubmit={save} onCancel={vi.fn()} />);
    const input = screen.getByLabelText(/qa.observedVersion/) as HTMLInputElement;
    expect(input.value).toBe('old-custom');
    await act(async () => result.resolve(['v1', 'v2']));
    expect(input.value).toBe('old-custom');
    expect(screen.queryByLabelText('qa.versionChoose')).toBeNull();
    expect(document.getElementById(input.getAttribute('list')!)?.querySelector('option[value="v2"]')).toBeTruthy();
    fireEvent.change(input, { target: { value: 'v2' } });
    expect(input.value).toBe('v2');
    fireEvent.change(input, { target: { value: 'commit/a1b2' } });
    await waitFor(() => expect(screen.getByRole('button', { name: 'qa.save' })).not.toBeDisabled()); fireEvent.click(screen.getByRole('button', { name: 'qa.save' }));
    expect(save).toHaveBeenLastCalledWith(expect.objectContaining({ observedVersion: 'commit/a1b2' }));
    fireEvent.change(input, { target: { value: '' } });
    await waitFor(() => expect(screen.getByRole('button', { name: 'qa.save' })).not.toBeDisabled()); fireEvent.click(screen.getByRole('button', { name: 'qa.save' }));
    expect(save).toHaveBeenLastCalledWith(expect.objectContaining({ observedVersion: '' }));
    expect(input.getAttribute('aria-describedby')).toBeTruthy();
  });
  it('clears the old version on a new report project change and ignores a late previous-project response', async () => {
    const a = deferred(), b = deferred();
    const client = { getDisplaySettings: async (): Promise<QaDisplaySettings> => ({ version: 1, showSeverity: true, hiddenPriorityChoices: [], hiddenBoardStates: [] }), getFieldConfiguration: vi.fn().mockResolvedValue({ version: 1, fields: [] }), versions: vi.fn((project: string, _signal?: AbortSignal) => project === 'a' ? a.promise : b.promise) };
    const view = render(<QaReportForm projectId="a" projects={projects} productLines={[]} client={client} busy={false} onSubmit={vi.fn()} onCancel={vi.fn()} />);
    await waitFor(() => expect(client.versions).toHaveBeenCalledTimes(1));
    const input = screen.getByLabelText(/qa.observedVersion/) as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'belongs-to-a' } });
    fireEvent.change(screen.getByLabelText(/qa.project/), { target: { value: 'b' } });
    expect(input.value).toBe('');
    expect(client.versions.mock.calls[0][1]?.aborted).toBe(true);
    await act(async () => b.resolve(['build-b']));
    await act(async () => a.resolve(['build-a']));
    expect(view.container.querySelector('datalist')?.textContent).not.toContain('build-a');
    expect(document.getElementById(input.getAttribute('list')!)?.querySelector('option[value="build-b"]')).toBeTruthy();
    expect(document.getElementById(input.getAttribute('list')!)?.querySelector('option[value="build-a"]')).toBeNull();
  });
  it('keeps manual input available after a failed suggestion request', async () => {
    const client = { getDisplaySettings: async (): Promise<QaDisplaySettings> => ({ version: 1, showSeverity: true, hiddenPriorityChoices: [], hiddenBoardStates: [] }), getFieldConfiguration: vi.fn().mockResolvedValue({ version: 1, fields: [] }), versions: vi.fn(async () => { throw new Error('offline'); }) }, save = vi.fn();
    render(<QaReportForm initial={issue} projects={projects} productLines={[]} client={client} busy={false} onSubmit={save} onCancel={vi.fn()} />);
    await screen.findByText('qa.versionLoadFailed');
    fireEvent.change(screen.getByLabelText(/qa.observedVersion/), { target: { value: 'manual-build' } });
    await waitFor(() => expect(screen.getByRole('button', { name: 'qa.save' })).not.toBeDisabled()); fireEvent.click(screen.getByRole('button', { name: 'qa.save' }));
    expect(save).toHaveBeenCalledWith(expect.objectContaining({ observedVersion: 'manual-build' }));
  });
});
