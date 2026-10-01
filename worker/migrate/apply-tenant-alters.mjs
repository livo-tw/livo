// Cloud-beta tenancy migration runner (see CLOUD-BETA-DESIGN.md).
//
// Usage: node migrate/apply-tenant-alters.mjs --local|--remote
// Run from the worker/ directory. CI runs `--remote` BEFORE the idempotent
// schema.sql apply; start-livo.bat runs `--local` the same way.
//
// Logic:
//   probe `SELECT workspace_id FROM tasks LIMIT 0`
//     ok               → already migrated, nothing to do
//     "no such table"  → fresh/empty DB, schema.sql will create the final
//                        shape — nothing to do
//     "no such column" → pre-tenancy DB → apply migrate/tenant-alters.sql
//   apply: one-shot --file first; if that fails (e.g. a previous partial
//   run), fall back to per-statement apply tolerating duplicate-column /
//   already-exists errors so re-runs converge.

import { execSync } from 'node:child_process';
import { readFileSync, writeFileSync, unlinkSync, mkdtempSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

const WORKER_DIR = join(dirname(fileURLToPath(import.meta.url)), '..');
const ALTERS_FILE = join(WORKER_DIR, 'migrate', 'tenant-alters.sql');

const mode = process.argv.includes('--remote') ? '--remote' : '--local';

function wrangler(args) {
  return execSync(`npx wrangler d1 execute livo-db ${mode} -y ${args}`, {
    cwd: WORKER_DIR,
    stdio: ['ignore', 'pipe', 'pipe'],
    encoding: 'utf8',
  });
}

function tryWrangler(args) {
  try {
    return { ok: true, out: wrangler(args) };
  } catch (e) {
    const out = `${e.stdout || ''}\n${e.stderr || ''}\n${e.message || ''}`;
    return { ok: false, out };
  }
}

// Independent column upgrades must run before the tenancy sentinel can exit.
const manualProbe = tryWrangler('--command "SELECT custom_fields FROM member_manuals LIMIT 0"');
if (!manualProbe.ok && /no such column/i.test(manualProbe.out)) {
  wrangler(`--file="${join(WORKER_DIR, 'migrate', 'member-manual-alters.sql')}"`);
  console.log('[member-manual-alters] custom_fields added; existing answers preserved.');
} else if (!manualProbe.ok && !/no such table/i.test(manualProbe.out)) {
  console.error('[member-manual-alters] unexpected probe failure:\n' + manualProbe.out);
  process.exit(1);
}

// ── Probe ─────────────────────────────────────────────────────────────────
const probe = tryWrangler('--command "SELECT workspace_id FROM tasks LIMIT 0"');
if (probe.ok) {
  console.log('[tenant-alters] tasks.workspace_id present — already migrated, skipping.');
  process.exit(0);
}
if (/no such table/i.test(probe.out)) {
  console.log('[tenant-alters] tasks table absent — fresh DB, schema.sql will create the final shape.');
  process.exit(0);
}
if (!/no such column/i.test(probe.out)) {
  console.error('[tenant-alters] unexpected probe failure:\n' + probe.out);
  process.exit(1);
}

// ── Apply (one-shot) ──────────────────────────────────────────────────────
console.log(`[tenant-alters] pre-tenancy DB detected — applying tenant-alters.sql (${mode})…`);
const oneShot = tryWrangler(`--file="${ALTERS_FILE}"`);
if (oneShot.ok) {
  console.log('[tenant-alters] one-shot apply OK.');
  process.exit(0);
}
console.warn('[tenant-alters] one-shot apply failed — falling back to per-statement mode.');

// ── Per-statement fallback ────────────────────────────────────────────────
// "no such table: (system|team)_settings" is tolerated so an interrupted
// settings recreate (source dropped, rename pending) converges on rerun:
// the copy is treated as already-done, DROP IF EXISTS no-ops, and the
// pending `ALTER TABLE *_v2 RENAME` completes.
const TOLERABLE = /duplicate column name|already exists|no such index|no such table: (system_settings|team_settings)\b/i;
const raw = readFileSync(ALTERS_FILE, 'utf8');
const statements = raw
  .split(/;\s*\n/)
  .map((s) => s.replace(/^\s*--.*$/gm, '').trim())
  .filter(Boolean)
  .map((s) => (s.endsWith(';') ? s : s + ';'));

const tmp = mkdtempSync(join(tmpdir(), 'livo-alter-'));
let applied = 0;
let tolerated = 0;
for (let i = 0; i < statements.length; i++) {
  const stmtFile = join(tmp, `stmt-${i}.sql`);
  writeFileSync(stmtFile, statements[i]);
  const res = tryWrangler(`--file="${stmtFile}"`);
  unlinkSync(stmtFile);
  if (res.ok) {
    applied++;
  } else if (TOLERABLE.test(res.out)) {
    tolerated++;
  } else {
    console.error(`[tenant-alters] statement ${i + 1}/${statements.length} failed hard:\n${statements[i]}\n${res.out}`);
    process.exit(1);
  }
}
console.log(`[tenant-alters] per-statement apply done: ${applied} applied, ${tolerated} tolerated (already done).`);
