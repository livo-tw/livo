import { act, cleanup, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ copy: vi.fn(), success: vi.fn(), error: vi.fn(), from: vi.fn() }));
vi.mock('@/lib/clipboard', () => ({ copyCardLink: mocks.copy, copyText: vi.fn() }));
vi.mock('sonner', () => ({ toast: { success: mocks.success, error: mocks.error, info: vi.fn() } }));
vi.mock('@/i18n', () => ({ default: { t: (key: string) => key } }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('@/integrations/supabase/client', () => ({ supabase: { from: mocks.from } }));
vi.mock('@/lib/activityLog', () => ({ logActivity: vi.fn() }));
vi.mock('@/lib/slackNotify', () => ({ sendSlackNotify: vi.fn() }));
vi.mock('@/hooks/use-mobile', () => ({ useIsMobile: () => false }));
vi.mock('@/context/UIContext', () => ({ useUIContext: () => ({ taskDisplayMode: 'page', setTaskDisplayMode: vi.fn() }) }));
import QaRecordView from '@/components/qa/QaRecordView';
import { useTaskActions, type UseTaskActionsParams } from '@/components/task-detail/hooks/useTaskActions';

beforeEach(() => { mocks.copy.mockReset().mockResolvedValue(true); mocks.success.mockClear(); mocks.error.mockClear(); mocks.from.mockClear(); });
afterEach(() => { cleanup(); vi.unstubAllEnvs(); });

describe('only card-link copy actions use the titled clipboard format', () => {
  it.each(['/', '/demo/'])('copies the actual Task ID with its visible key and title under %s', async base => {
    vi.stubEnv('BASE_URL', base);
    const input = { task: { id: 'saved-task', taskKey: 'EX-12', title: 'Example task' }, statuses: [], users: [], allProjects: [] } as unknown as UseTaskActionsParams;
    const { result } = renderHook(() => useTaskActions(input));
    await act(async () => { result.current.handleCopyLink(); });
    expect(mocks.copy).toHaveBeenCalledWith(`${window.location.origin}${base}?task=saved-task`, 'EX-12 · Example task');
    expect(mocks.from).not.toHaveBeenCalled();
  });

  it.each(['/', '/demo/'])('copies the loaded QA record rather than a stale current browser query under %s', async base => {
    vi.stubEnv('BASE_URL', base);
    render(<QaRecordView title="Example bug" copyRecord={{ id: 'saved-12345678', title: 'Example bug' }} busy={false} onClose={vi.fn()}><p>Detail</p></QaRecordView>);
    fireEvent.click(screen.getByRole('button', { name: 'task.copyLink' }));
    await waitFor(() => expect(mocks.copy).toHaveBeenCalledWith(`${window.location.origin}${base}?qa=saved-12345678`, '#12345678 · Example bug'));
  });

  it('does not copy a placeholder or stale record before the current QA detail is available', () => {
    render(<QaRecordView title="Loading" busy={false} onClose={vi.fn()}><p>Loading</p></QaRecordView>);
    expect(screen.getByRole('button', { name: 'task.copyLink' })).toBeDisabled();
    expect(mocks.copy).not.toHaveBeenCalled();
  });
});
