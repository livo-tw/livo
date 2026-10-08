import { useEffect, useMemo, useRef, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { CheckCircle2 } from 'lucide-react';
import { toast } from 'sonner';
import { supabase } from '@/integrations/supabase/client';
import { selectionRoleLabel } from '@/lib/memberRoleSelection';
import {
  acceptMemberInvitation, joinMemberInvitation, invitationErrorKey, previewMemberConfirmation, previewMemberInvitation,
  readMemberInvitationLink, navigateToInvitationLogin, type InvitationError,
} from '@/lib/memberInvitations';
import {
  validateInviteEmail, validateInviteName, validateInvitePassword,
  type MemberConfirmationPreview, type MemberInvitePreview,
} from '@/lib/memberInvitationsCore';

const inputClass = 'w-full rounded-md border border-input bg-background px-3 py-2.5 text-sm text-foreground outline-none focus:ring-2 focus:ring-ring disabled:opacity-60';
const buttonClass = 'min-h-11 w-full rounded-md px-3 py-2.5 text-sm font-medium outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50';

/** Invitation-authorized onboarding. Email is a login identifier; direct joins send no email. */
const Join = () => {
  const { t, i18n } = useTranslation();
  const location = useLocation();
  const link = useMemo(() => readMemberInvitationLink(location.hash, location.search), [location.hash, location.search]);
  const [checking, setChecking] = useState(true);
  const [details, setDetails] = useState<MemberInvitePreview | MemberConfirmationPreview | null>(null);
  const [linkError, setLinkError] = useState<InvitationError | null>(null);
  const [actionError, setActionError] = useState<InvitationError | null>(null);
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [password2, setPassword2] = useState('');
  const [loading, setLoading] = useState(false);
  const [joined, setJoined] = useState<{ signedIn: boolean } | null>(null);
  const [uncertainJoinEmail, setUncertainJoinEmail] = useState<string | null>(null);
  const recoveryHeading = useRef<HTMLHeadingElement>(null);
  const [hasExistingSession, setHasExistingSession] = useState<boolean | null>(null);
  const [recoveryLoginLoading, setRecoveryLoginLoading] = useState(false);
  const [recoveryLoginError, setRecoveryLoginError] = useState(false);
  const [checkRevision, setCheckRevision] = useState(0);
  const submitting = useRef(false);
  const actionRevision = useRef(0);
  const linkKey = link ? `${link.kind}:${link.token}` : '';
  const activeLinkKey = useRef(linkKey);
  activeLinkKey.current = linkKey;
  const appUrl = import.meta.env.BASE_URL;
  const loginUrl = `${appUrl}auth`;

  useEffect(() => {
    ++actionRevision.current;
    submitting.current = false;
    setLoading(false);
    setJoined(null);
    setUncertainJoinEmail(null);
    setHasExistingSession(null);
    setRecoveryLoginLoading(false);
    setRecoveryLoginError(false);
    setName('');
    setEmail('');
    setPassword('');
    setPassword2('');
    return () => { ++actionRevision.current; };
  }, [linkKey]);

  useEffect(() => {
    let cancelled = false;
    setChecking(true);
    setDetails(null);
    setLinkError(null);
    setActionError(null);
    setPassword('');
    setPassword2('');
    if (!link) {
      setLinkError({ code: 'invalid_token' });
      setChecking(false);
      return;
    }
    const check = link.kind === 'invite' ? previewMemberInvitation(link.token) : previewMemberConfirmation(link.token);
    void check.then(result => {
      if (cancelled) return;
      setDetails(result.data);
      setLinkError(result.error);
      setChecking(false);
    });
    return () => { cancelled = true; };
  }, [link, checkRevision]);


  useEffect(() => {
    if (uncertainJoinEmail !== null) recoveryHeading.current?.focus();
  }, [uncertainJoinEmail, linkError]);

  useEffect(() => {
    if (uncertainJoinEmail === null) return;
    let cancelled = false;
    void supabase.auth.getSession().then(result => {
      if (cancelled) return;
      if (result.error) {
        console.warn('[memberInvitations] Recovery session check failed', { kind: 'session_error' });
        setRecoveryLoginError(true);
      } else setHasExistingSession(!!result.data.session);
    }).catch(error => {
      if (cancelled) return;
      console.warn('[memberInvitations] Recovery session check failed', { kind: error instanceof Error ? error.name : 'unknown' });
      setRecoveryLoginError(true);
    });
    return () => { cancelled = true; };
  }, [uncertainJoinEmail]);

  const handleRecoveryLogin = async (event: React.MouseEvent<HTMLAnchorElement>) => {
    event.preventDefault();
    if (recoveryLoginLoading || (hasExistingSession === null && !recoveryLoginError)) return;
    const revision = actionRevision.current;
    const submittedLinkKey = linkKey;
    const current = () => revision === actionRevision.current && submittedLinkKey === activeLinkKey.current;
    setRecoveryLoginLoading(true);
    setRecoveryLoginError(false);
    try {
      const result = await supabase.auth.getSession();
      if (!current()) return;
      if (result.error) throw new Error('SessionUnavailable');
      if (result.data.session) {
        // A session that appeared since the preview needs explicit switch-account consent.
        if (hasExistingSession !== true) { setHasExistingSession(true); return; }
        const signedOut = await supabase.auth.signOut({ scope: 'local' });
        if (!current()) return;
        if (signedOut.error) throw new Error('SignOutFailed');
      }
      navigateToInvitationLogin();
    } catch (error) {
      if (!current()) return;
      console.warn('[memberInvitations] Recovery login failed', { kind: error instanceof Error ? error.name : 'unknown' });
      setRecoveryLoginError(true);
      toast.error(t('memberInvite.recoveryLoginFailed'));
    } finally {
      if (current()) setRecoveryLoginLoading(false);
    }
  };

  const showError = (error: InvitationError) => {
    setActionError(error);
    toast.error(t(invitationErrorKey(error)));
    if (error.code === 'invalid_token') setLinkError(error);
  };

  const handleAccept = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!link || !details || submitting.current) return;
    if (link.kind === 'invite' && uncertainJoinEmail !== null) return;
    const validName = link.kind === 'invite' ? validateInviteName(name) : null;
    const validEmail = link.kind === 'invite' ? validateInviteEmail(email) : null;
    if (link.kind === 'invite' && (!validName || !validEmail)) { showError({ code: 'invalid_request' }); return; }
    if (!validateInvitePassword(password)) { showError({ code: 'password_invalid' }); return; }
    if (password !== password2) { setActionError({ code: 'password_mismatch' }); toast.error(t('setPassword.mismatch')); return; }
    const revision = actionRevision.current;
    const submittedLinkKey = linkKey;
    submitting.current = true;
    setLoading(true);
    setActionError(null);
    const result = link.kind === 'invite'
      ? await joinMemberInvitation(link.token, validName!, validEmail!, password)
      : await acceptMemberInvitation(link.token, password);
    if (revision !== actionRevision.current || submittedLinkKey !== activeLinkKey.current) return;
    if (result.error) {
      if (['network_failed', 'invalid_response', 'server_error'].includes(result.error.code)) {
        setUncertainJoinEmail(validEmail || ('email' in details ? details.email : ''));
      }
      showError(result.error);
      if (['email_taken', 'registration_pending'].includes(result.error.code)) setLinkError(result.error);
      setLoading(false);
      submitting.current = link.kind === 'invite' && ['network_failed', 'invalid_response', 'server_error'].includes(result.error.code);
      return;
    }
    let signedIn = false;
    if (result.data.session) {
      try {
        const sessionResult = await supabase.auth.setSession(result.data.session);
        if (revision !== actionRevision.current || submittedLinkKey !== activeLinkKey.current) return;
        signedIn = !sessionResult.error && !!sessionResult.data.session;
      } catch (error) {
        console.warn('[memberInvitations] Session setup failed', { kind: error instanceof Error ? error.name : 'unknown' });
      }
    }
    // The account exists even when automatic login fails. Never retry a consumed invitation.
    setJoined({ signedIn });
    setUncertainJoinEmail(null);
    setPassword('');
    setPassword2('');
    window.history.replaceState(null, '', `${window.location.pathname}`);
    setLoading(false);
    submitting.current = false;
  };

  const errorText = (error: InvitationError) => error.code === 'password_mismatch'
    ? t('setPassword.mismatch') : t(invitationErrorKey(error));
  const confirmationDetails = details && 'email' in details ? details : null;

  return (
    <main className="flex min-h-screen items-center justify-center bg-background px-4 py-8">
      <div className="w-full max-w-md space-y-5 rounded-xl border border-border bg-card p-5 shadow-lg sm:p-8">
        <img src={`${appUrl}livo-logo.png`} alt="LIVO" className="mx-auto h-20 w-auto" />
        {uncertainJoinEmail !== null && !joined && <section role="status" aria-labelledby="join-recovery-title" className="space-y-3 rounded-lg border border-primary/30 bg-primary/5 p-4">
          <h2 id="join-recovery-title" ref={recoveryHeading} tabIndex={-1} className="font-semibold outline-none">{t('memberInvite.resultUnknownTitle')}</h2>
          <p className="break-words text-sm leading-relaxed">{t('memberInvite.resultUnknownDescription', { email: uncertainJoinEmail })}</p>
          {recoveryLoginError && <p role="alert" className="text-sm text-destructive">{t('memberInvite.recoveryLoginFailed')}</p>}
          <a href={loginUrl} onClick={handleRecoveryLogin} aria-disabled={recoveryLoginLoading || (hasExistingSession === null && !recoveryLoginError)} aria-busy={recoveryLoginLoading} className={`${buttonClass} inline-flex items-center justify-center bg-primary text-primary-foreground hover:bg-primary/90 aria-disabled:opacity-50`}>{t(recoveryLoginLoading || (hasExistingSession === null && !recoveryLoginError) ? 'memberInvite.recoveryLoginLoading' : hasExistingSession ? 'memberInvite.resultUnknownSwitchAccount' : 'memberInvite.resultUnknownLogin')}</a>
        </section>}
        {joined ? <div className="space-y-4 text-center">
          <CheckCircle2 className="mx-auto text-primary" size={36} aria-hidden="true" />
          <h1 className="text-lg font-semibold">{t('memberInvite.joined')}</h1>
          <p className="text-sm text-muted-foreground">{t(joined.signedIn ? 'memberInvite.joinedDescription' : 'memberInvite.signInRequired')}</p>
          <a href={joined.signedIn ? appUrl : loginUrl} className={`${buttonClass} inline-flex items-center justify-center bg-primary text-primary-foreground hover:bg-primary/90`}>{t(joined.signedIn ? 'memberInvite.continueToApp' : 'memberInvite.signIn')}</a>
        </div> : checking ? <p role="status" className="py-6 text-center text-sm text-muted-foreground">{t('common.loading')}</p>
          : linkError ? <div className="space-y-4 text-center">
            <h1 className="text-lg font-semibold">{t('memberInvite.invalidTitle')}</h1>
            <p role="alert" className="text-sm leading-relaxed text-muted-foreground">{uncertainJoinEmail !== null && linkError.code === 'invalid_token' ? t('memberInvite.resultUnknownLinkUnavailable') : errorText(linkError)}</p>
            {link && !['invalid_token', 'email_taken', 'registration_pending'].includes(linkError.code) && <button type="button" onClick={() => setCheckRevision(value => value + 1)} className={`${buttonClass} border border-border hover:bg-accent`}>{t('common.retry')}</button>}
            <a href={loginUrl} className="inline-block min-h-11 py-3 text-sm text-primary hover:underline">{t('setPassword.backToLogin')}</a>
          </div> : details && link ? <>
            <div className="space-y-2 text-center">
              <h1 className="break-words text-lg font-semibold">{t('memberInvite.joinTitle', { workspace: details.workspaceName })}</h1>
              <p className="text-sm leading-relaxed text-muted-foreground">{t(link.kind === 'invite' ? 'memberInvite.joinDescription' : 'memberInvite.confirmDescription')}</p>
            </div>
            <dl className="space-y-1 rounded-lg bg-muted/50 p-3 text-sm">
              <div className="flex flex-wrap gap-x-2"><dt className="text-muted-foreground">{t('memberList.roleLabel')}</dt><dd className="break-words font-medium">{selectionRoleLabel(details.isQaAdmin ? 'qa_admin' : details.role)}</dd></div>
              {details.jobTitle && <div className="flex flex-wrap gap-x-2"><dt className="text-muted-foreground">{t('memberList.jobTitleLabel')}</dt><dd className="break-words font-medium">{details.jobTitle}</dd></div>}
              {confirmationDetails && <>
                <div className="flex flex-wrap gap-x-2"><dt className="text-muted-foreground">{t('memberInvite.nameLabel')}</dt><dd className="break-words">{confirmationDetails.name}</dd></div>
                <div className="flex flex-wrap gap-x-2"><dt className="text-muted-foreground">Email</dt><dd className="min-w-0 break-all">{confirmationDetails.email}</dd></div>
              </>}
            </dl>
            {actionError && <p role="alert" className="text-sm text-destructive">{errorText(actionError)}</p>}
            {(link.kind === 'confirmation' || uncertainJoinEmail === null) && <form onSubmit={handleAccept} className="space-y-4">
              {link.kind === 'invite' && <>
                <div className="space-y-1">
                  <label htmlFor="join-name" className="text-sm font-medium">{t('memberInvite.nameLabel')}</label>
                  <input id="join-name" value={name} onChange={event => setName(event.target.value)} className={inputClass} required maxLength={80} autoComplete="name" disabled={loading} />
                </div>
                <div className="space-y-1">
                  <label htmlFor="join-email" className="text-sm font-medium">{t('memberInvite.loginAccountLabel')}</label>
                  <input id="join-email" type="email" value={email} onChange={event => setEmail(event.target.value)} aria-describedby="join-email-hint" className={inputClass} required maxLength={254} autoComplete="email" disabled={loading} />
                  <p id="join-email-hint" className="text-xs text-muted-foreground">{t('memberInvite.loginAccountHint')}</p>
                </div>
              </>}
              <div className="space-y-1">
                <label htmlFor="join-password" className="text-sm font-medium">{t('setPassword.passwordLabel')}</label>
                <input id="join-password" type="password" value={password} onChange={event => setPassword(event.target.value)} className={inputClass} minLength={8} required autoComplete="new-password" disabled={loading} aria-describedby="join-password-hint" />
                <p id="join-password-hint" className="text-xs text-muted-foreground">{t('memberInvite.passwordHint')}</p>
              </div>
              <div className="space-y-1">
                <label htmlFor="join-password-confirm" className="text-sm font-medium">{t('setPassword.confirmLabel')}</label>
                <input id="join-password-confirm" type="password" value={password2} onChange={event => setPassword2(event.target.value)} className={inputClass} minLength={8} required autoComplete="new-password" disabled={loading} />
              </div>
              <button type="submit" disabled={loading} aria-busy={loading} className={`${buttonClass} bg-primary text-primary-foreground hover:bg-primary/90`}>{t(loading ? 'memberInvite.joining' : 'memberInvite.joinButton')}</button>
            </form>}
            <p className="text-xs text-muted-foreground">{t('memberInvite.expiresAt', { date: new Date(details.expiresAt).toLocaleString(i18n.language) })}</p>
          </> : null}
      </div>
    </main>
  );
};

export default Join;
