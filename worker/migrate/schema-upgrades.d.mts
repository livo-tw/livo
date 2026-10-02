export interface SchemaUpgradeAdapter {
  queryRows(sql: string): Record<string, unknown>[] | Promise<Record<string, unknown>[]>;
  applyFile(name: string): void | Promise<void>;
  log?(message: string): void;
}
export function applyPostTenantSchemaUpgrades(adapter: SchemaUpgradeAdapter): Promise<string[]>;
