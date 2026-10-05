import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { DEFAULT_QA_WORKFLOW } from '@/lib/qa/workflow';
import type { ProductLine, Project } from '@/types';

const mocks = vi.hoisted(() => ({
  client: {
    getWorkflow: vi.fn(), get: vi.fn(), list: vi.fn(), getCoordination: vi.fn(),
  },
}));
vi.mock('react-i18next', async (importOriginal) => ({
  ...await importOriginal<typeof import('react-i18next')>(),
  useTranslation: () => ({ t: (key: string) => key }),
}));
import '@/i18n';
vi.mock('@/context/UIContext', () => ({ useUIContext: () => ({ featureToggles: { qa: true }, featureTogglesReady: true, taskDisplayMode: 'side', setTaskDisplayMode: vi.fn() }) }));
vi.mock('@/context/ProjectContext', () => ({ useProjectContext: () => ({ allProjects: [] as Project[], productLines: [] as ProductLine[], selectedProjectId: null as string | null, selectedLineId: null as string | null, setSelectedProjectId: vi.fn(), setSelectedLineId: vi.fn() }) }));
vi.mock('@/context/MemberContext', () => ({ useMemberContext: () => ({ users: [] as never[] }) }));
vi.mock('@/integrations/supabase/client', () => ({ USING_MOCK_BACKEND: true, supabase: {} }));
vi.mock('@/hooks/useQa', () => ({ useQa: () => ({ client: mocks.client, actor: { id: 'example-admin', role: 'admin' } }) }));
vi.mock('@/components/qa/QaKanban', () => ({ default: ({ reloadToken }: { reloadToken?: number }) => <output aria-label="board reloads">{reloadToken ?? 0}</output> }));
vi.mock('@/components/qa/QaIssueDetail', () => ({
  default: ({ onRefresh, onBack }: { onRefresh: () => Promise<void>; onBack: () => void }) => <div>
    <button onClick={() => void onRefresh()}>command done</button>
    <button onClick={onBack}>close bug</button>
  </div>,
  QaFailure: (): null => null,
}));
vi.mock('@/components/qa/QaCreatePanel', () => ({ default: ({ onCreated }: { onCreated: (id: string) => void }) => <button onClick={() => onCreated('qa-new')}>report saved</button> }));
vi.mock('@/components/qa/QaRecordView', () => ({ default: ({ children }: { children: React.ReactNode }) => <section>{children}</section> }));
import QaWorkspace from '@/components/qa/QaWorkspace';

const detail = { issue: { id: 'qa-new', title: 'Example bug', projectId: 'p1', state: 'new' }, events: [] as never[], coordination: null as null };
beforeAll(() => { vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} }); });
afterEach(() => { cleanup(); vi.clearAllMocks(); window.history.replaceState({}, '', '/'); });

describe('QA board after work in the bug view', () => {
  it('reloads when a bug is reported, changed in the detail, and closed', async () => {
    mocks.client.getWorkflow.mockResolvedValue(DEFAULT_QA_WORKFLOW);
    mocks.client.get.mockResolvedValue(detail);
    render(<QaWorkspace />);
    const reloads = () => Number(screen.getByLabelText('board reloads').textContent);
    await waitFor(() => expect(screen.getByLabelText('board reloads')).toBeInTheDocument());
    expect(reloads()).toBe(0);

    act(() => { window.dispatchEvent(new Event('livo:qa-create')); });
    fireEvent.click(await screen.findByRole('button', { name: 'report saved' }));
    await waitFor(() => expect(reloads()).toBe(1));

    fireEvent.click(await screen.findByRole('button', { name: 'command done' }));
    await waitFor(() => expect(reloads()).toBe(2));

    fireEvent.click(screen.getByRole('button', { name: 'close bug' }));
    await waitFor(() => expect(reloads()).toBe(3));
    expect(screen.queryByRole('button', { name: 'close bug' })).toBeNull();
  });
});
