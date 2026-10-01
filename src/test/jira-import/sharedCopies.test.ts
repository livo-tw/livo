// @vitest-environment node
// The Docker edge functions are self-contained, so code they share with the
// worker (jiraCsv.ts) or with each other (memberAccounts.ts), and the
// docker ↔ supabase function pairs, live in byte-identical copies.
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import path from 'node:path';

describe('shared code copies', () => {
  it('match their source (run `npm run sync:shared` after editing)', () => {
    const root = path.resolve(__dirname, '../../..');
    const out = execFileSync(process.execPath, [path.join(root, 'scripts/sync-shared-code.mjs'), '--check'], {
      cwd: root,
      encoding: 'utf8',
    });
    expect(out).toContain('in sync');
  });
});
