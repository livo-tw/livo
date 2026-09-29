// Feature registry for the open-source edition.
//
// LIVO used to gate some features behind license tiers. The open-source
// edition has no tiers: every feature is available, and these types remain
// only so existing `hasFeature('…')` call sites keep compiling.

export type LicenseTier = 'none' | 'standard' | 'professional';

export interface LicenseInfo {
  tier: LicenseTier;
  email: string | null;
  expiresAt: Date | null;
  isExpired: boolean;
  isValid: boolean;
  raw: string | null;
  installationId: string | null;
  installationBound: boolean;
}

export type FeatureName =
  | 'dashboard'
  | 'standup'
  | 'team-intro'
  | 'realtime-collab'
  | 'slack-notify'
  | 'auto-reports'
  | 'work-report'
  | 'activity-log'
  | 'jira-import'
  | 'required-fields'
  | 'proxy-login'
  | 'json-backup'
  | 'data-export'
  | 'task-dependencies'
  | 'subtasks';

/** Every feature is available in the open-source edition. */
export function hasFeature(_tier: LicenseTier, _feature: FeatureName): boolean {
  return true;
}
