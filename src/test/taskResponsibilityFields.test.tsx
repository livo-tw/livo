import { createRef } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { Task, User } from '@/types';
import type { TaskDetailState } from '@/components/task-detail/hooks/useTaskDetail';

const mocks = vi.hoisted(() => ({ from: vi.fn() }));
vi.mock('react-i18next', async importOriginal => ({
  ...await importOriginal<typeof import('react-i18next')>(), useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock('@/integrations/supabase/client', () => ({ supabase: { from: mocks.from } }));
vi.mock('@/context/UIContext', () => ({ useUIContext: () => ({ approvalsEnabled: false }) }));
vi.mock('@/context/MemberContext', () => ({ useMemberContext: () => ({ users }) }));
vi.mock('@/components/PortalConfirmDialog', () => ({ usePortalConfirmDialog: () => ({ confirm: vi.fn(), ConfirmDialog: null as null }) }));
import TaskSidebarFields from '@/components/task-detail/TaskSidebarFields';

const users = [
  { id: 'example-member', name: 'Example member', email: 'member@example.com', role: 'member', jobTitle: '', isActive: true },
  { id: 'example-reviewer', name: 'Example reviewer', email: 'reviewer@example.com', role: 'member', jobTitle: '', isActive: true },
  { id: 'third-member', name: 'Third member', email: 'third@example.com', role: 'member', jobTitle: '', isActive: true },
] as User[];
const task: Task = { id: 'task-example', taskKey: 'EX-1', projectId: 'project-example', title: 'Example task', statusId: 'open', priority: 'medium',
  assigneeId: users[0].id, reviewerId: users[1].id, assigneeRevision: 4, reviewerRevision: 2,
  creatorId: users[0].id, sortOrder: 0, createdAt: '2026-10-03T00:00:00Z', commentCount: 0, attachmentCount: 0, deployments: [] };
function detail(card = task) {
  return { task: card, allProjects: [], productLines: [], users, statuses: [], tags: [], customFields: [],
    permissions: { canEditProject: false, canDeleteTask: false }, sidebarFieldOrder: ['assignee', 'reviewer'], SIDEBAR_DEFAULT_ORDER: ['assignee', 'reviewer'],
    currentMemberId: users[0].id, currentMember: users[0], statusDropdownRef: createRef<HTMLDivElement>(), tagDropdownRef: createRef<HTMLDivElement>(),
    updateTask: vi.fn(), setSelectedTask: vi.fn(), setAllTasks: vi.fn(), isMobile: false } as unknown as TaskDetailState;
}
function expectAssignmentControls() {
  const controls = screen.getAllByRole('combobox');
  expect(controls).toHaveLength(2);
  expect(controls[0]).toHaveTextContent('Example member');
  expect(controls[1]).toHaveTextContent('Example reviewer');
  expect(screen.queryByText(/taskWork\.(acceptAssignment|acceptReview|awaitingAcknowledgement|acknowledgedAt|acknowledgementDescription)/)).toBeNull();
  expect(mocks.from).not.toHaveBeenCalled();
  return controls;
}

beforeEach(() => {
  mocks.from.mockReset();
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { configurable: true, value: vi.fn() });
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); Reflect.deleteProperty(HTMLElement.prototype, 'scrollIntoView'); });

describe('task assignment is effective without acceptance', () => {
  it('keeps both assigned members visible without fetching or offering acceptance', () => {
    render(<TaskSidebarFields detail={detail()} />);
    expectAssignmentControls();
  });
  it('does not display historical acceptance receipts as a current task requirement', () => {
    render(<TaskSidebarFields detail={detail({ ...task, assigneeAcknowledgedAt: '2026-10-03T01:00:00Z', reviewerAcknowledgedAt: '2026-10-03T01:00:00Z' })} />);
    expectAssignmentControls();
  });
  it('keeps reviewer assignment editable through the normal task update', async () => {
    const state = detail(); render(<TaskSidebarFields detail={state} />);
    fireEvent.click(expectAssignmentControls()[1]);
    fireEvent.click(await screen.findByRole('option', { name: /Third member/ }));
    expect(state.updateTask).toHaveBeenCalledExactlyOnceWith({ reviewerId: 'third-member' });
    expect(state.setSelectedTask).not.toHaveBeenCalled();
    expect(mocks.from).not.toHaveBeenCalled();
  });
});
