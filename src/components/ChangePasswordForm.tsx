import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { changeOwnPassword } from '@/lib/changePassword';

const inputClass =
  'w-full rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-primary';

const ChangePasswordForm = () => {
  const { t } = useTranslation();
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    if (!currentPassword) {
      setError(t('settings.passwordCurrentRequired'));
      return;
    }
    if (newPassword.length < 8) {
      setError(t('settings.passwordTooShort'));
      return;
    }
    if (newPassword !== confirmPassword) {
      setError(t('settings.passwordMismatch'));
      return;
    }
    setLoading(true);
    const { error: err } = await changeOwnPassword(currentPassword, newPassword);
    setLoading(false);
    if (err) {
      setError(err.message);
      return;
    }
    setCurrentPassword('');
    setNewPassword('');
    setConfirmPassword('');
    // On the Cloudflare backend the returned fresh session already replaced
    // the stored one (all other devices are signed out).
    toast.success(t('settings.passwordChanged'));
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-3 max-w-xs">
      <div>
        <label className="text-sm font-medium text-foreground block mb-1">
          {t('settings.passwordCurrent')}
        </label>
        <input
          type="password"
          value={currentPassword}
          onChange={e => setCurrentPassword(e.target.value)}
          className={inputClass}
          autoComplete="current-password"
          required
        />
      </div>
      <div>
        <label className="text-sm font-medium text-foreground block mb-1">
          {t('settings.passwordNew')}
        </label>
        <input
          type="password"
          value={newPassword}
          onChange={e => setNewPassword(e.target.value)}
          className={inputClass}
          autoComplete="new-password"
          minLength={8}
          required
        />
        <p className="text-xs text-muted-foreground mt-1">{t('settings.passwordMinHint')}</p>
      </div>
      <div>
        <label className="text-sm font-medium text-foreground block mb-1">
          {t('settings.passwordConfirm')}
        </label>
        <input
          type="password"
          value={confirmPassword}
          onChange={e => setConfirmPassword(e.target.value)}
          className={inputClass}
          autoComplete="new-password"
          minLength={8}
          required
        />
      </div>
      {error && <p className="text-xs text-destructive">{error}</p>}
      <button
        type="submit"
        disabled={loading}
        className="px-4 py-2 rounded-md text-sm font-medium bg-primary text-primary-foreground hover:bg-primary/90 transition-colors disabled:opacity-50"
      >
        {loading ? t('settings.passwordChanging') : t('settings.passwordChangeButton')}
      </button>
    </form>
  );
};

export default ChangePasswordForm;
