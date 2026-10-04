import { createRef } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import type { Status, Task, User } from '@/types';
import type { TaskDetailState } from '@/components/task-detail/hooks/useTaskDetail';
import type { ApprovalProgress as ProgressData } from '@/hooks/useApprovalWorkflow';

const mocks = vi.hoisted(() => ({ member: { id: 'self', role: 'admin' }, progress: null as unknown }));
vi.mock('react-i18next', async importOriginal => ({
  ...await importOriginal<typeof import('react-i18next')>(), useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock('@/context/UIContext', () => ({ useUIContext: () => ({ approvalsEnabled: true }) }));
vi.mock('@/integrations/supabase/client', () => ({ supabase: {} }));
vi.mock('@/components/PortalConfirmDialog', () => ({ usePortalConfirmDialog: () => ({ confirm: vi.fn(), ConfirmDialog: null as null }) }));
vi.mock('@/components/task-detail/ApprovalHistory', () => ({ default: (): null => null }));
vi.mock('@/context/AuthContext', () => ({ useAuthContext: () => ({ currentMemberId: mocks.member.id, currentMember: mocks.member }) }));
vi.mock('@/context/MemberContext', () => ({ useMemberContext: () => ({ users: [] as User[] }) }));
vi.mock('@/hooks/useApprovalWorkflow', () => ({ useApprovalWorkflow: () => ({
  getApprovalProgress: async () => mocks.progress, performAction: vi.fn(), cancelApproval: vi.fn(),
}) }));
import TaskSidebarFields from '@/components/task-detail/TaskSidebarFields';
import ApprovalProgress from '@/components/approval/ApprovalProgress';

const statuses: Status[] = [{ id: 'todo', name: 'Todo', color: '#6554C0', sortOrder: 0, isDone: false, autoStart: false, autoDone: false }];
const task: Task = { id: 'task-example', taskKey: 'EX-1', projectId: 'project-example', title: 'Example task', statusId: 'todo', priority: 'medium',
  creatorId: 'self', sortOrder: 0, createdAt: '2026-10-03T00:00:00Z', commentCount: 0, attachmentCount: 0, deployments: [] };
function detail(requiresApproval: boolean, role: string) {
  return { task: { ...task, requiresApproval }, statuses, allProjects: [], productLines: [], users: [], tags: [], customFields: [],
    permissions: { canEditProject: false, canDeleteTask: false }, sidebarFieldOrder: ['status'], SIDEBAR_DEFAULT_ORDER: ['status'],
    currentMemberId: 'self', currentMember: { id: 'self', role, isActive: true },
    statusDropdownRef: createRef<HTMLDivElement>(), tagDropdownRef: createRef<HTMLDivElement>(),
    statusDropdownOpen: false, setStatusDropdownOpen: vi.fn(), handleStatusChange: vi.fn(), updateTask: vi.fn(),
    setSelectedTask: vi.fn(), setAllTasks: vi.fn(), isMobile: false } as unknown as TaskDetailState;
}
const progress = (requestedBy: string, ruleId: string | null = null): ProgressData => ({ requestedBy, requestStatus: 'pending', currentStep: 1, totalSteps: 1,
  version: 1, legacy: false, ruleId, steps: [{ stepOrder: 1, approverType: 'role', approverRole: 'admin', approverUserId: null, status: 'pending', comment: null, actedAt: null, actionBy: null }] });

beforeEach(() => { vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} }); mocks.member = { id: 'self', role: 'admin' }; });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('requires-approval switch', () => {
  it('keeps the requirement locked on for members and explains why', () => {
    render(<TaskSidebarFields detail={detail(true, 'member')} />);
    const toggle = screen.getByRole('switch', { name: 'taskDetail.sidebar.requiresApproval' });
    expect(toggle).toBeDisabled();
    expect(toggle).toHaveAttribute('aria-checked', 'true');
    expect(toggle).toHaveAttribute('title', 'approvalCommand.requirementAdminOnly');
  });
  it('lets a member turn the requirement on', () => {
    render(<TaskSidebarFields detail={detail(false, 'member')} />);
    const toggle = screen.getByRole('switch', { name: 'taskDetail.sidebar.requiresApproval' });
    expect(toggle).toBeEnabled();
    expect(toggle).not.toHaveAttribute('title');
  });
  it.each(['admin', 'super_admin'])('lets %s turn the requirement off', role => {
    render(<TaskSidebarFields detail={detail(true, role)} />);
    expect(screen.getByRole('switch', { name: 'taskDetail.sidebar.requiresApproval' })).toBeEnabled();
  });
});

describe('approval decision buttons', () => {
  it.each(['admin', 'super_admin'])('hides decisions from a requester who is also %s and explains who decides', async role => {
    mocks.member = { id: 'self', role }; mocks.progress = progress('self');
    render(<ApprovalProgress approvalRequestId="request-example" />);
    expect(await screen.findByText('approvalCommand.selfDecisionHint')).toBeInTheDocument();
    for (const name of ['approval.approve', 'approval.returnAction', 'approval.reject']) expect(screen.queryByRole('button', { name: new RegExp(name) })).toBeNull();
    expect(screen.getByRole('button', { name: /approval.cancelApproval/ })).toBeInTheDocument();
  });
  it('shows decisions to another eligible approver', async () => {
    mocks.member = { id: 'another-admin', role: 'admin' }; mocks.progress = progress('self');
    render(<ApprovalProgress approvalRequestId="request-example" />);
    expect(await screen.findByRole('button', { name: /approval.approve/ })).toBeInTheDocument();
    expect(screen.queryByText('approvalCommand.selfDecisionHint')).toBeNull();
  });
  it('lets an administrator withdraw someone else\'s request (pre-upgrade requests can only be withdrawn)', async () => {
    mocks.member = { id: 'another-admin', role: 'admin' }; mocks.progress = { ...progress('requester'), legacy: true };
    render(<ApprovalProgress approvalRequestId="request-example" />);
    expect(await screen.findByRole('button', { name: /approval.cancelApproval/ })).toBeInTheDocument();
  });
  it('does not offer withdraw to a member who did not request it', async () => {
    mocks.member = { id: 'bystander', role: 'member' }; mocks.progress = progress('requester');
    render(<ApprovalProgress approvalRequestId="request-example" />);
    await screen.findByText(/approval/);
    expect(screen.queryByRole('button', { name: /approval.cancelApproval/ })).toBeNull();
  });
  it('does not show the hint to a requester who is not an eligible approver', async () => {
    mocks.member = { id: 'self', role: 'member' }; mocks.progress = progress('self');
    render(<ApprovalProgress approvalRequestId="request-example" />);
    expect(await screen.findByRole('button', { name: /approval.cancelApproval/ })).toBeInTheDocument();
    expect(screen.queryByText('approvalCommand.selfDecisionHint')).toBeNull();
    expect(screen.queryByRole('button', { name: /approval.approve/ })).toBeNull();
  });
});
