import { SearchableSelect } from '@/components/ui/searchable-select';
import { X } from 'lucide-react';
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
  if (!show) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" onClick={onClose}>
      <div className="bg-card rounded-xl shadow-xl border border-border p-5 md:p-6 w-full max-w-md" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-base font-bold text-foreground">{t('memberList.addMemberTitle')}</h2>
          <button onClick={onClose} className="text-muted-foreground hover:text-foreground"><X size={18} /></button>
        </div>
        <form onSubmit={onSubmit} className="space-y-3">
          <div>
            <label className="text-sm font-medium text-foreground block mb-1">Email <span className="text-destructive">*</span></label>
            <input
              type="email"
              value={form.email}
              onChange={e => setForm(f => ({ ...f, email: e.target.value }))}
              className="w-full border border-input rounded-md px-3 py-2 text-sm bg-background text-foreground outline-none focus:ring-2 focus:ring-ring"
              placeholder="member@example.com"
              required
            />
          </div>
          <div>
            <label className="text-sm font-medium text-foreground block mb-1">{t('memberList.nameLabel')} <span className="text-destructive">*</span></label>
            <input
              type="text"
              value={form.name}
              onChange={e => setForm(f => ({ ...f, name: e.target.value }))}
              className="w-full border border-input rounded-md px-3 py-2 text-sm bg-background text-foreground outline-none focus:ring-2 focus:ring-ring"
              placeholder={t('memberList.memberNamePlaceholder')}
              required
            />
          </div>
          <div>
            <label className="text-sm font-medium text-foreground block mb-1">{t('memberList.passwordLabel')}</label>
            <input
              type="password"
              value={form.password}
              onChange={e => setForm(f => ({ ...f, password: e.target.value }))}
              className="w-full border border-input rounded-md px-3 py-2 text-sm bg-background text-foreground outline-none focus:ring-2 focus:ring-ring"
              placeholder={t('memberList.passwordPlaceholder')}
              autoComplete="new-password"
              minLength={8}
            />
            <p className="text-xs text-muted-foreground mt-1">{t('memberList.passwordHint')}</p>
          </div>
          {canEditJobTitle ? <div>
            <label className="text-sm font-medium text-foreground block mb-1">{t('memberList.jobTitleLabel')}</label>
            <div className="relative" ref={jobTitleRef}>
              <input
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
                      className={`w-full text-left px-3 py-2 text-sm hover:bg-accent transition-colors ${form.jobTitle === title ? 'bg-accent font-medium' : 'text-foreground'}`}
                    >
                      {title}
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div> : <p className="text-xs text-muted-foreground">{t('memberJobTitle.superAdminOnly')}</p>}
          <div>
            <label className="text-sm font-medium text-foreground block mb-1">{t('memberList.roleLabel')}</label>
            <SearchableSelect
              value={form.role}
              onChange={e => setForm(f => ({ ...f, role: e.target.value as MemberRoleSelection }))}
              className="w-full border border-input rounded-md px-3 py-2 text-sm bg-background text-foreground outline-none focus:ring-2 focus:ring-ring"
            >
              {ROLES.filter(role => canEditJobTitle || role === 'member').map(r => <option key={r} value={r}>{selectionRoleLabel(r)}</option>)}
            </SearchableSelect>
          </div>
          <div className="flex gap-2 pt-2">
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
          </div>
        </form>
      </div>
    </div>
  );
};

export default AddMemberModal;
