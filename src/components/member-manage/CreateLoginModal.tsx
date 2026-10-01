import { X } from 'lucide-react';
import { useTranslation } from 'react-i18next';

// 「啟用帳號」: an admin types the email of a member that only has a name
// (imported from Jira). The member keeps its id, so its tasks stay assigned.

interface CreateLoginModalProps {
  target: { id: string; name: string } | null;
  email: string;
  setEmail: (email: string) => void;
  error: string | null;
  onClose: () => void;
  onSubmit: (e: React.FormEvent) => void;
  loading: boolean;
}

const CreateLoginModal = ({ target, email, setEmail, error, onClose, onSubmit, loading }: CreateLoginModalProps) => {
  const { t } = useTranslation();
  if (!target) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" onClick={onClose}>
      <div className="bg-card rounded-xl shadow-xl border border-border p-5 md:p-6 w-full max-w-md" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-base font-bold text-foreground">{t('member.createLoginTitle', { name: target.name })}</h2>
          <button onClick={onClose} className="text-muted-foreground hover:text-foreground" aria-label={t('common.close')}><X size={18} /></button>
        </div>
        <p className="text-xs text-muted-foreground mb-3">{t('member.createLoginHint')}</p>
        <form onSubmit={onSubmit} className="space-y-3">
          <div>
            <label htmlFor="create-login-email" className="text-sm font-medium text-foreground block mb-1">
              Email <span className="text-destructive">*</span>
            </label>
            <input
              id="create-login-email"
              type="email"
              value={email}
              onChange={e => setEmail(e.target.value)}
              className="w-full border border-input rounded-md px-3 py-2 text-sm bg-background text-foreground outline-none focus:ring-2 focus:ring-ring"
              placeholder="member@example.com"
              autoComplete="off"
              required
            />
          </div>
          {error && <p className="text-xs text-destructive" role="alert">{error}</p>}
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
              {loading ? t('memberList.processingButton') : t('member.createLoginButton')}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};

export default CreateLoginModal;
