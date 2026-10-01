// Types for release-upgrades.mjs (used by the unit tests in src/test/).

export function stripDemoSeeds(sql: string): string;
export function makeIdempotent(sql: string): string;
export const BASELINE_MIGRATIONS: Set<string>;
export const TRACKING_TABLE: string;
export const NO_TRANSACTION_MARKER: string;
export const TRACKING_DDL: string;
export function upgradeMigrationNames(
  migFiles: string[],
  excluded: Set<string> | Map<string, unknown>,
): string[];
export function trackingSeedSql(names: string[]): string;
export function buildUpgradeFile(name: string, sql: string): string;
export function splitTopLevelStatements(sql: string): { text: string; line: number }[];
export function lintUpgradeMigration(sql: string): string[];
