import type { ComponentProps } from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import i18n from '@/i18n';
import MemberTableDesktop from '@/components/member-manage/MemberTableDesktop';
import MemberCardsMobile from '@/components/member-manage/MemberCardsMobile';
import { getPermissions } from '@/lib/permissions';
import { selectedMemberRole } from '@/lib/memberRoleSelection';

beforeEach(async () => { await i18n.changeLanguage('en'); });
afterEach(async () => { cleanup(); await i18n.changeLanguage('zh-TW'); });
const props = (): ComponentProps<typeof MemberTableDesktop> => ({
  memberStats: [{ user: { id: 'example-user', name: 'Example member', avatar: 'E', color: '#0065FF', role: 'member', qaAdmin: true, email: 'member@example.com', jobTitle: 'QA', isActive: true }, assignedCount: 0, completedCount: 0, commentCount: 0, lastActivity: null }],
  currentMemberId: 'example-admin', isSuperAdmin: true, canReorder: false, dragIndex: null, dragOverIndex: null, actionLoading: null,
  isLockedBy: () => null, formatDate: () => '', onDragStart: vi.fn(), onDragOver: vi.fn(), onDragEnd: vi.fn(), onRoleChange: vi.fn(), onToggleActive: vi.fn(), onDelete: vi.fn(), onResetPassword: vi.fn(), onCreateLogin: vi.fn(), onEditJobTitle: vi.fn(),
});
describe('QA administration is a selectable scoped capability', () => {
  it.each(['desktop', 'mobile'] as const)('shows the current QA capability and emits the virtual choice from the %s picker', mode => {
    const values = props();
    render(mode === 'desktop' ? <MemberTableDesktop {...values} /> : <MemberCardsMobile {...values} onTouchStart={vi.fn()} onTouchMove={vi.fn()} onTouchEnd={vi.fn()} />);
    const picker = screen.getByRole('combobox') as HTMLSelectElement;
    expect(picker.value).toBe('qa_admin'); expect(screen.getByRole('option', { name: 'QA administrator' })).toBeTruthy();
    fireEvent.change(picker, { target: { value: 'member' } }); expect(values.onRoleChange).toHaveBeenCalledWith('example-user', 'member');
    fireEvent.change(picker, { target: { value: 'qa_admin' } }); expect(values.onRoleChange).toHaveBeenLastCalledWith('example-user', 'qa_admin');
  });
  it('preserves existing global administrator roles and does not elevate member task permissions', () => {
    expect(selectedMemberRole({ role: 'admin', qaAdmin: true })).toBe('admin');
    expect(selectedMemberRole({ role: 'super_admin', qaAdmin: true })).toBe('super_admin');
    expect(selectedMemberRole({ role: 'member', qaAdmin: false })).toBe('member');
    expect(getPermissions('member')).toEqual({ canDeleteProject: false, canEditProject: false, canManageStatuses: false, canDeleteTask: false, canManageMembers: false, canViewMemberList: false });
  });
});
