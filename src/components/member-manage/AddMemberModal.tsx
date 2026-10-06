import { SearchableSelect } from '@/components/ui/searchable-select';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { useId, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { MEMBER_ROLE_OPTIONS, selectionRoleLabel, type MemberRoleSelection } from '@/lib/memberRoleSelection';

const ROLES = MEMBER_ROLE_OPTIONS;

type AddMemberForm = { email: string; name: string; role: MemberRoleSelection; jobTitle: string; password: string };

interface AddMemberModalProps {
  show: boolean;
  onClose: () => void;
  form: AddMemberForm;
  setForm: (fn: (f: AddMemberForm) => AddMemberForm) => void;
  jobTitleRef: React.RefObject<HTMLDivElement>;
  jobTitleOpen: boolean;
  setJobTitleOpen: (v: boolean) => void;
  filteredJobTitles: string[];
  onSubmit: (e: React.FormEvent) => void;
  loading: boolean;
  canEditJobTitle: boolean;
}

const AddMemberModal = ({
  show, onClose, form, setForm, jobTitleRef, jobTitleOpen, setJobTitleOpen,
  filteredJobTitles, onSubmit, loading, canEditJobTitle,
}: AddMemberModalProps) => {
  const { t } = useTranslation();
  const formId = useId();
  const contentRef = useRef<HTMLDivElement>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);
  if (!show) return null;

  return (
    <Dialog open={show} onOpenChange={open => { if (!open) onClose(); }}>
      <DialogContent
        ref={contentRef}
        aria-describedby={undefined}
        className="flex min-h-0 max-w-md flex-col"
        style={{ overflow: 'hidden' }}
        onOpenAutoFocus={event => {
          previousFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
          event.preventDefault();
          contentRef.current?.focus();
        }}
        onCloseAutoFocus={event => {
          event.preventDefault();
          if (previousFocusRef.current?.isConnected) previousFocusRef.current.focus();
        }}
      >
        <DialogHeader className="min-h-11 justify-center">
          <DialogTitle className="text-base font-bold">{t('memberList.addMemberTitle')}</DialogTitle>
        </DialogHeader>
        <form onSubmit={onSubmit} className="flex min-h-0 flex-1 flex-col">
          <div className="min-h-0 flex-1 space-y-3 overflow-y-auto overscroll-contain pr-1 [scroll-padding-block:1rem]">
          <div>
            <label htmlFor={`${formId}-email`} className="text-sm font-medium text-foreground block mb-1">Email <span className="text-destructive">*</span></label>
            <input
              id={`${formId}-email`}
              type="email"
              value={form.email}
              onChange={e => setForm(f => ({ ...f, email: e.target.value }))}
              className="w-full border border-input rounded-md px-3 py-2 text-sm bg-background text-foreground outline-none focus:ring-2 focus:ring-ring"
              placeholder="member@example.com"
              required
            />
          </div>
          <div>
            <label htmlFor={`${formId}-name`} className="text-sm font-medium text-foreground block mb-1">{t('memberList.nameLabel')} <span className="text-destructive">*</span></label>
            <input
              id={`${formId}-name`}
              type="text"
              value={form.name}
              onChange={e => setForm(f => ({ ...f, name: e.target.value }))}
              className="w-full border border-input rounded-md px-3 py-2 text-sm bg-background text-foreground outline-none focus:ring-2 focus:ring-ring"
              placeholder={t('memberList.memberNamePlaceholder')}
              required
            />
          </div>
          <div>
            <label htmlFor={`${formId}-password`} className="text-sm font-medium text-foreground block mb-1">{t('memberList.passwordLabel')}</label>
            <input
              id={`${formId}-password`}
              aria-describedby={`${formId}-password-hint`}
              type="password"
              value={form.password}
              onChange={e => setForm(f => ({ ...f, password: e.target.value }))}
              className="w-full border border-input rounded-md px-3 py-2 text-sm bg-background text-foreground outline-none focus:ring-2 focus:ring-ring"
              placeholder={t('memberList.passwordPlaceholder')}
              autoComplete="new-password"
              minLength={8}
            />
            <p id={`${formId}-password-hint`} className="text-xs text-muted-foreground mt-1">{t('memberList.passwordHint')}</p>
          </div>
          {canEditJobTitle ? <div>
            <label htmlFor={`${formId}-job-title`} className="text-sm font-medium text-foreground block mb-1">{t('memberList.jobTitleLabel')}</label>
            <div className="relative" ref={jobTitleRef}>
              <input
                id={`${formId}-job-title`}
                type="text"
                value={form.jobTitle}
                maxLength={200}
                onChange={e => { setForm(f => ({ ...f, jobTitle: e.target.value })); setJobTitleOpen(true); }}
                onFocus={() => setJobTitleOpen(true)}
                className="w-full border border-input rounded-md px-3 py-2 text-sm bg-background text-foreground outline-none focus:ring-2 focus:ring-ring"
                placeholder={t('memberList.jobTitlePlaceholder')}
                autoComplete="off"
              />
              {jobTitleOpen && filteredJobTitles.length > 0 && (
                <div className="absolute z-10 w-full mt-1 bg-popover border border-border rounded-md shadow-lg max-h-40 overflow-y-auto">
                  {filteredJobTitles.map(title => (
                    <button
                      key={title}
                      type="button"
                      onClick={() => { setForm(f => ({ ...f, jobTitle: title })); setJobTitleOpen(false); }}
                      className={`min-h-11 w-full text-left px-3 py-2 text-sm hover:bg-accent transition-colors ${form.jobTitle === title ? 'bg-accent font-medium' : 'text-foreground'}`}
                    >
                      {title}
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div> : <p className="text-xs text-muted-foreground">{t('memberJobTitle.superAdminOnly')}</p>}
          <div>
            <label htmlFor={`${formId}-role`} className="text-sm font-medium text-foreground block mb-1">{t('memberList.roleLabel')}</label>
            <SearchableSelect
              id={`${formId}-role`}
              value={form.role}
              onChange={e => setForm(f => ({ ...f, role: e.target.value as MemberRoleSelection }))}
              className="w-full border border-input rounded-md px-3 py-2 text-sm bg-background text-foreground outline-none focus:ring-2 focus:ring-ring"
            >
              {ROLES.filter(role => canEditJobTitle || role === 'member').map(r => <option key={r} value={r}>{selectionRoleLabel(r)}</option>)}
            </SearchableSelect>
          </div>
          </div>
          <DialogFooter className="mt-3 flex-row gap-2 border-t border-border pt-3">
            <button
              type="button"
              onClick={onClose}
              className="flex-1 py-2 rounded-md text-sm font-medium border border-border text-foreground hover:bg-accent transition-colors"
            >
              {t('memberList.cancelButton')}
            </button>
            <button
              type="submit"
              disabled={loading}
              className="flex-1 py-2 rounded-md text-sm font-medium bg-primary text-primary-foreground hover:bg-primary/90 transition-colors disabled:opacity-50"
            >
              {loading ? t('memberList.processingButton') : t('memberList.addButton')}
            </button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
};

export default AddMemberModal;
