import { useState, useEffect } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { toast } from 'sonner';
import { useTranslation } from 'react-i18next';

const IS_LOCAL = import.meta.env.VITE_LOCAL_MODE === 'true';
// Paid self-host (customer) builds set VITE_LOCAL_MODE=true AND
// VITE_ENFORCE_LICENSE=true. In that case we must NOT show the demo
// test-account hints (yaqi/zhihao/…) — those are dev/local-only.
const IS_ENFORCED = import.meta.env.VITE_ENFORCE_LICENSE === 'true';
// Public demo deployment (livo-tw.com): offer one-click login with the shared
// demo account. Safe because the demo backend runs DEMO_MODE (destructive/admin
// actions blocked, hourly reset). Off for real self-host builds.
const IS_PUBLIC_DEMO = import.meta.env.VITE_PUBLIC_DEMO === 'true';
const DEMO_EMAIL = 'jianhong@livo.test';
const DEMO_PASSWORD = 'test1234';
const DEMO_PLAN_KEY = 'livo_demo_plan';

const Auth = () => {
  const { t } = useTranslation();
  const [loading, setLoading] = useState(false);

  // Capture ?plan=pro parameter on auth page and persist to sessionStorage
  // so LicenseProvider can read it after login redirect
  useEffect(() => {
    try {
      const params = new URLSearchParams(window.location.search);
      const plan = params.get('plan');
      if (plan) {
        const tier = plan.toLowerCase() === 'pro' ? 'professional'
                   : plan.toLowerCase() === 'std' ? 'standard'
                   : null;
        if (tier) {
          sessionStorage.setItem(DEMO_PLAN_KEY, tier);
        } else {
          // Unknown plan value — clear any previous demo plan
          sessionStorage.removeItem(DEMO_PLAN_KEY);
        }
        // Clean URL without losing other params
        params.delete('plan');
        const cleanUrl = params.toString()
          ? `${window.location.pathname}?${params.toString()}`
          : window.location.pathname;
        window.history.replaceState({}, '', cleanUrl);
      } else {
        // No ?plan param — clear any previous demo plan
        // so "免費試用 基礎版" doesn't inherit a previous pro session
        sessionStorage.removeItem(DEMO_PLAN_KEY);
      }
    } catch { /* ignore sessionStorage errors */ }
  }, []);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');

  // Email + Password login
  const handleEmailLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    return doLogin(email, password);
  };

  const doLogin = async (loginEmail: string, loginPassword: string) => {
    if (!loginEmail || !loginPassword) {
      toast.error(t('auth.inputEmailPassword'));
      return;
    }
    setLoading(true);
    const { error } = await supabase.auth.signInWithPassword({ email: loginEmail, password: loginPassword });
    if (error) {
      const msg = error.message.toLowerCase();
      const friendlyMsg =
        msg.includes('invalid login credentials') || msg.includes('invalid email or password')
          ? t('auth.invalidCredentials')
          : msg.includes('email not confirmed')
          ? t('auth.confirmEmail')
          : msg.includes('too many requests') || msg.includes('rate limit')
          ? t('auth.rateLimit')
          : msg.includes('user not found')
          ? t('auth.userNotFound')
          : t('auth.loginFailed');
      toast.error(friendlyMsg);
    }
    setLoading(false);
  };


  return (
    <div className="min-h-screen flex items-center justify-center bg-background">
      <div className="w-full max-w-sm bg-card rounded-xl shadow-lg border border-border p-8">
        <div className="flex justify-center mb-1">
          <img src={`${import.meta.env.BASE_URL}livo-logo.png`} alt="LIVO" className="h-24 w-auto" />
        </div>
        <p className="text-sm text-muted-foreground text-center mb-6">
          {IS_LOCAL ? t('auth.localModeMessage') : t('auth.loginSystem')}
        </p>

        {/* Email / Password Form */}
        <form onSubmit={handleEmailLogin} className="space-y-3 mb-4">
          <div className="space-y-1">
            <label htmlFor="auth-email" className="text-xs font-medium text-muted-foreground">{t('auth.emailLabel')}</label>
            <input
              id="auth-email"
              type="email"
              placeholder="name@company.com"
              value={email}
              onChange={e => setEmail(e.target.value)}
              className="w-full px-3 py-2.5 rounded-md text-sm border border-border bg-background text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary/40"
              autoComplete="email"
            />
          </div>
          <div className="space-y-1">
            <label htmlFor="auth-password" className="text-xs font-medium text-muted-foreground">{t('auth.passwordLabel')}</label>
            <input
              id="auth-password"
              type="password"
              placeholder="••••••••"
              value={password}
              onChange={e => setPassword(e.target.value)}
              className="w-full px-3 py-2.5 rounded-md text-sm border border-border bg-background text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary/40"
              autoComplete="current-password"
            />
          </div>
          <button
            type="submit"
            disabled={loading}
            aria-busy={loading}
            className="w-full py-2.5 rounded-md text-sm font-medium bg-primary text-primary-foreground hover:bg-primary/90 transition-colors disabled:opacity-50 flex items-center justify-center gap-2"
          >
            {loading && (
              <svg className="animate-spin w-4 h-4 flex-shrink-0" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
              </svg>
            )}
            {loading ? t('common.processing') : t('auth.loginButton')}
          </button>
        </form>


        {IS_LOCAL && !IS_ENFORCED && (
          <div className="mt-4 p-3 rounded-md bg-muted/50 border border-border">
            <p className="text-xs text-muted-foreground font-medium mb-2">{t('auth.testAccountsLabel')}</p>
            <div className="space-y-1 text-xs text-muted-foreground">
              <div><span className="font-mono">jianhong@livo.test</span> — {t('auth.testAccountSuperAdmin')}</div>
              <div><span className="font-mono">yaqi@livo.test</span> — {t('auth.testAccountAdmin1')}</div>
              <div><span className="font-mono">jiarong@livo.test</span> — {t('auth.testAccountAdmin2')}</div>
              <div><span className="font-mono">zhihao@livo.test</span> — {t('auth.testAccountMember')}</div>
            </div>
          </div>
        )}

        {IS_PUBLIC_DEMO && (
          <div className="mt-4">
            <div className="flex items-center gap-3 mb-3">
              <span className="h-px flex-1 bg-border" />
              <span className="text-[11px] text-muted-foreground">{t('auth.orTryDemo')}</span>
              <span className="h-px flex-1 bg-border" />
            </div>
            <button
              type="button"
              disabled={loading}
              onClick={() => doLogin(DEMO_EMAIL, DEMO_PASSWORD)}
              className="w-full py-2.5 rounded-md text-sm font-medium border border-primary text-primary hover:bg-primary/5 transition-colors disabled:opacity-50"
            >
              {t('auth.oneClickDemo')}
            </button>
            <p className="mt-2 text-center text-[11px] text-muted-foreground">{t('auth.demoRealtimeHint')}</p>
          </div>
        )}

        {!IS_LOCAL && !IS_PUBLIC_DEMO && (
          <p className="mt-4 text-center text-xs text-muted-foreground">
            {t('auth.memberOnlyMessage')}
          </p>
        )}

        {/* Back to website link — cloud only */}
        {!IS_LOCAL && (
          <div className="mt-5 pt-4 border-t border-border flex flex-col items-center gap-2">
            <a
              href="/"
              className="text-xs text-primary hover:text-primary/80 transition-colors"
            >
              {t('auth.backToWebsite')}
            </a>
            {/* Demo shortcuts only exist on LIVO's public demo, not on a self-hosted cloud deploy */}
            {IS_PUBLIC_DEMO && (
              <div className="flex gap-3">
                <a
                  href="/demo/auth"
                  className="text-[11px] text-muted-foreground hover:text-foreground transition-colors"
                >
                  {t('auth.tryBasicPlan')}
                </a>
                <span className="text-[11px] text-muted-foreground/40">|</span>
                <a
                  href="/demo/?demo=pro"
                  className="text-[11px] text-muted-foreground hover:text-foreground transition-colors"
                >
                  {t('auth.tryProPlan')}
                </a>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
};

export default Auth;
