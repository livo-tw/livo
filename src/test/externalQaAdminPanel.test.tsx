// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import ExternalQaAdminPanel from '@/components/member-manage/ExternalQaAdminPanel';

const api = vi.hoisted(() => ({ call: vi.fn() }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('@/lib/callFunction', () => ({ callFunction: api.call }));
vi.mock('@/context/ProjectContext', () => ({ useProjectContext: () => ({ allProjects: [] as never[], productLines: [] as never[] }) }));
vi.mock('@/components/AccountCredentialsDialog', () => ({
  default: () => <p>Credential handoff</p>,
}));
vi.mock('sonner', () => ({ toast: { success: vi.fn() } }));

const account = {
  id: 'eqa-fixture', name: 'Example QA', email: 'qa@example.com', isActive: true, projectIds: [] as string[],
  revision: 1, registrationId: 'registration-fixture', credentialRecoveryAvailable: true,
};
beforeEach(() => api.call.mockReset());
afterEach(cleanup);

async function createForm() {
  api.call.mockResolvedValueOnce({ ok: true, data: { accounts: [] } });
  render(<ExternalQaAdminPanel />);
  const create = await screen.findByRole('button', { name: 'externalQaAdmin.create' });
  await waitFor(() => expect(create).toBeEnabled());
  fireEvent.click(create);
  fireEvent.change(screen.getByLabelText('accountCredentials.name'), { target: { value: account.name } });
  fireEvent.change(screen.getByLabelText('Email'), { target: { value: account.email } });
}

it('sends an optional initial password and clears it after successful creation', async () => {
  await createForm();
  api.call.mockResolvedValueOnce({ ok: true, data: { account, temporaryPassword: 'Example-initial-1' } });
  fireEvent.change(screen.getByLabelText('externalQaAdmin.initialPassword'), { target: { value: 'Example-initial-1' } });
  fireEvent.click(screen.getByRole('button', { name: 'common.save' }));
  await screen.findByText('Credential handoff');
  expect(api.call).toHaveBeenLastCalledWith('external-qa-admin', expect.objectContaining({
    action: 'create', email: account.email, initialPassword: 'Example-initial-1',
    requestId: expect.stringMatching(/^[0-9a-f-]{36}$/),
  }));
  expect(screen.queryByLabelText('externalQaAdmin.initialPassword')).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'common.edit: Example QA' }));
  expect(screen.queryByLabelText('externalQaAdmin.initialPassword')).not.toBeInTheDocument();
  const { registrationId: _registrationId, credentialRecoveryAvailable: _canRecover, ...updated } = account;
  api.call.mockResolvedValueOnce({ ok: true, data: { account: { ...updated, revision: 2 } } });
  fireEvent.click(screen.getByRole('button', { name: 'common.save' }));
  await waitFor(() => expect(api.call).toHaveBeenLastCalledWith('external-qa-admin', {
    action: 'update', id: account.id, revision: 1, name: account.name, isActive: true, projectIds: [],
  }));
  expect(screen.getByRole('button', { name: 'externalQaAdmin.recover: Example QA' })).toBeEnabled();
});

it('omits a blank password and reuses the same registration request after an uncertain response', async () => {
  await createForm();
  api.call.mockRejectedValueOnce(new Error('response lost'));
  fireEvent.click(screen.getByRole('button', { name: 'common.save' }));
  await screen.findByRole('alert');
  const first = api.call.mock.calls[1][1];
  expect(first).not.toHaveProperty('initialPassword');
  api.call.mockResolvedValueOnce({ ok: false, data: { error: 'external_qa_registration_pending' } });
  fireEvent.click(screen.getByRole('button', { name: 'common.save' }));
  await waitFor(() => expect(api.call).toHaveBeenCalledTimes(3));
  expect(api.call.mock.calls[2][1]).toEqual(first);
  await screen.findByRole('button', { name: 'common.retry' });
});

it.each(['short', '😀'.repeat(4), '界'.repeat(25)])('rejects an invalid initial password without submitting', async value => {
  await createForm();
  fireEvent.change(screen.getByLabelText('externalQaAdmin.initialPassword'), { target: { value } });
  fireEvent.click(screen.getByRole('button', { name: 'common.save' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('externalQaAdmin.errors.external_qa_invalid_password');
  expect(api.call).toHaveBeenCalledTimes(1);
});

it('recovers a pending registration using its exact registration and revision', async () => {
  api.call.mockResolvedValueOnce({ ok: true, data: { accounts: [{ ...account, revision: 0, registrationPending: true }] } });
  render(<ExternalQaAdminPanel />);
  fireEvent.click(await screen.findByRole('button', { name: 'externalQaAdmin.recover: Example QA' }));
  expect(screen.getByRole('button', { name: 'common.edit: Example QA' })).toBeDisabled();
  expect(screen.getByLabelText('accountCredentials.name')).toHaveAttribute('readonly');
  api.call.mockResolvedValueOnce({ ok: true, data: { account, temporaryPassword: 'Example-reissued-2' } });
  fireEvent.change(screen.getByLabelText('externalQaAdmin.initialPassword'), { target: { value: 'Example-reissued-2' } });
  fireEvent.click(screen.getByRole('button', { name: 'common.save' }));
  await screen.findByText('Credential handoff');
  expect(api.call).toHaveBeenLastCalledWith('external-qa-admin', {
    action: 'recover', registrationId: account.registrationId, id: account.id, revision: 0,
    initialPassword: 'Example-reissued-2',
  });
});
