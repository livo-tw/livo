import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import {
  checkSetPasswordLink,
  readSetPasswordLink,
  setPasswordFromLink,
  type SetPasswordError,
} from '@/lib/setPassword';

// /demo/set-password — the page behind the invitation email sent when an
// admin creates someone's login (Jira import or 「啟用帳號」). Public: the
// link itself is the credential. After the password is set the person is
// signed in and lands on the app.

const inputCls =
  'w-full px-3 py-2.5 rounded-md text-sm border border-border bg-background text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary/40';

const SetPassword = () => {
  const { t } = useTranslation();
  const link = useMemo(() => readSetPasswordLink(window.location.search), []);
  const [checking, setChecking] = useState(true);
  const [linkError, setLinkError] = useState<SetPasswordError | null>(link ? null : { code: 'invalid_token' });
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [password2, setPassword2] = useState('');
  const [loading, setLoading] = useState(false);
  const verified = useRef({ verified: false });

  useEffect(() => {
    let cancelled = false;
    if (!link) {
      setChecking(false);
      return;
    }
    checkSetPasswordLink(link).then((res) => {
      if (cancelled) return;
      if (res.error) setLinkError(res.error);
      if (res.email) setEmail(res.email);
      setChecking(false);
    });
    return () => {
      cancelled = true;
    };
  }, [link]);

  const errorText = (err: SetPasswordError): string => {
    switch (err.code) {
      case 'invalid_token': return t('setPassword.invalidLink');
      case 'password_too_short': return t('setPassword.tooShort');
      case 'demo_blocked': return t('setPassword.demoBlocked');
      default: return t('setPassword.failed') + (err.message ? ` ${err.message}` : '');
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!link) return;
    if (password.length < 8) { toast.error(t('setPassword.tooShort')); return; }
    if (password !== password2) { toast.error(t('setPassword.mismatch')); return; }
    setLoading(true);
    const err = await setPasswordFromLink(link, password, verified.current);
    if (err) {
      setLoading(false);
      if (err.code === 'invalid_token' || err.code === 'demo_blocked') setLinkError(err);
      else toast.error(errorText(err));
      return;
    }
    toast.success(t('setPassword.done'));
    // Full load: the fresh session is picked up and the query string dropped.
    window.location.assign(import.meta.env.BASE_URL);
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-background px-4">
      <div className="w-full max-w-sm bg-card rounded-xl shadow-lg border border-border p-8">
        <div className="flex justify-center mb-1">
          <img src={`${import.meta.env.BASE_URL}livo-logo.png`} alt="LIVO" className="h-24 w-auto" />
        </div>

        {checking ? (
          <p className="text-sm text-muted-foreground text-center py-6">{t('common.loading')}</p>
        ) : linkError ? (
          <div className="text-center">
            <p className="text-sm text-foreground font-medium mb-2">{t('setPassword.invalidTitle')}</p>
            <p className="text-xs text-muted-foreground mb-5 leading-relaxed">{errorText(linkError)}</p>
            <a href={`${import.meta.env.BASE_URL}auth`} className="text-xs text-primary hover:text-primary/80 transition-colors">
              {t('setPassword.backToLogin')}
            </a>
          </div>
        ) : (
          <>
            <p className="text-sm font-medium text-foreground text-center">{t('setPassword.title')}</p>
            <p className="text-xs text-muted-foreground text-center mt-1 mb-6 break-all">
              {email ? t('setPassword.forEmail', { email }) : t('setPassword.subtitle')}
            </p>
            <form onSubmit={handleSubmit} className="space-y-3">
              <div className="space-y-1">
                <label htmlFor="sp-pw" className="text-xs font-medium text-muted-foreground">{t('setPassword.passwordLabel')}</label>
                <input
                  id="sp-pw"
                  type="password"
                  placeholder="••••••••"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  className={inputCls}
                  autoComplete="new-password"
                  minLength={8}
                  required
                />
              </div>
              <div className="space-y-1">
                <label htmlFor="sp-pw2" className="text-xs font-medium text-muted-foreground">{t('setPassword.confirmLabel')}</label>
                <input
                  id="sp-pw2"
                  type="password"
                  placeholder="••••••••"
                  value={password2}
                  onChange={(e) => setPassword2(e.target.value)}
                  className={inputCls}
                  autoComplete="new-password"
                  minLength={8}
                  required
                />
              </div>
              <button
                type="submit"
                disabled={loading}
                aria-busy={loading}
                className="w-full py-2.5 rounded-md text-sm font-medium bg-primary text-primary-foreground hover:bg-primary/90 transition-colors disabled:opacity-50"
              >
                {loading ? t('setPassword.submitting') : t('setPassword.submit')}
              </button>
            </form>
          </>
        )}
      </div>
    </div>
  );
};

export default SetPassword;
