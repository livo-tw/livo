import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string, values?: { name?: string }) => values?.name ? `${key} ${values.name}` : key }) }));
vi.mock('@/integrations/supabase/client', () => ({ USING_MOCK_BACKEND: true, supabase: {} }));
vi.mock('@/context/DeploymentEnvironmentContext', () => ({ useDeploymentEnvironments: () => ({ values: ['Stage'], ready: true, loadError: false }) }));
import QaCreatePanel from '@/components/qa/QaCreatePanel';
import QaAttachments from '@/components/qa/QaAttachments';
import type { QaClient } from '@/lib/qa/client';
import type { ProductLine, Project } from '@/types';

const create = vi.fn(), upload = vi.fn(), versions = vi.fn(), onCreated = vi.fn(), onCancel = vi.fn(), onBusyChange = vi.fn();
const client = { create, upload, versions } as unknown as QaClient;
const project = { id: 'project1', name: 'Example project', isArchived: false } as Project;
const props = { client, projects: [project], productLines: [] as ProductLine[], projectId: project.id, issueId: 'fixed-issue', commandId: 'fixed-command', onCreated, onCancel, onBusyChange };
const proof = (name = 'proof.mp4') => new File(['video'], name, { type: 'video/mp4' });
const fill = () => {
  fireEvent.change(screen.getByLabelText(/qa.titleField/), { target: { value: 'Example issue' } });
  fireEvent.change(screen.getByLabelText(/qa.actual/), { target: { value: 'Unexpected result' } });
  fireEvent.change(screen.getByLabelText(/qa.environment/), { target: { value: 'Stage' } });
};
const selectFiles = (files: File[]) => fireEvent.change(screen.getByLabelText('qa.attach'), { target: { files } });
beforeEach(() => { vi.clearAllMocks(); create.mockResolvedValue({ id: 'fixed-issue' }); upload.mockImplementation(async (_id, file) => ({ id: `attachment-${file.name}` })); versions.mockResolvedValue([]); vi.stubEnv('VITE_API_URL', ''); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

describe('QA create with evidence', () => {
  it('holds selected and dropped files until submit, with validation, preview and removal', async () => {
    const OriginalURL = globalThis.URL, revoke = vi.fn();
    vi.stubGlobal('URL', class extends OriginalURL { static createObjectURL = vi.fn(() => 'blob:local-preview'); static revokeObjectURL = revoke; });
    render(<QaCreatePanel {...props} />);
    await screen.findByText('qa.versionEmpty');
    const good = proof(), invalid = new File(['svg'], 'unsafe.svg', { type: 'image/svg+xml' });
    selectFiles([good, invalid]); expect(create).not.toHaveBeenCalled(); expect(upload).not.toHaveBeenCalled();
    expect(screen.getByRole('alert').textContent).toContain('qa.fileTypeError');
    fireEvent.click(screen.getByLabelText('qa.previewFile proof.mp4')); expect(document.querySelector('video')?.src).toBe('blob:local-preview');
    fireEvent.click(screen.getByLabelText('qa.removeFile proof.mp4')); expect(screen.queryByText('proof.mp4')).toBeNull(); expect(revoke).toHaveBeenCalledWith('blob:local-preview');
    fireEvent.drop(screen.getByRole('button', { name: /qa.dropFiles/ }), { dataTransfer: { files: [proof('dropped.mp4')] } });
    expect(screen.getByText('dropped.mp4')).toBeTruthy(); expect(upload).not.toHaveBeenCalled();
  });
  it('creates once and uploads in order, retrying only the failed file', async () => {
    let failSecond = true; const order: string[] = [];
    upload.mockImplementation(async (_id, file) => { order.push(file.name); if (file.name === 'second.mp4' && failSecond) { failSecond = false; throw new Error('offline'); } return { id: file.name }; });
    render(<QaCreatePanel {...props} />); fill(); selectFiles([proof('first.mp4'), proof('second.mp4'), proof('third.mp4')]);
    fireEvent.click(screen.getByRole('button', { name: 'qa.createBug' }));
    await screen.findByText('qa.attachmentRetryHint');
    expect(create).toHaveBeenCalledTimes(1); expect(order).toEqual(['first.mp4', 'second.mp4']); expect(onCreated).not.toHaveBeenCalled();
    expect(screen.getByLabelText(/qa.titleField/)).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'qa.retryUpload' }));
    await waitFor(() => expect(onCreated).toHaveBeenCalledWith('fixed-issue'));
    expect(create).toHaveBeenCalledTimes(1); expect(order).toEqual(['first.mp4', 'second.mp4', 'second.mp4', 'third.mp4']);
    expect(upload.mock.calls[1][4]).toBe(upload.mock.calls[2][4]); expect(onCreated).toHaveBeenCalledTimes(1);
  });
  it('retains fixed IDs and the original payload when a create response is lost', async () => {
    create.mockRejectedValueOnce(new TypeError('offline')).mockResolvedValueOnce({ id: 'fixed-issue' });
    render(<QaCreatePanel {...props} />); fill(); fireEvent.click(screen.getByRole('button', { name: 'qa.createBug' }));
    await screen.findByText('qa.createRetryHint');
    expect(screen.getByLabelText(/qa.titleField/)).toBeDisabled(); expect(screen.getByRole('button', { name: 'qa.cancel' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'qa.retryCreate' }));
    await waitFor(() => expect(onCreated).toHaveBeenCalledTimes(1));
    expect(create.mock.calls[0].slice(0, 3)).toEqual(create.mock.calls[1].slice(0, 3));
    expect(create.mock.calls[0][1]).toBe('fixed-issue'); expect(create.mock.calls[0][2]).toBe('fixed-command'); expect(upload).not.toHaveBeenCalled();
  });
  it('unlocks fields after a definite validation rejection so the draft can be corrected', async () => {
    create.mockRejectedValueOnce({ status: 400, code: 'qa_invalid_title' });
    render(<QaCreatePanel {...props} />); fill(); fireEvent.click(screen.getByRole('button', { name: 'qa.createBug' }));
    await screen.findByText('qa.failed'); expect(screen.getByLabelText(/qa.titleField/)).not.toBeDisabled();
    fireEvent.change(screen.getByLabelText(/qa.titleField/), { target: { value: 'Corrected issue' } });
    fireEvent.click(screen.getByRole('button', { name: 'qa.createBug' }));
    await waitFor(() => expect(onCreated).toHaveBeenCalledTimes(1)); expect(create.mock.calls[1][0].title).toBe('Corrected issue');
  });
  it.each(['unmount', 'feature-off'])('blocks cancellation while uploading and aborts on %s without stale completion', async action => {
    let resolveUpload!: (value: unknown) => void;
    upload.mockImplementation(() => new Promise(resolve => { resolveUpload = resolve; }));
    const view = render(<QaCreatePanel {...props} />); fill(); selectFiles([proof()]); fireEvent.click(screen.getByRole('button', { name: 'qa.createBug' }));
    await waitFor(() => expect(upload).toHaveBeenCalledTimes(1));
    expect(screen.getByRole('button', { name: 'qa.openWithoutPendingFiles' })).toBeDisabled(); expect(screen.getByLabelText('qa.attach')).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'qa.openWithoutPendingFiles' })); expect(onCreated).not.toHaveBeenCalled(); expect(onCancel).not.toHaveBeenCalled();
    const signal = upload.mock.calls[0][3] as AbortSignal;
    if (action === 'unmount') view.unmount(); else fireEvent(window, new Event('livo:qa-abort'));
    expect(signal.aborted).toBe(true);
    await act(async () => resolveUpload({ id: 'attachment1' })); expect(onCreated).not.toHaveBeenCalled();
  });
  it('allows opening an already created Bug after an upload failure without creating or deleting another issue', async () => {
    upload.mockRejectedValue(new Error('offline')); render(<QaCreatePanel {...props} />); fill(); selectFiles([proof()]);
    fireEvent.click(screen.getByRole('button', { name: 'qa.createBug' })); await screen.findByText('qa.attachmentRetryHint');
    fireEvent.click(screen.getByRole('button', { name: 'qa.openWithoutPendingFiles' })); expect(onCreated).toHaveBeenCalledWith('fixed-issue'); expect(create).toHaveBeenCalledTimes(1); expect(onCancel).not.toHaveBeenCalled();
  });
  it('retries only the refresh after attachments were saved but the detail reload failed', async () => {
    const onChanged = vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValue(undefined);
    render(<QaAttachments issueId="existing" attachments={[]} client={client} onChanged={onChanged} onError={vi.fn()} />);
    selectFiles([proof()]); await screen.findByText('qa.attachmentsRefreshFailed');
    fireEvent.click(screen.getByRole('button', { name: 'qa.reload' })); await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(2));
    expect(upload).toHaveBeenCalledTimes(1); await waitFor(() => expect(screen.queryByText('proof.mp4')).toBeNull());
  });
  it('reports upload busy and releases it on unmount without aborting on callback changes', async () => {
    let resolveUpload!: (value: unknown) => void;
    upload.mockImplementation(() => new Promise(resolve => { resolveUpload = resolve; }));
    const firstBusy = vi.fn(), nextBusy = vi.fn(), onChanged = vi.fn().mockResolvedValue(undefined), onError = vi.fn();
    const view = render(<QaAttachments issueId="existing" attachments={[]} client={client} onChanged={onChanged} onError={onError} onBusyChange={firstBusy} />);
    selectFiles([proof()]); expect(firstBusy).toHaveBeenLastCalledWith(true);
    const signal = upload.mock.calls[0][3] as AbortSignal;
    view.rerender(<QaAttachments issueId="existing" attachments={[]} client={client} onChanged={onChanged} onError={onError} onBusyChange={nextBusy} />);
    expect(signal.aborted).toBe(false); expect(nextBusy).not.toHaveBeenCalled();
    view.unmount(); expect(signal.aborted).toBe(true); expect(nextBusy).toHaveBeenLastCalledWith(false);
    await act(async () => resolveUpload({ id: 'attachment1' })); expect(onChanged).not.toHaveBeenCalled();
  });
});
