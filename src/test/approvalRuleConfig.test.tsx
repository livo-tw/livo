import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  create: vi.fn(), update: vi.fn(), remove: vi.fn(), log: vi.fn(), confirm: vi.fn(), fetch: vi.fn(),
  rules: [{ id: 'rule-1', project_id: 'p1', from_status: 'todo', to_status: 'done', is_active: true }],
}));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock('@/hooks/useProjectColor', () => ({ useProjectColor: () => () => '#000' }));
vi.mock('@/hooks/useApprovalRules', () => ({ useApprovalRules: () => ({ rules: mocks.rules, stepsMap: {}, loading: false, fetchRulesForProjects: mocks.fetch, createRule: mocks.create, updateRuleWithSteps: mocks.update, deleteRule: mocks.remove }) }));
vi.mock('@/context/ProjectContext', () => ({ useProjectContext: () => ({ allProjects: [{ id: 'p1', name: 'Shop', lineId: 'l' }, { id: 'p2', name: 'Games', lineId: 'l' }], productLines: [{ id: 'l', name: 'Line' }] }) }));
vi.mock('@/context/TaskContext', () => ({ useTaskContext: () => ({ statuses: [{ id: 'todo', name: 'To do' }, { id: 'done', name: 'Done' }] }) }));
vi.mock('@/context/MemberContext', () => ({ useMemberContext: () => ({ users: [] as unknown[] }) }));
vi.mock('@/context/AuthContext', () => ({ useAuthContext: () => ({ permissions: { canEditProject: true }, currentMemberId: 'admin' }) }));
vi.mock('@/lib/activityLog', () => ({ logActivity: mocks.log }));
vi.mock('@/components/ConfirmDialog', () => ({ useConfirmDialog: () => ({ confirm: mocks.confirm, ConfirmDialog: null as null }) }));
import ApprovalRuleConfig from '@/components/approval/ApprovalRuleConfig';

beforeEach(() => { vi.clearAllMocks(); mocks.confirm.mockResolvedValue(true); mocks.update.mockResolvedValue({ id: 'rule-1' }); mocks.create.mockResolvedValue({ id: 'new' }); mocks.remove.mockResolvedValue(true); });

const editDialog = async () => {
  render(<ApprovalRuleConfig />);
  fireEvent.click(await screen.findByRole('button', { name: 'approval.ruleConfig.editRule' }));
  return within(screen.getByRole('dialog'));
};

describe('approval rule settings', () => {
  it('editing with another project chosen saves both instead of only the first', async () => {
    const dialog = await editDialog();
    fireEvent.click(dialog.getByRole('checkbox', { name: /Games/ }));
    fireEvent.click(dialog.getByRole('button', { name: 'common.save' }));
    await waitFor(() => expect(mocks.create).toHaveBeenCalledWith('p2', 'todo', 'done', expect.any(Array)));
    expect(mocks.update).toHaveBeenCalledWith('rule-1', expect.objectContaining({ project_id: 'p1' }), expect.any(Array));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('keeps the dialog open with the projects that failed, and logs only what was saved', async () => {
    mocks.create.mockResolvedValue(null);
    const dialog = await editDialog();
    fireEvent.click(dialog.getByRole('checkbox', { name: /Games/ }));
    fireEvent.click(dialog.getByRole('button', { name: 'common.save' }));
    await waitFor(() => expect(mocks.create).toHaveBeenCalled());
    expect(screen.getByRole('dialog')).toBeTruthy();
    expect(within(screen.getByRole('dialog')).getByRole('checkbox', { name: /Games/ })).toBeChecked();
    expect(within(screen.getByRole('dialog')).getByRole('checkbox', { name: /Shop/ })).not.toBeChecked();
    expect(mocks.log).toHaveBeenCalledTimes(1);
    expect(mocks.log).toHaveBeenCalledWith('admin', 'approval_rule_updated', expect.any(String), undefined, undefined, 'system');
  });

  it('asks in the app before deleting and logs only a delete that happened', async () => {
    mocks.remove.mockResolvedValue(false);
    render(<ApprovalRuleConfig />);
    fireEvent.click(await screen.findByRole('button', { name: 'approval.ruleConfig.deleteRule' }));
    await waitFor(() => expect(mocks.remove).toHaveBeenCalledWith('rule-1'));
    expect(mocks.confirm).toHaveBeenCalledWith(expect.objectContaining({ destructive: true }));
    expect(mocks.log).not.toHaveBeenCalled();
  });

  it('lets the project filter be cleared', async () => {
    render(<ApprovalRuleConfig />);
    fireEvent.click(await screen.findByRole('button', { name: /approval.ruleConfig.allProjects/ }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'approval.ruleConfig.selectAll' }));
    await waitFor(() => expect(screen.getByRole('button', { name: /approval.ruleConfig.selectProject/ })).toBeTruthy());
    expect(screen.queryByRole('button', { name: 'approval.ruleConfig.editRule' })).toBeNull();
  });
});
