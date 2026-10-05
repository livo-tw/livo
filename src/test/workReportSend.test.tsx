import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ sendProps: vi.fn() }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('@/i18n', () => ({ default: { t: (key: string) => key, language: 'zh-TW' } }));
vi.mock('@/context/AuthContext', () => ({ useAuthContext: () => ({ currentMemberId: 'me' }) }));
vi.mock('@/context/ProjectContext', () => ({ useProjectContext: () => ({ selectedProjectId: 'hidden-project' }) }));
vi.mock('@/components/work-report/useWorkReport', () => ({ useWorkReport: (): Record<string, unknown> => ({
  reportType: 'weekly', setReportType: vi.fn(), anchor: new Date(2026, 9, 1), setAnchor: vi.fn(), title: 'Week', content: 'Done', setContent: vi.fn(),
  savedReport: null as null, setSavedReport: vi.fn(), loading: false, saving: false, saveStatus: 'idle', history: [] as unknown[], showHistory: false, setShowHistory: vi.fn(),
  lastLoadedContentRef: { current: '' }, completedCount: 0, inProgressCount: 0, overdueCount: 0, handleGenerate: vi.fn(), handleSave: vi.fn(), handleCopy: vi.fn(),
}) }));
vi.mock('@/components/work-report/WorkReportStats', () => ({ default: (): null => null }));
vi.mock('@/components/work-report/WorkReportHistory', () => ({ default: (): null => null }));
vi.mock('@/components/work-report/WorkReportEditor', () => ({ default: ({ onSend }: { onSend?: () => void }) => <button onClick={onSend}>send</button> }));
vi.mock('@/components/reports/ReportSendPanel', () => ({ default: (props: Record<string, unknown>): null => { mocks.sendProps(props); return null; } }));
import WorkReportView from '@/components/WorkReportView';

describe('sending a work report', () => {
  it('uses the workspace-wide targets, not a project picked in the hidden sidebar', () => {
    render(<WorkReportView />);
    fireEvent.click(screen.getByRole('button', { name: 'send' }));
    expect(mocks.sendProps).toHaveBeenCalled();
    expect(mocks.sendProps.mock.calls[0][0].projectId).toBeUndefined();
  });
});
