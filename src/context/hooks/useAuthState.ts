import { useState, useCallback, useMemo, useEffect } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { toast } from 'sonner';
import i18n from '@/i18n';
import { getPermissions, type Permissions, type MemberRole } from '@/lib/permissions';
import { type ThemeKey, applyTheme } from '@/lib/themes';
import type { User } from '@/types';

export function useAuthState(users: User[], usersLoaded: boolean) {
  const [currentMemberId, setCurrentMemberIdInternal] = useState<string>('');
  const [realMemberId, setRealMemberId] = useState<string>('');
  const [memberVerified, setMemberVerified] = useState(false);
  const [userTheme, setUserThemeState] = useState<ThemeKey>('dark');

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
    const linkAuthToMember = async () => {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) {
        setMemberVerified(false);
        return;
      }
      if (!usersLoaded) return;

      const { data: memberByAuth } = await supabase
        .from('members')
        .select('id')
        .eq('auth_id', user.id)
        .maybeSingle();

      if (memberByAuth) {
        const matchedUser = users.find(u => u.id === memberByAuth.id);
        // Verify email still matches — if member data was corrected, auth_id may be stale
        if (matchedUser && user.email && matchedUser.email !== user.email) {
          console.warn(`[LIVO] stale auth link cleared: auth=${user.email} member=${matchedUser.email} (${memberByAuth.id})`);
          await supabase.from('members').update({ auth_id: null } as Record<string, unknown>).eq('id', memberByAuth.id);
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

      if (user.email) {
        const match = users.find(u => u.email === user.email);
        if (match) {
          if (match.isActive === false) {
            toast.error(i18n.t('auth.accountDisabled'));
            await supabase.auth.signOut();
            return;
          }
          setCurrentMemberId(match.id);
          setRealMemberId(match.id);
          setMemberVerified(true);
          await supabase.from('members').update({ auth_id: user.id }).eq('id', match.id);
          return;
        }
      }

      const authEmail = user.email || '(unknown)';
      const superAdmins = users.filter(u => u.role === 'super_admin');
      if (superAdmins.length > 0) {
        const notifications = superAdmins.map(admin => ({
          recipient_id: admin.id,
          sender_id: admin.id,
          type: 'system',
          task_id: '',
          content: i18n.t('auth.unknownAccountNotify', { email: authEmail }),
          is_read: false,
        }));
        await supabase.from('notifications').insert(notifications);
      }
      toast.error(i18n.t('auth.accountNotLinked', { email: authEmail }));
      await supabase.auth.signOut();
    };
    linkAuthToMember().catch(err => {
      console.error('[LIVO] linkAuthToMember failed:', err);
    });
  }, [users, usersLoaded, memberVerified, setCurrentMemberId]);

  return {
    currentMemberId, setCurrentMemberId,
    realMemberId, setRealMemberId,
    currentMember, realMember, permissions,
    userTheme, setUserThemeState, setUserTheme,
    memberVerified, setMemberVerified,
  };
}
