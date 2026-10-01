import { toast } from "sonner";
import { Toaster as Sonner } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";
import { useState, useEffect, lazy, Suspense } from "react";
import type { Session } from '@supabase/supabase-js';
import { supabase } from "@/integrations/supabase/client";
import { useTranslation } from 'react-i18next';
import i18n from '@/i18n';
import { IS_DEMO_PRO } from "@/lib/demoMode";
import DemoModeBanner, { DEMO_BANNER_HEIGHT } from "@/components/DemoModeBanner";

const Index = lazy(() => import("./pages/Index"));
const Auth = lazy(() => import("./pages/Auth"));
const Signup = lazy(() => import("./pages/Signup"));
const SetPassword = lazy(() => import("./pages/SetPassword"));
const NotFound = lazy(() => import("./pages/NotFound"));

const PageFallback = () => {
  const { t } = useTranslation();
  return (
    <div className="min-h-screen flex items-center justify-center bg-background">
      <span className="text-muted-foreground">{t('common.loading')}</span>
    </div>
  );
};

// ── Offline Banner ────────────────────────────────────────────────────────────
const OfflineBanner = ({ visible }: { visible: boolean }) => {
  const { t } = useTranslation();
  if (!visible) return null;
  return (
    <div
      role="alert"
      aria-live="assertive"
      className="fixed top-0 left-0 right-0 z-[9999] bg-destructive text-destructive-foreground text-sm font-medium px-4 py-2.5 text-center shadow-lg"
    >
      {t('network.offlineBanner')}
    </div>
  );
};

const IS_LOCAL = import.meta.env.VITE_LOCAL_MODE === 'true';

const ProtectedRoute = ({ session, children }: { session: Session | null; children: React.ReactNode }) => {
  if (!session) return <Navigate to="/auth" replace />;
  return <>{children}</>;
};

// /signup must render whenever an ?invite= token is present — a leftover
// session (e.g. the persisted public-demo login) would otherwise swallow the
// invite link with an instant redirect and the lead never sees the form.
// Signup itself signs the old session out before creating the workspace.
const SignupRoute = ({ session }: { session: Session | null }) => {
  const hasInvite = new URLSearchParams(window.location.search).has('invite');
  if (session && !hasInvite) return <Navigate to="/" replace />;
  return <Signup />;
};

const App = () => {
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(true);
  const [isOnline, setIsOnline] = useState(navigator.onLine);

  useEffect(() => {
    const handleOnline = () => setIsOnline(true);
    const handleOffline = () => setIsOnline(false);
    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);
    return () => {
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
    };
  }, []);

  useEffect(() => {
    let loginLogged = false;

    const validateAndLogLogin = async (event: string, session: Session | null) => {
      const userId = session?.user?.id;
      if (!userId) return;

      if (event === 'SIGNED_IN') {
        const userEmail = session?.user?.email;

        // In local mode, skip cloud-specific validation
        if (IS_LOCAL) {
          // Just log the login
          const { data: member } = await supabase
            .from('members')
            .select('id')
            .eq('email', userEmail || '')
            .maybeSingle();

          if (member && !loginLogged) {
            loginLogged = true;
            await supabase.from('activity_logs').insert({
              user_id: member.id,
              action: 'login',
              target_type: 'system',
              detail: i18n.t('activity.login'),
            });
          }
          return;
        }

        // Cloud mode: full validation
        const { data: member } = await supabase
          .from('members')
          .select('id, is_active')
          .eq('email', userEmail || '')
          .maybeSingle();

        if (!member || !member.is_active) {
          const { data: superAdmins } = await supabase
            .from('members')
            .select('id')
            .eq('role', 'super_admin');

          if (superAdmins && superAdmins.length > 0) {
            const notifications = superAdmins.map((admin: { id: string }) => ({
              recipient_id: admin.id,
              sender_id: admin.id,
              task_id: '',
              type: 'unauthorized_login',
              content: i18n.t('auth.unauthorizedLoginAttempt', { email: userEmail }),
            }));
            await supabase.from('notifications').insert(notifications);
          }

          await supabase.auth.signOut();
          setSession(null);
          toast.error(i18n.t('auth.notMemberError'));
          return;
        }

        await supabase.from('members').update({ auth_id: userId }).eq('id', member.id);

        const twoMinAgo = new Date(Date.now() - 2 * 60 * 1000).toISOString();
        const { data: recentLogin } = await supabase
          .from('activity_logs')
          .select('id')
          .eq('user_id', member.id)
          .eq('action', 'login')
          .gte('created_at', twoMinAgo)
          .limit(1);

        if (!loginLogged && (!recentLogin || recentLogin.length === 0)) {
          loginLogged = true;
          await supabase.from('activity_logs').insert({
            user_id: member.id,
            action: 'login',
            target_type: 'system',
            detail: i18n.t('activity.login'),
          });
        }
      } else if (event === 'SIGNED_OUT') {
        if (!IS_LOCAL) {
          const { data: member } = await supabase.from('members').select('id').eq('auth_id', userId).maybeSingle();
          const memberId = member?.id || userId;
          await supabase.from('activity_logs').insert({
            user_id: memberId,
            action: 'logout',
            target_type: 'system',
            detail: i18n.t('activity.logout'),
          });
        }
      }
    };

    const { data: { subscription } } = supabase.auth.onAuthStateChange((event: string, session: Session | null) => {
      setSession(session);
      setLoading(false);
      if (event === 'SIGNED_IN' || event === 'SIGNED_OUT') {
        validateAndLogLogin(event, session);
      }
    });

    supabase.auth.getSession().then(({ data: { session } }) => {
      setSession(session);
      setLoading(false);
    }).catch(() => {
      setLoading(false);
    });

    return () => subscription.unsubscribe();
  }, []);

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <span className="text-muted-foreground">{i18n.t('common.loading')}</span>
      </div>
    );
  }

  return (
    <TooltipProvider>
      {IS_DEMO_PRO && (
        <>
          <style>{`.livo-demo-on{padding-top:${DEMO_BANNER_HEIGHT}px}.livo-demo-on .h-screen{height:calc(100vh - ${DEMO_BANNER_HEIGHT}px)}`}</style>
          <DemoModeBanner />
        </>
      )}
      <OfflineBanner visible={!isOnline} />
      <Sonner />
      <div className={IS_DEMO_PRO ? 'livo-demo-on' : undefined}>
      <BrowserRouter basename={import.meta.env.BASE_URL.replace(/\/$/, '')}>
        <Suspense fallback={<PageFallback />}>
          <Routes>
            <Route path="/auth" element={session ? <Navigate to="/" replace /> : <Auth />} />
            {/* Cloud-beta invite signup (see SignupRoute above) */}
            <Route path="/signup" element={<SignupRoute session={session} />} />
            {/* Invitation link for a login an admin created (Jira import / 啟用帳號);
                renders with or without a session — the link decides whose password it sets. */}
            <Route path="/set-password" element={<SetPassword />} />
            <Route path="/" element={
              <ProtectedRoute session={session}>
                <Index />
              </ProtectedRoute>
            } />
            <Route path="*" element={<NotFound />} />
          </Routes>
        </Suspense>
      </BrowserRouter>
      </div>
    </TooltipProvider>
  );
};

export default App;