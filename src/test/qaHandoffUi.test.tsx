import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import QaHandoffPanel, { handoffReplyTime } from '@/components/qa/QaHandoffPanel';
import QaCoordinatorSettings from '@/components/qa/QaCoordinatorSettings';
import type { QaClient } from '@/lib/qa/client';
import type { QaIssue } from '@/lib/qa/domain';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('@/context/MemberContext', () => ({ useMemberContext: () => ({ users: [{ id: 'next', name: 'Next', isActive: true }, { id: 'other', name: 'Other', isActive: true }] }) }));
vi.mock('@/components/UserSelect', () => ({ default: ({ name, label, value, onChange, required, disabled }: { name: string; label: string; value: string; onChange: (value: string) => void; required?: boolean; disabled?: boolean }) => <label>{label}<select name={name} aria-label={label} value={value} required={required} disabled={disabled} onChange={event => onChange(event.target.value)}><option value="">Empty</option><option value="next">Next</option><option value="other">Other</option></select></label> }));
afterEach(() => { cleanup(); vi.unstubAllEnvs(); vi.clearAllMocks(); });
const base = (): QaIssue => ({ id: 'issue', workspaceId: 'default', projectId: 'project', title: 'Example', steps: '', expected: '', actual: 'Example', observedEnvironment: 'QA', observedVersion: '', component: '', reporterId: 'reporter', assigneeId: 'rd', qaOwnerId: 'qa', severity: 'high', priority: 2, dueDate: null, state: 'triaged', resolution: null, resolutionReason: '', duplicateOfId: null, fixCycle: 1, version: 4, fixSummary: '', holdReason: '', targets: [], runs: [], taskIds: [], createdAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-01T00:00:00.000Z', closedAt: null, reopenedAt: null });
const handed = (): QaIssue => ({ ...base(), handoff: { id: 'handoff-1', reason: 'Waiting for an answer', nextOwnerId: 'next', replyBy: null, externalDependency: 'External team', requestedBy: 'qa', requestedAt: '2026-10-01T00:00:00.000Z', acceptedBy: null, acceptedAt: null, resolvedBy: null, resolvedAt: null, resolutionEvidence: '' } });
function fillRequest() {
  fireEvent.click(screen.getByRole('button', { name: 'qaHandoff.request' }));
  fireEvent.change(screen.getByLabelText('qaHandoff.nextOwner'), { target: { value: 'next' } });
  fireEvent.change(screen.getByLabelText(/qaHandoff.reason/), { target: { value: 'Need a response' } });
}
describe('QA handoff UI boundaries', () => {
  it('converts an explicit local time and rejects nonexistent calendar dates', () => {
    vi.stubEnv('TZ', 'Asia/Taipei');
    expect(handoffReplyTime('2026-10-03T09:30')).toBe('2026-10-03T01:30:00.000Z');
    expect(handoffReplyTime('')).toBeNull();
    expect(() => handoffReplyTime('2026-02-30T09:30')).toThrow();
    expect(() => handoffReplyTime('2026-10-03')).toThrow();
  });
  it('accepts the exact displayed handoff without changing assignments or QA state', async () => {
    const onCommand = vi.fn(async () => true);
    render(<QaHandoffPanel issue={handed()} actor={{ id: 'next', role: 'member' }} busy={false} onCommand={onCommand} />);
    fireEvent.click(screen.getByRole('button', { name: 'qaHandoff.accept' }));
    await waitFor(() => expect(onCommand).toHaveBeenCalledExactlyOnceWith({ type: 'accept_handoff', handoffId: 'handoff-1' }, 4));
    expect(screen.queryByRole('button', { name: 'qaHandoff.request' })).not.toBeInTheDocument();
  });
  it('keeps a request draft and prevents overwriting a newer issue version', async () => {
    const onCommand = vi.fn(async () => true), actor = { id: 'admin', role: 'admin' };
    const { rerender } = render(<QaHandoffPanel issue={base()} actor={actor} busy={false} onCommand={onCommand} />);
    fillRequest();
    rerender(<QaHandoffPanel issue={{ ...base(), version: 5 }} actor={actor} busy={false} onCommand={onCommand} />);
    fireEvent.click(screen.getByRole('button', { name: 'qaHandoff.confirmRequest' }));
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('qaHandoff.draftConflict'));
    expect(onCommand).not.toHaveBeenCalled();
    expect(screen.getByLabelText(/qaHandoff.reason/)).toHaveValue('Need a response');
  });
  it('preserves a failed request and suppresses double submission while it is pending', async () => {
    let resolve!: (value: boolean) => void;
    const onCommand = vi.fn(() => new Promise<boolean>(done => { resolve = done; }));
    render(<QaHandoffPanel issue={base()} actor={{ id: 'admin', role: 'admin' }} busy={false} onCommand={onCommand} />);
    fillRequest();
    const confirm = screen.getByRole('button', { name: 'qaHandoff.confirmRequest' });
    fireEvent.click(confirm); fireEvent.click(confirm);
    expect(onCommand).toHaveBeenCalledTimes(1);
    resolve(false);
    await waitFor(() => expect(screen.getByLabelText(/qaHandoff.reason/)).toHaveValue('Need a response'));
    expect(onCommand.mock.calls[0]).toEqual([{ type: 'request_handoff', reason: 'Need a response', nextOwnerId: 'next', replyBy: null, externalDependency: '' }, 4]);
  });
});
describe('QA coordinator settings UI', () => {
  it('does not save during selection and reuses the command ID after an uncertain response', async () => {
    const saveCoordination = vi.fn().mockRejectedValueOnce(new Error('transport')).mockResolvedValueOnce({ projectId: 'project', coordinatorId: 'next', version: 2 });
    const client = { getCoordination: vi.fn(async () => ({ projectId: 'project', coordinatorId: null, version: 1 })), saveCoordination } as unknown as QaClient;
    render(<QaCoordinatorSettings client={client} projectId="project" onSaved={vi.fn()} onClose={vi.fn()} />);
    const select = await screen.findByLabelText('qaHandoff.coordinatorTitle');
    fireEvent.change(select, { target: { value: 'next' } });
    expect(saveCoordination).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'qa.save' }));
    await screen.findByRole('alert');
    fireEvent.click(screen.getByRole('button', { name: 'qa.save' }));
    await waitFor(() => expect(saveCoordination).toHaveBeenCalledTimes(2));
    expect(saveCoordination.mock.calls[0]).toEqual(saveCoordination.mock.calls[1]);
    expect(saveCoordination.mock.calls[0].slice(0, 3)).toEqual(['project', 'next', 1]);
  });
  it('ignores a late load from the previous project', async () => {
    let resolve!: (value: { projectId: string; coordinatorId: string; version: number }) => void;
    const getCoordination = vi.fn((id: string) => id === 'old' ? new Promise(done => { resolve = done; }) : Promise.resolve({ projectId: id, coordinatorId: 'next', version: 1 }));
    const client = { getCoordination, saveCoordination: vi.fn() } as unknown as QaClient;
    const { rerender } = render(<QaCoordinatorSettings client={client} projectId="old" onSaved={vi.fn()} onClose={vi.fn()} />);
    rerender(<QaCoordinatorSettings client={client} projectId="new" onSaved={vi.fn()} onClose={vi.fn()} />);
    await waitFor(() => expect(screen.getByLabelText('qaHandoff.coordinatorTitle')).toHaveValue('next'));
    resolve({ projectId: 'old', coordinatorId: 'other', version: 99 });
    await waitFor(() => expect(screen.getByLabelText('qaHandoff.coordinatorTitle')).toHaveValue('next'));
  });
  it('does not publish a late save result after the settings panel is unmounted', async () => {
    let resolve!: (value: { projectId: string; coordinatorId: string; version: number }) => void;
    const onSaved = vi.fn(), client = { getCoordination: vi.fn(async () => ({ projectId: 'project', coordinatorId: null, version: 0 })), saveCoordination: vi.fn(() => new Promise(done => { resolve = done; })) } as unknown as QaClient;
    const { unmount } = render(<QaCoordinatorSettings client={client} projectId="project" onSaved={onSaved} onClose={vi.fn()} />);
    fireEvent.change(await screen.findByLabelText('qaHandoff.coordinatorTitle'), { target: { value: 'next' } });
    fireEvent.click(screen.getByRole('button', { name: 'qa.save' }));
    unmount(); resolve({ projectId: 'project', coordinatorId: 'next', version: 1 });
    await Promise.resolve(); await Promise.resolve();
    expect(onSaved).not.toHaveBeenCalled();
  });
});
