import { useState, useCallback, useMemo, useEffect, useRef } from 'react';
import { supabase, USING_MOCK_BACKEND } from '@/integrations/supabase/client';
import { toast } from 'sonner';
import i18n from '@/i18n';
import { getPermissions, type Permissions, type MemberRole } from '@/lib/permissions';
import { type ThemeKey, applyTheme } from '@/lib/themes';
import type { User } from '@/types';

export function useAuthState(users: User[], usersLoaded: boolean) {
  // The Docker active-member gate requires an existing auth_id link. Only the
  // cloud backend (and the offline demo) supports the legacy self-link flow.
  const allowEmailSelfLink = USING_MOCK_BACKEND || Boolean(import.meta.env.VITE_API_URL);
  const [currentMemberId, setCurrentMemberIdInternal] = useState<string>('');
  const [realMemberId, setRealMemberId] = useState<string>('');
  const [memberVerified, setMemberVerified] = useState(false);
  const [verificationFailed, setVerificationFailed] = useState(false);
  const [userTheme, setUserThemeState] = useState<ThemeKey>('dark');

  // Share this provider's startup identity read with theme loading and effect
  // reruns. A different signed-in user mounts a new provider (see App.tsx).
  const authUserRead = useRef<ReturnType<typeof supabase.auth.getUser> | null>(null);
  const readAuthUser = useCallback(() => {
    if (!authUserRead.current) {
      const request = supabase.auth.getUser();
      authUserRead.current = request;
      void request.then(result => {
        if ((result.error || !result.data.user) && authUserRead.current === request) authUserRead.current = null;
      }, () => {
        if (authUserRead.current === request) authUserRead.current = null;
      });
    }
    return authUserRead.current;
  }, []);

  const setCurrentMemberId = useCallback((id: string) => {
    setCurrentMemberIdInternal(id);
    if (id) localStorage.setItem('currentMemberId', id);
    else localStorage.removeItem('currentMemberId');
  }, []);

  const currentMember = useMemo(() => users.find(u => u.id === currentMemberId) || null, [users, currentMemberId]);
  const realMember = useMemo(() => users.find(u => u.id === realMemberId) || null, [users, realMemberId]);
  const permissions: Permissions = useMemo(() => getPermissions((currentMember?.role || 'member') as MemberRole), [currentMember]);

  const setUserTheme = useCallback(async (theme: ThemeKey) => {
    setUserThemeState(theme);
    applyTheme(theme);
    if (currentMemberId) {
      await supabase.from('members').update({ theme } as Record<string, unknown>).eq('id', currentMemberId);
    }
  }, [currentMemberId]);

  // Link auth user to member
  useEffect(() => {
    if (memberVerified) return;
    let cancelled = false;
    const linkAuthToMember = async () => {
      setVerificationFailed(false);
      const { data: { user }, error: authError } = await readAuthUser();
      if (cancelled) return;
      if (authError) throw authError;
      if (!user) {
        setMemberVerified(false);
        setVerificationFailed(true);
        return;
      }
      if (!usersLoaded) return;

      const { data: memberByAuth, error: memberReadError } = await supabase
        .from('members')
        .select('id')
        .eq('auth_id', user.id)
        .maybeSingle();
      if (cancelled) return;
      // A failed read is not evidence of an unlinked account. Never fall back
      // to e-mail matching or issue writes after a network/permission failure.
      if (memberReadError) throw memberReadError;

      // Logins are matched by e-mail without case (GoTrue stores it lower-case);
      // a case-sensitive compare cleared the link of a member whose e-mail was
      // saved with capitals on every sign-in and locked them out.
      const sameEmail = (a?: string | null, b?: string | null) => !!a && !!b && a.trim().toLowerCase() === b.trim().toLowerCase();
      if (memberByAuth) {
        const matchedUser = users.find(u => u.id === memberByAuth.id);
        if (!matchedUser) throw new Error('Linked member is missing from the fresh member read');
        // Verify email still matches — if member data was corrected, auth_id may be stale
        if (allowEmailSelfLink && user.email && !sameEmail(matchedUser.email, user.email)) {
          console.warn(`[LIVO] stale auth link cleared: auth=${user.email} member=${matchedUser.email} (${memberByAuth.id})`);
          const { error: unlinkError } = await supabase.from('members').update({ auth_id: null } as Record<string, unknown>).eq('id', memberByAuth.id);
          if (cancelled) return;
          if (unlinkError) throw unlinkError;
          // Fall through to email-based matching below
        } else {
          if (matchedUser && matchedUser.isActive === false) {
            toast.error(i18n.t('auth.accountDisabled'));
            await supabase.auth.signOut();
            return;
          }
          setCurrentMemberId(memberByAuth.id);
          setRealMemberId(memberByAuth.id);
          setMemberVerified(true);
          return;
        }
      }

      if (allowEmailSelfLink && user.email) {
        const match = users.find(u => sameEmail(u.email, user.email));
        if (match) {
          if (match.isActive === false) {
            toast.error(i18n.t('auth.accountDisabled'));
            await supabase.auth.signOut();
            return;
          }
          const { error: linkError } = await supabase.from('members').update({ auth_id: user.id }).eq('id', match.id);
          if (cancelled) return;
          if (linkError) throw linkError;
          setCurrentMemberId(match.id);
          setRealMemberId(match.id);
          setMemberVerified(true);
          return;
        }
      }

      const authEmail = user.email || '(unknown)';
      const superAdmins = users.filter(u => u.role === 'super_admin');
      // On Docker a login with no active member cannot read members or write
      // notifications, so nobody can be told and it may as well be a deactivated
      // member: say only that the account cannot be used.
      let notified = false;
      if (superAdmins.length > 0) {
        const notifications = superAdmins.map(admin => ({
          recipient_id: admin.id,
          sender_id: admin.id,
          type: 'system',
          task_id: '',
          content: i18n.t('auth.unknownAccountNotify', { email: authEmail }),
          is_read: false,
        }));
        const { error } = await supabase.from('notifications').insert(notifications);
        if (cancelled) return;
        notified = !error;
      }
      toast.error(i18n.t(notified ? 'auth.accountNotLinked' : 'auth.accountUnavailable', { email: authEmail }));
      await supabase.auth.signOut();
    };
    linkAuthToMember().catch(err => {
      if (!cancelled) {
        console.error('[LIVO] linkAuthToMember failed:', err);
        setVerificationFailed(true);
      }
    });
    return () => { cancelled = true; };
  }, [users, usersLoaded, memberVerified, setCurrentMemberId, readAuthUser, allowEmailSelfLink]);

  return {
    currentMemberId, setCurrentMemberId,
    realMemberId, setRealMemberId,
    currentMember, realMember, permissions,
    userTheme, setUserThemeState, setUserTheme,
    memberVerified, setMemberVerified, verificationFailed, readAuthUser,
  };
}
