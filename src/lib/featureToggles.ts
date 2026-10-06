/** Add a registry row to share defaults, context state and the admin save UI. */
export interface FeatureHistory {
  hasApprovalRules: boolean;
  hasApprovalRequests: boolean;
}

export const FEATURE_TOGGLES = [{
  key: 'approvals',
  label: 'featureToggles.approvalsLabel',
  description: 'featureToggles.approvalsDescription',
  resolveDefault: (history: FeatureHistory) => history.hasApprovalRules || history.hasApprovalRequests,
}, {
  key: 'slackActions',
  label: 'featureToggles.slackActionsLabel',
  description: 'qa.slackFeatureDescription',
  resolveDefault: (_history: FeatureHistory) => false,
}, {
  key: 'qa',
  label: 'qa.featureLabel',
  description: 'qa.featureDescription',
  resolveDefault: (_history: FeatureHistory) => false,
}, {
  // Off until a team turns it on; release records are kept either way.
  key: 'releases',
  label: 'featureToggles.releasesLabel',
  description: 'featureToggles.releasesDescription',
  resolveDefault: (_history: FeatureHistory) => false,
}, {
  key: 'deploymentQueue',
  label: 'featureToggles.deploymentQueueLabel',
  description: 'featureToggles.deploymentQueueDescription',
  resolveDefault: (_history: FeatureHistory) => false,
}] as const;

export type FeatureKey = typeof FEATURE_TOGGLES[number]['key'];
export type FeatureToggles = Record<FeatureKey, boolean>;

export function resolveFeatureToggles(value: unknown, history: FeatureHistory): FeatureToggles {
  const saved = value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : {};
  return Object.fromEntries(FEATURE_TOGGLES.map(feature => [
    feature.key,
    typeof saved[feature.key] === 'boolean' ? saved[feature.key] : feature.resolveDefault(history),
  ])) as FeatureToggles;
}

export const canManageFeatureToggles = (role: string | undefined) =>
  role === 'admin' || role === 'super_admin';

export const isApprovalEvent = (event: string) => event.startsWith('approval_');
export const isEventEnabled = (event: string, approvalsEnabled: boolean) =>
  approvalsEnabled || !isApprovalEvent(event);

export const isNotificationVariableEnabled = (key: string, approvalsEnabled: boolean) =>
  approvalsEnabled || !/^(approver|requester)(_|$)/.test(key);

export function resolveApprovalView<T extends string>(view: T, approvalsEnabled: boolean): T | 'board' {
  return view === 'approvals' && !approvalsEnabled ? 'board' : view;
}

export function resolveQaView<T extends string>(view: T, enabled: boolean): T | 'board' {
  return (view === 'qa' || view === 'my-qa') && !enabled ? 'board' : view;
}

export function resolveReleaseView<T extends string>(view: T, enabled: boolean): T | 'board' {
  return view === 'releases' && !enabled ? 'board' : view;
}

export function resolveDeploymentQueueView<T extends string>(view: T, enabled: boolean): T | 'board' {
  return view === 'deployment-queue' && !enabled ? 'board' : view;
}
