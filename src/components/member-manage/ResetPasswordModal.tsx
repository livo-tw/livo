import { X } from 'lucide-react';
import { useTranslation } from 'react-i18next';

type ResetPasswordForm = { password: string; confirm: string };

interface ResetPasswordModalProps {
  target: { id: string; name: string } | null;
  onClose: () => void;
  form: ResetPasswordForm;
  setForm: (fn: (f: ResetPasswordForm) => ResetPasswordForm) => void;
  onSubmit: (e: React.FormEvent) => void;
  loading: boolean;
}

const ResetPasswordModal = ({
  target, onClose, form, setForm, onSubmit, loading,
}: ResetPasswordModalProps) => {
  const { t } = useTranslation();
  if (!target) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" onClick={onClose}>
      <div className="bg-card rounded-xl shadow-xl border border-border p-5 md:p-6 w-full max-w-md" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-base font-bold text-foreground">{t('member.resetPasswordTitle', { name: target.name })}</h2>
          <button onClick={onClose} className="text-muted-foreground hover:text-foreground"><X size={18} /></button>
        </div>
        <p className="text-xs text-muted-foreground mb-3">{t('member.resetPasswordHint')}</p>
        <form onSubmit={onSubmit} className="space-y-3">
          <div>
            <label className="text-sm font-medium text-foreground block mb-1">{t('member.newPasswordLabel')} <span className="text-destructive">*</span></label>
            <input
              type="password"
              value={form.password}
              onChange={e => setForm(f => ({ ...f, password: e.target.value }))}
              className="w-full border border-input rounded-md px-3 py-2 text-sm bg-background text-foreground outline-none focus:ring-2 focus:ring-ring"
              placeholder={t('member.newPasswordPlaceholder')}
              autoComplete="new-password"
              minLength={8}
              required
            />
          </div>
          <div>
            <label className="text-sm font-medium text-foreground block mb-1">{t('member.confirmPasswordLabel')} <span className="text-destructive">*</span></label>
            <input
              type="password"
              value={form.confirm}
              onChange={e => setForm(f => ({ ...f, confirm: e.target.value }))}
              className="w-full border border-input rounded-md px-3 py-2 text-sm bg-background text-foreground outline-none focus:ring-2 focus:ring-ring"
              autoComplete="new-password"
              minLength={8}
              required
            />
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
              {loading ? t('memberList.processingButton') : t('member.resetPasswordButton')}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};

export default ResetPasswordModal;
