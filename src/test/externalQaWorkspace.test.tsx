// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import ExternalQaShell from '@/components/qa/ExternalQaShell';
import { parseWorkspaceProfile } from '@/lib/qa/externalProfile';
import { DEFAULT_QA_WORKFLOW } from '@/lib/qa/workflow';
import { defaultQaDisplaySettings } from '@/lib/qa/displaySettings';

const generic = vi.hoisted(() => ({ from: vi.fn(), channel: vi.fn() }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('@/i18n', () => ({ default: { t: (key: string) => key } }));
vi.mock('@/integrations/supabase/client', () => ({
  USING_MOCK_BACKEND: false,
  supabase: {
    auth: { getSession: async () => ({ data: { session: { access_token: 'example-token' } } }), signOut: vi.fn() },
    from: generic.from,
    channel: generic.channel,
  },
}));

afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); });

it('runs the real external QA board and report form using only the scoped QA endpoint', async () => {
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { configurable: true, value: vi.fn() });
  const profile = parseWorkspaceProfile({
    external: true, id: 'eqa-example', name: 'Example tester', qaEnabled: true, environments: ['Stage'],
    projects: [{ id: 'approved', name: 'Granted project', isArchived: false }], members: [{ id: 'eqa-example', name: 'Example tester', avatar: '', color: '', jobTitle: '', isActive: true, isExternal: true }],
  });
  if (!profile.external) throw new Error('Expected scoped QA profile');
  expect(profile.members[0].jobTitle).toBe('');
  const calls: Array<{ action: string; projectId?: string }> = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, options: RequestInit) => {
    expect(url).toContain('/functions/v1/qa');
    const body = JSON.parse(String(options.body));
    calls.push(body);
    if (body.action === 'get_workflow') return Response.json(DEFAULT_QA_WORKFLOW);
    if (body.action === 'get_display_settings') return Response.json(defaultQaDisplaySettings());
    if (body.action === 'get_field_configuration') return Response.json({ version: 1, fields: [] });
    if (body.action === 'my_coordination') return Response.json({ projectIds: [] });
    if (body.action === 'list') return Response.json({ issues: [], total: 0, hasMore: false });
    if (body.action === 'versions') return Response.json([]);
    if (body.action === 'project_people') return Response.json({ members: [{ id: 'eqa-example', name: 'Example tester', isActive: true, isExternal: true }, { id: 'eqa-internal-engineer', name: 'Example engineer', isActive: true, isExternal: false }, { id: 'engineer-disabled', name: 'Disabled engineer', isActive: false, isExternal: false }], hasMore: false });
    throw new Error('Unexpected QA action ' + body.action);
  }));
  const view = render(<ExternalQaShell profile={profile} reload={vi.fn(async () => {})} />);
  await waitFor(() => expect(calls.some(call => call.action === 'list')).toBe(true));
  expect(within(view.container.querySelector('header')!).getByText('QA')).toBeInTheDocument();
  expect(within(view.container.querySelector('header')!).getByText('E')).toHaveStyle({ backgroundColor: '#64748b' });
  expect(profile.members[0].jobTitle).toBe('');
  const ownerFilter = within(view.container).getByRole('button', { name: 'common.all qa.qaOwner' });
  fireEvent.click(ownerFilter);
  const ownFilterRow = within(ownerFilter.parentElement!).getByRole('button', { name: 'Example tester QA' });
  expect(within(ownFilterRow).getByText('E')).toHaveStyle({ backgroundColor: '#64748b' });
  fireEvent.click(ownerFilter);
  const assigneeFilter = within(view.container).getByRole('button', { name: 'common.all qa.assignee' });
  fireEvent.click(assigneeFilter);
  expect(within(assigneeFilter.parentElement!).getByRole('button', { name: 'Example tester QA' })).toBeInTheDocument();
  fireEvent.click(assigneeFilter);
  fireEvent.click(screen.getByRole('button', { name: 'qa.report' }));
  const dialog = await screen.findByRole('dialog');
  expect(within(dialog).getByLabelText(/qa\.titleField/)).toBeInTheDocument();
  expect(within(dialog).getByRole('option', { name: 'Granted project' })).toBeInTheDocument();
  expect(within(dialog).getByRole('option', { name: 'Stage' })).toBeInTheDocument();
  fireEvent.change(within(dialog).getByLabelText(/qa\.project/), { target: { value: 'approved' } });
  await waitFor(() => expect(calls.some(call => call.action === 'project_people' && call.projectId === 'approved')).toBe(true));
  const repair = within(dialog).getByRole('combobox', { name: 'qa.assignee' });
  fireEvent.click(repair);
  const engineer = await screen.findByRole('option', { name: /Example engineer/ });
  expect(screen.queryByRole('option', { name: /Example tester/ })).not.toBeInTheDocument();
  expect(screen.queryByRole('option', { name: /Disabled engineer/ })).not.toBeInTheDocument();
  fireEvent.click(engineer);
  expect(repair).toHaveTextContent('Example engineer');
  expect(generic.from).not.toHaveBeenCalled();
  expect(generic.channel).not.toHaveBeenCalled();
});
