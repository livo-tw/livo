import type { QueryRequest } from './protocol';

export const TEAM_INTRO_TEMPLATE_KEY = 'team_intro_template';
export const MAX_TEAM_INTRO_FIELDS = 30;
export const MANUAL_TEXT_KEYS = ['best_state', 'communication', 'difficulty', 'landmine', 'bonus'] as const;
export const TEAM_INTRO_BUILTIN_KEYS = [...MANUAL_TEXT_KEYS, 'projects'] as const;
export type ManualTextKey = typeof MANUAL_TEXT_KEYS[number];

export interface TeamIntroField {
  key: string;
  label: string;
  hint: string;
  enabled: boolean;
}

export interface TeamIntroTemplate {
  version: 1;
  fields: TeamIntroField[];
}

export function defaultTeamIntroTemplate(): TeamIntroTemplate {
  return {
    version: 1,
    fields: TEAM_INTRO_BUILTIN_KEYS.map(key => ({ key, label: '', hint: '', enabled: true })),
  };
}

export function isManualTextKey(key: string): key is ManualTextKey {
  return (MANUAL_TEXT_KEYS as readonly string[]).includes(key);
}

/** Stable keys retain answers when fields are renamed, reordered or disabled. */
export function parseTeamIntroTemplate(value: unknown): TeamIntroTemplate | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const template = value as Record<string, unknown>;
  if (template.version !== 1 || !Array.isArray(template.fields) || template.fields.length > MAX_TEAM_INTRO_FIELDS) return null;
  const keys = new Set<string>();
  const fields: TeamIntroField[] = [];
  for (const item of template.fields) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return null;
    const field = item as Record<string, unknown>;
    if (typeof field.key !== 'string' || keys.has(field.key)) return null;
    const builtin = (TEAM_INTRO_BUILTIN_KEYS as readonly string[]).includes(field.key);
    if (!builtin && !/^custom_[A-Za-z0-9_-]{1,64}$/.test(field.key)) return null;
    if (typeof field.label !== 'string' || field.label.length > 100 || (!builtin && !field.label.trim())) return null;
    if (typeof field.hint !== 'string' || field.hint.length > 300 || typeof field.enabled !== 'boolean') return null;
    keys.add(field.key);
    fields.push({ key: field.key, label: field.label.trim(), hint: field.hint.trim(), enabled: field.enabled });
  }
  // Built-ins can be disabled, but their identities must never be removed.
  if (TEAM_INTRO_BUILTIN_KEYS.some(key => !keys.has(key))) return null;
  return { version: 1, fields };
}

/** Other settings remain admin-editable; this shared template is super-only.
 * The additional AND filter also protects broad updates and key renames. */
export function protectTeamIntroTemplate(req: QueryRequest, rank: number): boolean {
  if (req.table !== 'system_settings' || req.op === 'select' || rank >= 2) return true;
  const rows = (Array.isArray(req.values) ? req.values : [req.values]);
  if (rows.some(row => row && typeof row === 'object' && !Array.isArray(row) &&
      Object.entries(row).some(([column, value]) => column.toLowerCase() === 'key' && value === TEAM_INTRO_TEMPLATE_KEY))) return false;
  if (req.op === 'update' && req.filters?.length) {
    req.filters = [...req.filters, { col: 'key', op: 'neq', val: TEAM_INTRO_TEMPLATE_KEY }];
  }
  return true;
}
