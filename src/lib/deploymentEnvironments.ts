/** One catalog for task deployments, QA and Slack. No runtime-specific imports. */
export const DEPLOYMENT_ENVIRONMENTS_KEY = 'deployment_environments';
export const DEFAULT_DEPLOYMENT_ENVIRONMENTS = ['Dev', 'QA', 'Stage', 'Live Staging', 'Prod'] as const;
export interface DeploymentEnvironmentSettings { version: 1; values: string[] }
export const defaultDeploymentEnvironments = (): DeploymentEnvironmentSettings => ({ version: 1, values: [...DEFAULT_DEPLOYMENT_ENVIRONMENTS] });

export function validEnvironmentName(value: unknown): value is string {
  return typeof value === 'string' && value.length >= 1 && Array.from(value).length <= 120 && value === value.trim() && !/[\u0000-\u001f\u007f]/.test(value);
}

/** Missing settings use the original catalog; malformed persisted settings fail closed. */
export function parseDeploymentEnvironments(value: unknown): DeploymentEnvironmentSettings | null {
  if (value === undefined) return defaultDeploymentEnvironments();
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  if (row.version !== 1 || !Array.isArray(row.values) || row.values.length < 1 || row.values.length > 30 ||
    !row.values.every(validEnvironmentName) || new Set(row.values).size !== row.values.length ||
    Object.keys(row).some(key => key !== 'version' && key !== 'values')) return null;
  return { version: 1, values: [...row.values] };
}

/** Historical values remain visible but are never added to the active catalog. */
export function deploymentEnvironmentOptions(active: readonly string[], current: readonly string[] = []) {
  const values = [...new Set(active.filter(validEnvironmentName))];
  for (const value of current) if (validEnvironmentName(value) && !values.includes(value)) values.push(value);
  return values.map(value => ({ value, legacy: !active.includes(value) }));
}

/** Run before a generic backup restore deletes rows. A backup never expands the active catalog. */
export function missingRestoreEnvironments(rows: unknown, active: readonly string[]): string[] {
  if (rows === undefined) return [];
  if (!Array.isArray(rows)) throw new Error('invalid-deployment-backup');
  const values = rows.map(row => {
    if (!row || typeof row !== 'object' || !validEnvironmentName(row.environment)) throw new Error('invalid-deployment-backup');
    return row.environment as string;
  });
  return [...new Set(values.filter(value => !active.includes(value)))];
}

type EnvironmentKind = 'dev' | 'qa' | 'stage' | 'liveStaging' | 'prod';
// The default catalog and the usual ways a team renames it ("Staging", "Production").
const ENVIRONMENT_KINDS: Record<string, EnvironmentKind> = {
  dev: 'dev', development: 'dev', qa: 'qa', stage: 'stage', staging: 'stage', stg: 'stage',
  'live staging': 'liveStaging', prod: 'prod', production: 'prod', prd: 'prod',
};
const PRESENTATION: Record<EnvironmentKind, { color: string; abbreviation: string }> = {
  dev: { color: '#36B37E', abbreviation: 'D' }, qa: { color: '#00B8D9', abbreviation: 'Q' },
  stage: { color: '#FF8B00', abbreviation: 'S' }, liveStaging: { color: '#6554C0', abbreviation: 'LS' },
  prod: { color: '#FF5630', abbreviation: 'P' },
};

export function deploymentEnvironmentKind(value: string): EnvironmentKind | undefined {
  return ENVIRONMENT_KINDS[value.trim().toLowerCase().replace(/[\s_-]+/g, ' ')];
}

export function deploymentEnvironmentPresentation(value: string) {
  const kind = deploymentEnvironmentKind(value);
  return kind ? { ...PRESENTATION[kind] } : { color: '#6B778C', abbreviation: value.slice(0, 3) };
}

/** Where a new bug was found unless the reporter says otherwise: the staging environment, else the first one. */
export function defaultObservedEnvironment(environments: readonly string[]): string | undefined {
  return environments.find(value => deploymentEnvironmentKind(value) === 'stage') ?? environments[0];
}
