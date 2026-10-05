import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ canViewMemberList: false, setCurrentView: vi.fn(), consoleError: vi.fn() }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('@/context/TaskContext', () => ({ useTaskContext: () => ({ allTasks: [{ id: 't1', taskKey: 'EX-7', title: '登入頁面跑版', projectId: 'p1', createdAt: '2026-10-01T00:00:00Z' }], taskSpecs: [] as never[] }) }));
vi.mock('@/context/ProjectContext', () => ({ useProjectContext: () => ({ allProjects: [] as never[], productLines: [] as never[], setSelectedProjectId: vi.fn(), setSelectedLineId: vi.fn() }) }));
vi.mock('@/context/MemberContext', () => ({ useMemberContext: () => ({ users: [{ id: 'm2', email: 'm2@example.com', name: 'Example Person', isActive: true, avatar: 'E', color: '#000000', role: 'member' }] }) }));
vi.mock('@/context/UIContext', () => ({ useUIContext: () => ({ currentView: 'board', setSelectedTask: vi.fn(), setTaskDisplayMode: vi.fn(), setCurrentView: mocks.setCurrentView, showCreateTask: false, setShowCreateTask: vi.fn() }) }));
vi.mock('@/context/AuthContext', () => ({ useAuthContext: () => ({ permissions: { canViewMemberList: mocks.canViewMemberList } }) }));
import CommandPalette from '@/components/CommandPalette';

beforeAll(() => {
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  Element.prototype.scrollIntoView = vi.fn();
});
afterEach(() => { cleanup(); vi.clearAllMocks(); });

async function pickMember() {
  render(<CommandPalette />);
  act(() => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', ctrlKey: true })); });
  fireEvent.change(await screen.findByRole('combobox'), { target: { value: 'Example' } });
  fireEvent.click(await screen.findByText('Example Person'));
}

describe('Ctrl+K member results', () => {
  it('finds tasks and people by what they are called, not by their internal id', async () => {
    render(<CommandPalette />);
    act(() => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', ctrlKey: true })); });
    fireEvent.change(await screen.findByRole('combobox'), { target: { value: '登入' } });
    expect(await screen.findByText('登入頁面跑版')).toBeTruthy();
  });
  it('opens the team page for members, who cannot see member management', async () => {
    mocks.canViewMemberList = false;
    const spy = vi.spyOn(console, 'error').mockImplementation(mocks.consoleError);
    await pickMember();
    expect(mocks.setCurrentView).toHaveBeenCalledWith('team-intro');
    expect(screen.queryByRole('dialog')).toBeNull();
    // The dialog has an accessible title, so Radix no longer reports one missing.
    expect(mocks.consoleError.mock.calls.flat().join(' ')).not.toContain('DialogTitle');
    spy.mockRestore();
  });
  it('keeps opening member management for administrators', async () => {
    mocks.canViewMemberList = true;
    await pickMember();
    expect(mocks.setCurrentView).toHaveBeenCalledWith('team-manage');
  });
});
