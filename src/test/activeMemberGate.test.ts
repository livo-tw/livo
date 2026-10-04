// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../supabase/migrations');
const GATE = '20261019_active_member_gate.sql';

describe('Docker tables need an active member', () => {
  // The gate migration adds a RESTRICTIVE policy to the tables that exist when it
  // runs. A table that turns on row security later has none until the helper runs
  // again, and its own policies alone would let an unlinked login in.
  it('every later migration that enables row security re-applies the gate', () => {
    const later = readdirSync(dir).filter((name) => name.endsWith('.sql') && name > GATE).sort();
    const offenders = later.filter((name) => {
      const sql = readFileSync(path.join(dir, name), 'utf8');
      return /ENABLE\s+ROW\s+LEVEL\s+SECURITY/i.test(sql) && !/livo_apply_active_member_gate\s*\(\s*\)/i.test(sql);
    });
    expect(offenders).toEqual([]);
  });
  it('the gate migration covers every public table with row security', () => {
    const sql = readFileSync(path.join(dir, GATE), 'utf8');
    expect(sql).toMatch(/c\.relrowsecurity/);
    expect(sql).toMatch(/AS RESTRICTIVE FOR ALL TO authenticated/);
    expect(sql).toMatch(/SELECT public\.livo_apply_active_member_gate\(\);\s*$/);
  });
});
