// @vitest-environment jsdom
import { Suspense } from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import ExternalQaAccessGate from '@/components/qa/ExternalQaAccessGate';
import { parseWorkspaceProfile, QaProfilePasswordChangeRequired } from '@/lib/qa/externalProfile';
import { QaExternalLinkedTasks, QaExternalTaskPicker } from '@/components/qa/QaExternalTaskReferences';

const api = vi.hoisted(() => ({ profile: vi.fn(), signOut: vi.fn() }));
vi.mock('@/i18n', () => ({ default: { t: (key: string) => key } }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('@/integrations/supabase/client', () => ({ supabase: { auth: { signOut: api.signOut } } }));
vi.mock('@/lib/qa/externalProfile', async importOriginal => ({
  ...await importOriginal<typeof import('@/lib/qa/externalProfile')>(),
  readWorkspaceProfile: api.profile,
}));
vi.mock('@/components/qa/QaWorkspace', async () => {
  const { useProjectContext } = await import('@/context/ProjectContext');
  const { useMemberContext } = await import('@/context/MemberContext');
  const { useDeploymentEnvironments } = await import('@/context/DeploymentEnvironmentContext');
  return { default: ({ mine }: { mine: boolean }) => {
    const projects = useProjectContext();
    const members = useMemberContext();
    const { values } = useDeploymentEnvironments();
    return <p>{mine ? 'Mine' : 'QA'}: {projects.allProjects.map(project => project.name).join(', ')} · {projects.selectedProjectId || 'all'} · {members.users.map(member => member.name).join(', ')} · {values.join(', ')}</p>;
  } };
});
vi.mock('@/components/RequiredPasswordChange', () => ({ default: () => <p>Choose own password</p> }));

const granted = parseWorkspaceProfile({
  external: true, id: 'external-example', name: 'External Example', qaEnabled: true, environments: ['Stage'],
  projects: [{ id: 'approved', name: 'Granted project', isArchived: false }],
  members: [{ id: 'tester-example', name: 'Example tester', isActive: true }],
});
const gate = () => render(<Suspense fallback={<p>Loading shell</p>}>
  <ExternalQaAccessGate internal={<p>Internal application</p>} />
</Suspense>);

beforeEach(() => { api.profile.mockReset(); api.signOut.mockClear(); });

it('shows the own-password form for a stale session and rechecks after its token refreshes', async () => {
  api.profile.mockRejectedValueOnce(new QaProfilePasswordChangeRequired()).mockResolvedValueOnce({ external: false });
  const result = render(<Suspense fallback={<p>Loading shell</p>}>
    <ExternalQaAccessGate accessToken="previous-example" internal={<p>Internal application</p>} />
  </Suspense>);
  expect(await screen.findByText('Choose own password')).toBeInTheDocument();
  expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  result.rerender(<Suspense fallback={<p>Loading shell</p>}>
    <ExternalQaAccessGate accessToken="refreshed-example" internal={<p>Internal application</p>} />
  </Suspense>);
  expect(await screen.findByText('Internal application')).toBeInTheDocument();
  expect(api.profile).toHaveBeenCalledTimes(2);
});

it('resolves the authenticated audience before mounting the internal application', async () => {
  let complete: ((value: { external: false }) => void) | undefined;
  api.profile.mockImplementation(() => new Promise<{ external: false }>(resolve => { complete = resolve; }));
  gate();
  expect(screen.queryByText('Internal application')).not.toBeInTheDocument();
  await act(async () => complete?.({ external: false }));
  expect(await screen.findByText('Internal application')).toBeInTheDocument();
});

it('shows only scoped QA resources and does not mount an internal view for an external deep link', async () => {
  const previous = window.location.href;
  window.history.replaceState({}, '', '?task=internal-task&kb=private-page');
  api.profile.mockResolvedValue(granted);
  try {
    gate();
    expect(await screen.findByText(/QA: Granted project .* External Example, Example tester .* Stage/)).toBeInTheDocument();
    expect(screen.queryByText('Internal application')).not.toBeInTheDocument();
    fireEvent.change(screen.getByRole('combobox', { name: 'qa.project' }), { target: { value: 'approved' } });
    expect(await screen.findByText(/QA: Granted project .* approved/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'qa.myTitle' }));
    expect(await screen.findByText(/Mine: Granted project/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'auth.logout' }));
    expect(api.signOut).toHaveBeenCalledOnce();
  } finally { window.history.replaceState({}, '', previous); }
});

it('fails closed and removes the QA workspace after the last grant is revoked', async () => {
  api.profile.mockRejectedValueOnce(new Error('temporarily unavailable')).mockResolvedValueOnce(granted)
    .mockResolvedValueOnce({ ...granted, projects: [] });
  gate();
  expect(await screen.findByRole('alert')).toHaveTextContent('qa.externalProfileUnavailable');
  expect(screen.queryByText('Internal application')).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'common.retry' }));
  expect(await screen.findByText(/QA: Granted project/)).toBeInTheDocument();
  fireEvent(window, new Event('focus'));
  expect(await screen.findByText('qa.externalNoProjects')).toBeInTheDocument();
  expect(screen.queryByText(/QA: Granted project/)).not.toBeInTheDocument();
  expect(screen.queryByText('Internal application')).not.toBeInTheDocument();
});

it('uses scoped task references without exposing an unknown ID or linking to task details', async () => {
  const taskReferences = vi.fn(async () => ({ tasks: [{ id: 'approved-task', taskKey: 'EX-1', title: 'Allowed reference' }], hasMore: false }));
  const client = { taskReferences };
  const { rerender } = render(<QaExternalLinkedTasks client={client} projectId="approved" ids={['approved-task', 'private-id']} />);
  expect(await screen.findByText('EX-1 · Allowed reference')).toBeInTheDocument();
  expect(screen.getByText('common.unknown')).toBeInTheDocument();
  expect(screen.queryByText('private-id')).not.toBeInTheDocument();
  expect(screen.queryByRole('link')).not.toBeInTheDocument();
  expect(taskReferences).toHaveBeenCalledWith('approved', { taskIds: ['approved-task', 'private-id'] }, expect.any(AbortSignal));

  const change = vi.fn();
  rerender(<QaExternalTaskPicker client={client} projectId="approved" links={[]} onChange={change} />);
  fireEvent.click(await screen.findByRole('checkbox', { name: 'EX-1 · Allowed reference' }));
  expect(change).toHaveBeenCalledWith(['approved-task']);
  expect(taskReferences).toHaveBeenCalledWith('approved', { search: '', offset: 0 }, expect.any(AbortSignal));
});
