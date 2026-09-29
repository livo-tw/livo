// Feature gates for the open-source edition.
//
// Earlier commercial builds validated signed license keys here. The
// open-source edition has no keys: every feature is available, and these
// helpers stay so the backup / Slack / Jira-import gates compile unchanged.

import type { Env } from './env';

export interface LicenseCheck {
  valid: boolean;
  tier: 'none' | 'standard' | 'professional';
  isExpired: boolean;
  email: string | null;
}

export async function checkLicense(_env: Env, _workspaceId = 'default'): Promise<LicenseCheck> {
  return { valid: true, tier: 'professional', isExpired: false, email: null };
}

export async function checkProfessional(_env: Env, _workspaceId = 'default'): Promise<boolean> {
  return true;
}
