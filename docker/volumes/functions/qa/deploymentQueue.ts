/** Shared configuration only. Authorization additionally requires a verified active actor. */
export interface DeploymentQueueSettings {
  version: 1;
  enabled: boolean;
  taskStatusIds: string[];
  operatorMemberIds: string[];
}
export const defaultDeploymentQueueSettings = (): DeploymentQueueSettings => ({ version: 1, enabled: false, taskStatusIds: [], operatorMemberIds: [] });
export function parseDeploymentQueueSettings(value: unknown): DeploymentQueueSettings | null {
  if (typeof value === 'string') { try { value = JSON.parse(value); } catch { return null; } }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>, keys = ['version', 'enabled', 'taskStatusIds', 'operatorMemberIds'];
  if (Object.keys(row).length !== keys.length || Object.keys(row).some(key => !keys.includes(key)) || row.version !== 1 || typeof row.enabled !== 'boolean') return null;
  const ids = (v: unknown): v is string[] => Array.isArray(v) && v.length <= 200
    && v.every(id => typeof id === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,99}$/.test(id)) && new Set(v).size === v.length;
  if (!ids(row.taskStatusIds) || !ids(row.operatorMemberIds)) return null;
  return { version: 1, enabled: row.enabled, taskStatusIds: [...row.taskStatusIds], operatorMemberIds: [...row.operatorMemberIds] };
}

/** The server must derive memberId from its verified, currently active actor. */
export function isDeploymentQueueOperator(config: unknown, toggles: unknown, memberId: string): boolean {
  const settings = parseDeploymentQueueSettings(config);
  return !!settings?.enabled && !!toggles && typeof toggles === 'object' && !Array.isArray(toggles)
    && (toggles as Record<string, unknown>).deploymentQueue === true && settings.operatorMemberIds.includes(memberId);
}
