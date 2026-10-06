// Backend-branching self-service password change (個人設定 → 變更密碼).
//
// Branches, mirroring the client selection in integrations/supabase/client.ts:
//  - mock client (?demo=pro sales demo, or nothing configured): blocked with a
//    friendly i18n message — the mock has no credentials to change.
//  - Cloudflare backend (USE_CF_BACKEND): cfClient auth.changePassword() does
//    the fetch AND replaces the stored session (the server revokes every old
//    refresh token on success).
//  - legacy self-host Supabase: verify the current password via
//    signInWithPassword, then updateUser({password}).
//
// All branches resolve to the same `{ error: { message, code? } | null }`
// shape; `message` is always display-ready (backend zh message or i18n).

import { supabase } from '@/integrations/supabase/client';
import { USE_CF_BACKEND } from './apiBase';
import { IS_DEMO_PRO } from './demoMode';
import { PASSWORD_CHANGE_FLAG } from './passwordChangeRequired';
import i18n from '@/i18n';

export interface ChangePasswordError {
  message: string;
  code?: string;
}

const SUPABASE_URL = (import.meta.env.VITE_SUPABASE_URL as string | undefined) || '';

export async function changeOwnPassword(
  currentPassword: string,
  newPassword: string
): Promise<{ error: ChangePasswordError | null }> {
  // Mock client active — no backend to change a password on.
  if (IS_DEMO_PRO || (!USE_CF_BACKEND && !SUPABASE_URL)) {
    return { error: { message: i18n.t('settings.passwordDemoBlocked'), code: 'demo_blocked' } };
  }

  if (newPassword === currentPassword) {
    return { error: { message: i18n.t('settings.passwordSameAsCurrent'), code: 'same_password' } };
  }

  if (USE_CF_BACKEND) {
    const auth = supabase.auth as unknown as {
      changePassword: (
        currentPassword: string,
        newPassword: string
      ) => Promise<{ error: ChangePasswordError | null }>;
    };
    return auth.changePassword(currentPassword, newPassword);
  }

  // Legacy self-host Supabase (Docker): verify, then update.
  const { data: userData } = await supabase.auth.getUser();
  const email = userData.user?.email;
  if (!email) {
    return { error: { message: i18n.t('settings.passwordSessionExpired') } };
  }
  const { error: verifyError } = await supabase.auth.signInWithPassword({
    email,
    password: currentPassword,
  });
  if (verifyError) {
    return {
      error: {
        message: i18n.t('settings.passwordInvalidCurrent'),
        code: 'invalid_current_password',
      },
    };
  }
  // One call: the new password and clearing an admin-set password's flag.
  const { error: updateError } = await supabase.auth.updateUser({ password: newPassword, data: { [PASSWORD_CHANGE_FLAG]: false } });
  if (updateError) return { error: { message: updateError.message } };
  return { error: null };
}
