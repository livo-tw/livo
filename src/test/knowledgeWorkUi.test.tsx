import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import KnowledgeWorkSearch from '@/components/knowledge-work/KnowledgeWorkSearch';
import KnowledgeDraftComposer from '@/components/knowledge-work/KnowledgeDraftComposer';
import KnowledgeWorkPanel from '@/components/knowledge-work/KnowledgeWorkPanel';
import type { KnowledgeCoverage, KnowledgeDraftPreview, KnowledgeSearchItem, KnowledgeSearchResult, KnowledgeWorkClient, KnowledgeWorkDetail } from '@/lib/knowledgeWork/client';
import en from '@/i18n/locales/en.json';

vi.mock('@/context/ProjectContext', () => ({ useProjectContext: () => ({ allProjects: [] as unknown[], productLines: [] as unknown[] }) }));
vi.mock('@/context/MemberContext', () => ({ useMemberContext: () => ({ users: [{ id: 'member-1', name: 'Example member' }] }) }));
vi.mock('@/components/UserSelect', () => ({ default: ({ value, onChange }: { value: string; onChange: (value: string) => void }) => <select aria-label="Owner" value={value} onChange={event => onChange(event.target.value)}><option value="">Choose</option><option value="member-1">Example member</option></select> }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string, opts?: Record<string, unknown>) => {
  let value: unknown = en;
  for (const part of key.split('.')) value = (value as Record<string, unknown>)?.[part];
  return String(value || key).replace(/\{\{(\w+)\}\}/g, (_, name) => String(opts?.[name] ?? ''));
} }) }));
afterEach(cleanup);
const deferred = <T,>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; };
const coverage: KnowledgeCoverage = { complete: true, sources: 0, unavailable: 0, limitations: [] };
const searchResult = (count = 1, start = 1): KnowledgeSearchResult => ({
  items: Array.from({ length: count }, (_, index): KnowledgeSearchItem => ({ kind: 'knowledge', id: 'page-' + (start + index), pageId: 'page-' + (start + index), title: 'Result ' + (start + index), version: '1', projectId: null, effective: true })),
  nextCursor: null, coverage,
});
const detail = (pageVersion = 1): KnowledgeWorkDetail => ({
  pageId: 'page-1', pageVersion, title: 'Example specification', body: '<p>Reviewed body</p>', projectId: null, parentId: null, privateDraftOwnerId: null,
  metadata: { documentKind: 'specification', ownerId: 'member-1', applicability: { productVersion: null, environment: null, summary: null } },
  publication: null, links: [], linkItems: [], canEdit: true, canShare: false,
});
const preview: KnowledgeDraftPreview = { kind: 'meeting', title: 'Meeting draft', text: 'Reviewed notes', sourceRefs: [], period: null, coverage, previewFingerprint: '[]' };
const fake = (overrides: Record<string, unknown> = {}) => ({
  search: vi.fn(async () => searchResult()), get: vi.fn(async () => detail()), prepare: vi.fn(async () => preview),
  save: vi.fn(async () => ({ commandId: 'command-1', replayed: false, eventId: 'event-1', page: detail() })),
  publish: vi.fn(async () => ({ commandId: 'command-1', replayed: false, eventId: 'event-1', page: detail() })),
  ...overrides,
}) as unknown as KnowledgeWorkClient;

describe('knowledge work review and privacy flows', () => {
  it('shows the entire server page and follows the supplied next cursor', async () => {
    const search = vi.fn().mockResolvedValueOnce({ ...searchResult(20), nextCursor: 20 }).mockResolvedValueOnce(searchResult(1, 21));
    render(<KnowledgeWorkSearch client={fake({ search })} />);
    fireEvent.click(screen.getByRole('button', { name: 'Search' }));
    await screen.findByText('Result 20');
    expect(screen.getAllByRole('listitem')).toHaveLength(20);
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    await screen.findByText('Result 21');
    expect(search.mock.calls[1][0].cursor).toBe(20);
  });
  it('discards a former account response and allows the new account to search immediately', async () => {
    const old = deferred<KnowledgeSearchResult>();
    const oldClient = fake({ search: vi.fn(() => old.promise) });
    const newClient = fake({ search: vi.fn(async () => searchResult(1, 99)) });
    const view = render(<KnowledgeWorkSearch client={oldClient} />);
    fireEvent.click(screen.getByRole('button', { name: 'Search' }));
    view.rerender(<KnowledgeWorkSearch client={newClient} />);
    fireEvent.click(screen.getByRole('button', { name: 'Search' }));
    await screen.findByText('Result 99');
    await act(async () => old.resolve(searchResult(1, 1)));
    expect(screen.queryByText('Result 1')).not.toBeInTheDocument();
    expect(screen.getByText('Result 99')).toBeInTheDocument();
  });
  it('previews without saving, requires explicit confirmation, and resets confirmation after editing', async () => {
    const client = fake();
    render(<KnowledgeDraftComposer client={client} onSaved={vi.fn(async () => {})} />);
    fireEvent.change(screen.getByRole('textbox', { name: 'Notes' }), { target: { value: 'Meeting notes' } });
    fireEvent.click(screen.getByRole('button', { name: 'Prepare preview' }));
    await screen.findByRole('textbox', { name: /^Review and edit content/ });
    expect(client.save).not.toHaveBeenCalled();
    const save = screen.getByRole('button', { name: 'Save private draft' });
    expect(save).toBeDisabled();
    fireEvent.click(screen.getByRole('checkbox', { name: /confirm saving it/ }));
    expect(save).toBeEnabled();
    fireEvent.change(screen.getByRole('textbox', { name: /^Review and edit content/ }), { target: { value: 'Corrected notes' } });
    expect(save).toBeDisabled();
    fireEvent.click(screen.getByRole('checkbox', { name: /confirm saving it/ }));
    fireEvent.click(save);
    await screen.findByText('Private draft saved.');
    expect(client.save).toHaveBeenCalledTimes(1);
    expect(client.save).toHaveBeenCalledWith(expect.objectContaining({ text: 'Corrected notes', confirmed: true }));
  });
  it('does not repeat a successful save when opening or refreshing the draft fails', async () => {
    const client = fake(), onSaved = vi.fn(async () => { throw new Error('refresh failed'); });
    render(<KnowledgeDraftComposer client={client} onSaved={onSaved} />);
    fireEvent.change(screen.getByRole('textbox', { name: 'Notes' }), { target: { value: 'Meeting notes' } });
    fireEvent.click(screen.getByRole('button', { name: 'Prepare preview' }));
    await screen.findByRole('checkbox', { name: /confirm saving it/ });
    fireEvent.click(screen.getByRole('checkbox', { name: /confirm saving it/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Save private draft' }));
    await screen.findByText(/Saved, but the view could not refresh/);
    fireEvent.click(screen.getByRole('button', { name: 'Open draft' }));
    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(2));
    expect(client.save).toHaveBeenCalledTimes(1);
  });
  it('blocks saving incomplete source previews', async () => {
    const client = fake({ prepare: vi.fn(async () => ({ ...preview, coverage: { ...coverage, complete: false, unavailable: 1 } })) });
    render(<KnowledgeDraftComposer client={client} onSaved={vi.fn(async () => {})} />);
    fireEvent.change(screen.getByRole('textbox', { name: 'Notes' }), { target: { value: 'Notes' } });
    fireEvent.click(screen.getByRole('button', { name: 'Prepare preview' }));
    await screen.findByRole('checkbox', { name: /confirm saving it/ });
    fireEvent.click(screen.getByRole('checkbox', { name: /confirm saving it/ }));
    expect(screen.getByRole('button', { name: 'Save private draft' })).toBeDisabled();
    expect(client.save).not.toHaveBeenCalled();
  });
  it('publishes the reviewed revision even when newer content arrives, allowing server conflict detection', async () => {
    const get = vi.fn().mockResolvedValueOnce(detail(1)).mockResolvedValueOnce(detail(2));
    const publish = vi.fn(async () => { throw new Error('knowledge_conflict'); });
    const client = fake({ get, publish });
    const view = render(<KnowledgeWorkPanel client={client} pageId="page-1" pageVersion={1} parents={[]} onChanged={vi.fn(async () => {})} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Publish effective version' }));
    expect(publish).not.toHaveBeenCalled();
    view.rerender(<KnowledgeWorkPanel client={client} pageId="page-1" pageVersion={2} parents={[]} onChanged={vi.fn(async () => {})} />);
    await waitFor(() => expect(get).toHaveBeenCalledTimes(2));
    fireEvent.click(screen.getByRole('checkbox', { name: /confirm publishing it/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Confirm publication' }));
    await waitFor(() => expect(publish).toHaveBeenCalledWith({ pageId: 'page-1', expectedVersion: 1, expectedPublicationId: null, confirmed: true }));
  });
  it('does not disclose stale titles for unavailable references', async () => {
    const client = fake({ get: vi.fn(async () => ({ ...detail(), links: [{ kind: 'knowledge', id: 'restricted-page-secret', version: '1' }], linkItems: [] })) });
    render(<KnowledgeWorkPanel client={client} pageId="page-1" pageVersion={1} parents={[]} onChanged={vi.fn(async () => {})} />);
    await screen.findByText(/Reference 1 \(unavailable\)/);
    expect(screen.queryByText(/restricted-page-secret/)).not.toBeInTheDocument();
  });
  it('requires an explicit destination and confirmation to share an owned private draft', async () => {
    const share = vi.fn(async () => ({ commandId: 'command-1', replayed: false, eventId: 'event-1', page: detail() }));
    const client = fake({ get: vi.fn(async () => ({ ...detail(), privateDraftOwnerId: 'member-1', canShare: true })), share });
    render(<KnowledgeWorkPanel client={client} pageId="page-1" pageVersion={1} parents={[]} onChanged={vi.fn(async () => {})} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Share private draft' }));
    const submit = screen.getByRole('button', { name: 'Confirm sharing' });
    fireEvent.click(screen.getByRole('checkbox', { name: /confirm sharing this draft/ }));
    expect(submit).toBeDisabled();
    fireEvent.change(screen.getByRole('combobox', { name: 'Sharing destination' }), { target: { value: '' } });
    expect(submit).toBeDisabled();
    fireEvent.click(screen.getByRole('checkbox', { name: /confirm sharing this draft/ }));
    fireEvent.click(submit);
    await waitFor(() => expect(share).toHaveBeenCalledWith({ pageId: 'page-1', expectedVersion: 1, projectId: null, parentId: null, confirmed: true }));
  });
  it('refreshes a confirmed publication failure without repeating the write', async () => {
    const get = vi.fn().mockResolvedValueOnce(detail()).mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce(detail(2));
    const client = fake({ get });
    render(<KnowledgeWorkPanel client={client} pageId="page-1" pageVersion={1} parents={[]} onChanged={vi.fn(async () => {})} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Publish effective version' }));
    fireEvent.click(screen.getByRole('checkbox', { name: /confirm publishing it/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Confirm publication' }));
    await screen.findByText(/Saved, but the view could not refresh/);
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await screen.findByRole('button', { name: 'Publish effective version' });
    expect(client.publish).toHaveBeenCalledTimes(1);
  });
});
