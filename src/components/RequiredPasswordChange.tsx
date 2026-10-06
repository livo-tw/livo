import { useTranslation } from 'react-i18next';
import { supabase } from '@/integrations/supabase/client';
import ChangePasswordForm from '@/components/ChangePasswordForm';

/**
 * Shown instead of the app when an admin set this login's password (self-host).
 * The member enters that password and a new one; the change clears the flag and
 * the app opens. Signing out is the only other way out.
 */
const RequiredPasswordChange = () => {
  const { t } = useTranslation();
  return (
    <div className="min-h-screen flex items-center justify-center bg-background px-4">
      <div className="w-full max-w-sm space-y-4 rounded-lg border border-border bg-card p-6 shadow-sm">
        <div className="space-y-1">
          <h1 className="text-lg font-semibold text-foreground">{t('auth.passwordChangeRequiredTitle')}</h1>
          <p className="text-sm text-muted-foreground">{t('auth.passwordChangeRequiredBody')}</p>
        </div>
        {/* The password change updates the session; a refresh also renews the token's claims. */}
        <ChangePasswordForm onChanged={() => void supabase.auth.refreshSession()} />
        <button type="button" onClick={() => void supabase.auth.signOut()}
          className="text-sm text-muted-foreground underline-offset-2 hover:underline">
          {t('auth.logout')}
        </button>
      </div>
    </div>
  );
};

export default RequiredPasswordChange;
