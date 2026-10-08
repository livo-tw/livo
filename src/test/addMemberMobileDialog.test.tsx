import { useRef, useState, type ComponentProps, type FormEvent } from 'react';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import i18n from '@/i18n';
import AddMemberModal from '@/components/member-manage/AddMemberModal';

vi.mock('@/components/member-manage/MemberInvitationPanel', () => ({ default: (): null => null }));

const openManual = () => fireEvent.mouseDown(screen.getByRole('tab', { name: i18n.t('memberInvite.manualTab') }), { button: 0, ctrlKey: false });

type Form = ComponentProps<typeof AddMemberModal>['form'];
function Harness({ onClose = vi.fn(), onSubmit = vi.fn(), canEditJobTitle = true, loading = false, startOpen = true }: {
  onClose?: () => void; onSubmit?: (event: FormEvent) => void; canEditJobTitle?: boolean; loading?: boolean; startOpen?: boolean;
}) {
  const [show, setShow] = useState(startOpen);
  const [form, setForm] = useState<Form>({ email: '', name: '', role: 'member', jobTitle: '', password: '' });
  const [jobTitleOpen, setJobTitleOpen] = useState(false);
  const jobTitleRef = useRef<HTMLDivElement>(null);
  return <>
    <button type="button" onClick={() => setShow(true)}>Add example member</button>
    <AddMemberModal show={show} onClose={() => { onClose(); setShow(false); }} form={form} setForm={setForm} jobTitleRef={jobTitleRef} jobTitleOpen={jobTitleOpen} setJobTitleOpen={setJobTitleOpen} filteredJobTitles={['Engineer', 'QA lead']} onSubmit={onSubmit} loading={loading} canEditJobTitle={canEditJobTitle} />
  </>;
}

beforeEach(async () => { await i18n.changeLanguage('en'); });
afterEach(async () => { cleanup(); await i18n.changeLanguage('zh-TW'); });

describe('mobile member creation dialog', () => {
  it.each(['cancel', 'Escape', 'close'] as const)('returns focus to the invoking member button after %s dismissal', async dismissal => {
    const close = vi.fn();
    render(<Harness startOpen={false} onClose={close} />);
    const trigger = screen.getByRole('button', { name: 'Add example member' });
    trigger.focus();
    fireEvent.click(trigger);
    const dialog = screen.getByRole('dialog', { name: i18n.t('memberList.addMemberTitle') });
    expect(dialog).toHaveFocus();
    openManual();
    screen.getByLabelText(/Email/).focus();
    if (dismissal === 'Escape') fireEvent.keyDown(document.activeElement!, { key: 'Escape' });
    else fireEvent.click(screen.getByRole('button', { name: dismissal === 'cancel' ? i18n.t('memberList.cancelButton') : 'Close' }));
    expect(close).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('dialog')).toBeNull();
    await waitFor(() => expect(trigger).toHaveFocus());
  });

  it('uses the bounded shared dialog and keeps submit/cancel outside the scrollable fields', () => {
    render(<Harness />);
    const dialog = screen.getByRole('dialog', { name: i18n.t('memberList.addMemberTitle') });
    openManual();
    const email = screen.getByLabelText(/Email/);
    const fields = email.closest('.overflow-y-auto');
    const submit = screen.getByRole('button', { name: i18n.t('memberList.addButton') });
    const cancel = screen.getByRole('button', { name: i18n.t('memberList.cancelButton') });
    expect(dialog).toHaveClass('livo-dialog-content');
    expect(dialog).toHaveStyle({ overflow: 'hidden' });
    expect(fields).toHaveClass('min-h-0', 'overscroll-contain');
    expect(fields).not.toContainElement(submit);
    expect(fields).not.toContainElement(cancel);
    expect(submit.closest('.livo-safe-footer')).toContainElement(cancel);
    expect(document.activeElement).toBe(dialog);
    expect(email).not.toHaveFocus();
    expect(screen.getByRole('button', { name: 'Close' })).toHaveClass('h-11', 'w-11');
  });

  it('preserves field validation, role choices and the original submit handler', () => {
    const submit = vi.fn((event: FormEvent) => event.preventDefault());
    render(<Harness onSubmit={submit} />);
    openManual();
    const email = screen.getByLabelText(/Email/);
    const name = screen.getByLabelText(new RegExp(i18n.t('memberList.nameLabel')));
    const password = screen.getByLabelText(i18n.t('memberList.passwordLabel'));
    const role = screen.getByRole('combobox', { name: i18n.t('memberList.roleLabel') });
    expect(email).toBeRequired(); expect(name).toBeRequired();
    expect(password).toHaveAttribute('minlength', '8');
    expect(password).toHaveAttribute('autocomplete', 'new-password');
    expect(screen.getAllByRole('option')).toHaveLength(4);
    fireEvent.change(email, { target: { value: 'member@example.com' } });
    fireEvent.change(name, { target: { value: 'Example member' } });
    fireEvent.change(password, { target: { value: 'example-password' } });
    fireEvent.change(role, { target: { value: 'qa_admin' } });
    fireEvent.focus(within(screen.getByRole('tabpanel', { name: i18n.t('memberInvite.manualTab') })).getByLabelText(i18n.t('memberList.jobTitleLabel')));
    fireEvent.click(screen.getByRole('button', { name: 'QA lead' }));
    expect(within(screen.getByRole('tabpanel', { name: i18n.t('memberInvite.manualTab') })).getByLabelText(i18n.t('memberList.jobTitleLabel'))).toHaveValue('QA lead');
    expect(role).toHaveValue('qa_admin');
    fireEvent.click(screen.getByRole('button', { name: i18n.t('memberList.addButton') }));
    expect(submit).toHaveBeenCalledTimes(1);
  });

  it('keeps restricted role choices and loading state, and supports accessible Escape dismissal', () => {
    const close = vi.fn();
    render(<Harness canEditJobTitle={false} loading onClose={close} />);
    openManual();
    expect(screen.queryByLabelText(i18n.t('memberList.jobTitleLabel'))).toBeNull();
    expect(screen.getAllByRole('option')).toHaveLength(1);
    expect(screen.getByRole('button', { name: i18n.t('memberList.processingButton') })).toBeDisabled();
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    expect(close).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});
