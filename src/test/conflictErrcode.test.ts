// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../supabase/migrations');
const PATCH = '20261019_conflicts_not_retried.sql';

describe('edit conflicts are never raised as SQLSTATE 40001', () => {
  // PostgREST retries 40001 (serialization_failure) without end, so a deterministic
  // conflict raised with it hangs the request and holds a pooled connection.
  it('no migration after the PT409 rewrite raises 40001', () => {
    const later = readdirSync(dir).filter((name) => name.endsWith('.sql') && name > PATCH).sort();
    const offenders = later.filter((name) => /ERRCODE\s*=\s*'40001'/i.test(readFileSync(path.join(dir, name), 'utf8')));
    expect(offenders).toEqual([]);
  });
  it('the rewrite covers every RAISE form the earlier migrations use', () => {
    const forms = new Set<string>();
    for (const name of readdirSync(dir).filter((n) => n.endsWith('.sql') && n < PATCH)) {
      for (const match of readFileSync(path.join(dir, name), 'utf8').matchAll(/\S*40001\S*/g)) forms.add(match[0]);
    }
    // The DO block matches ERRCODE\s*=\s*'40001'; anything else would be missed.
    expect([...forms].every((form) => /^ERRCODE='40001'[;,)]?$/.test(form))).toBe(true);
  });
});
