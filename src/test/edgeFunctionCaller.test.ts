// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
// The open-source export ships docker/volumes/functions (what installs run)
// but not the supabase/functions dev copy, so only the latter may be missing.
const dirs = ['docker/volumes/functions'];
if (existsSync(path.join(root, 'supabase/functions'))) dirs.push('supabase/functions');
const sources = dirs.flatMap((dir) =>
  readdirSync(path.join(root, dir), { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && existsSync(path.join(root, dir, entry.name, 'index.ts')))
    .map((entry) => path.join(dir, entry.name, 'index.ts')));

describe('Docker Edge Functions identify the caller by an active linked member', () => {
  // A login that is not linked to a member may carry an admin's e-mail (it was
  // self-registered while public sign-up was open), and a member deactivated
  // within the hour still holds a valid token. The caller is `callerAuth` or
  // `user` (the GoTrue user of the request's token) in these functions.
  it('never fall back to matching the caller by e-mail', () => {
    const offenders = sources.filter((file) => /\.eq\(\s*['"]email['"]\s*,\s*(?:callerAuth|user|caller)!?\.email\s*\)/.test(readFileSync(path.join(root, file), 'utf8')));
    expect(offenders).toEqual([]);
  });
  it('require is_active wherever the caller is looked up by auth_id', () => {
    const offenders: string[] = [];
    for (const file of sources) {
      const text = readFileSync(path.join(root, file), 'utf8');
      for (const match of text.matchAll(/\.eq\(\s*['"]auth_id['"]\s*,\s*(?:callerAuth|user)!?\.id\s*\)([\s\S]{0,80})/g)) {
        if (!/\.eq\(\s*['"]is_active['"]\s*,\s*true\s*\)/.test(match[1])) offenders.push(file);
      }
    }
    expect(offenders).toEqual([]);
  });
});
