// Demo reset (contract T2b) — hourly wipe+reseed of the PUBLIC demo instance,
// guarded by env DEMO_RESET==="1". Off by default, so a real customer's
// self-hosted install (DEMO_RESET unset) is never touched.
//
// The demo dataset lives in R2 at `_demo/demo-seed.sql` (uploaded from
// worker/demo-seed.sql) rather than embedded in the bundle — keeps the Worker
// lean. It deletes only the demo BUSINESS tables (tasks/projects/sprints/tags/
// task_*/comments/…) child→parent then re-inserts parent→child, so FK
// constraints hold without deferral. members & statuses are left intact.
//
// Idempotent: re-running wipes and reseeds to the same state. Safe: failures are
// logged and swallowed so a bad reset never breaks the cron (backup/slack/etc.).

import type { Env } from './env';

const DEMO_SEED_KEY = '_demo/demo-seed.sql';

export async function runDemoReset(env: Env): Promise<void> {
  // Opt in via the DEMO_MODE master switch or the standalone DEMO_RESET flag.
  if (env.DEMO_RESET !== '1' && env.DEMO_MODE !== '1') return;

  try {
    const obj = await env.ATTACHMENTS.get(DEMO_SEED_KEY);
    if (!obj) {
      console.error('[demo-reset] seed object not found in R2:', DEMO_SEED_KEY);
      return;
    }
    const raw = await obj.text();

    // Keep only executable statements (drop comments / blank lines / PRAGMA);
    // every remaining line is one complete `INSERT …;` / `DELETE …;`.
    // TENANCY: the seed's bare `DELETE FROM t;` statements are rewritten to
    // touch ONLY workspace 'default' — cloud-beta tenants share this D1 and
    // their data must never be wiped by the hourly demo reset. The INSERTs
    // need no rewrite (workspace_id defaults to 'default').
    const sql = raw
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.startsWith('INSERT') || l.startsWith('DELETE'))
      .map((l) => {
        const m = /^DELETE FROM ([A-Za-z_][A-Za-z0-9_]*);$/.exec(l);
        return m ? `DELETE FROM ${m[1]} WHERE workspace_id='default';` : l;
      })
      .join('\n');

    const res = await env.DB.exec(sql);
    console.log('[demo-reset] wiped + reseeded demo dataset; statements:', res.count);
  } catch (e) {
    console.error('[demo-reset] error:', e);
  }
}
