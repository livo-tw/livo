import { describe, expect, it } from 'vitest';
import {
  defaultTeamIntroTemplate, parseTeamIntroTemplate, protectTeamIntroTemplate, TEAM_INTRO_TEMPLATE_KEY,
} from '../../worker/src/teamIntroTemplate';
import type { QueryRequest } from '../../worker/src/protocol';

describe('team introduction template identity and validation', () => {
  it('retains stable field identities through rename, reorder and disable', () => {
    const template = defaultTeamIntroTemplate();
    template.fields[0] = { ...template.fields[0], label: 'Focus', hint: 'Working conditions', enabled: false };
    template.fields.reverse();
    template.fields.push({ key: 'custom_example', label: 'Hours', hint: '', enabled: true });
    expect(parseTeamIntroTemplate(template)).toEqual(template);
    expect(template.fields.find(field => field.key === 'best_state')?.enabled).toBe(false);
  });

  it('rejects duplicate keys, removed built-ins, invalid keys and oversized fields', () => {
    const duplicate = defaultTeamIntroTemplate();
    duplicate.fields.push({ ...duplicate.fields[0] });
    expect(parseTeamIntroTemplate(duplicate)).toBeNull();
    const missing = defaultTeamIntroTemplate();
    missing.fields.pop();
    expect(parseTeamIntroTemplate(missing)).toBeNull();
    for (const key of ['id', '__proto__', 'member_id', 'custom_']) {
      const invalid = defaultTeamIntroTemplate();
      invalid.fields.push({ key, label: 'Example', hint: '', enabled: true });
      expect(parseTeamIntroTemplate(invalid)).toBeNull();
    }
    for (const patch of [{ label: 'x'.repeat(101) }, { hint: 'x'.repeat(301) }, { enabled: 'yes' }]) {
      const invalid = defaultTeamIntroTemplate();
      Object.assign(invalid.fields[0], patch);
      expect(parseTeamIntroTemplate(invalid)).toBeNull();
    }
  });
});

describe('template backend permission floor', () => {
  it.each([0, 1])('blocks rank %s from creating, upserting or renaming into the template key', rank => {
    for (const op of ['insert', 'upsert', 'update'] as const) {
      const req: QueryRequest = { table: 'system_settings', op, values: { key: TEAM_INTRO_TEMPLATE_KEY, value: {} } };
      expect(protectTeamIntroTemplate(req, rank)).toBe(false);
    }
    expect(protectTeamIntroTemplate({ table: 'system_settings', op: 'insert', values: [
      { key: 'unrelated', value: {} }, { key: TEAM_INTRO_TEMPLATE_KEY, value: {} },
    ] }, rank)).toBe(false);
    expect(protectTeamIntroTemplate({ table: 'system_settings', op: 'upsert', values: { KEY: TEAM_INTRO_TEMPLATE_KEY, value: {} } }, rank)).toBe(false);
  });

  it('protects broad updates and renames out of the key with an additional AND filter', () => {
    const req: QueryRequest = { table: 'system_settings', op: 'update',
      values: { key: 'other', value: {} }, filters: [{ col: '', op: 'or', val: 'key.eq.team_intro_template,key.eq.other' }] };
    expect(protectTeamIntroTemplate(req, 1)).toBe(true);
    expect(req.filters?.[req.filters.length - 1]).toEqual({ col: 'key', op: 'neq', val: TEAM_INTRO_TEMPLATE_KEY });
  });

  it('keeps super administrators unrestricted and other settings available to admins', () => {
    const req: QueryRequest = { table: 'system_settings', op: 'update', values: { value: {} },
      filters: [{ col: 'key', op: 'eq', val: TEAM_INTRO_TEMPLATE_KEY }] };
    expect(protectTeamIntroTemplate(req, 2)).toBe(true);
    expect(req.filters).toHaveLength(1);
    expect(protectTeamIntroTemplate({ table: 'system_settings', op: 'upsert', values: { key: 'other' } }, 1)).toBe(true);
    expect(protectTeamIntroTemplate({ table: 'system_settings', op: 'select' }, 0)).toBe(true);
  });
});
