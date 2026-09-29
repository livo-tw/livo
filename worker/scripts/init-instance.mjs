#!/usr/bin/env node
// First-time setup for a new LIVO instance on Cloudflare D1.
//
//   node scripts/init-instance.mjs --local  --email you@example.com --name "Your Name"
//   node scripts/init-instance.mjs --remote --email you@example.com --name "Your Name"
//
// Run it from worker/ after `npm run db:migrate:local` (or :remote). It
// applies the structural defaults from seed.sql (task statuses, settings,
// notification templates) WITHOUT the 20 demo accounts in that file, then
// creates your first super admin. Without --password (or LIVO_ADMIN_PASSWORD)
// it generates a password and prints it once — change it after signing in.
// Re-running is safe: defaults are INSERT OR IGNORE, and an email that
// already has a login is refused instead of overwritten.

import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const WORKER_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const opt = (name) => {
  const i = argv.indexOf(name);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : undefined;
};
const die = (msg) => {
  console.error(`\n✖ ${msg}\n`);
  process.exit(1);
};

const target = argv.includes('--remote') ? '--remote' : argv.includes('--local') ? '--local' : null;
if (!target) die('Choose --local (wrangler dev database) or --remote (your Cloudflare D1).');
const email = (opt('--email') || '').trim().toLowerCase();
if (!/^[^@\s']+@[^@\s']+\.[^@\s']+$/.test(email)) die('Pass a valid admin email: --email you@example.com');
const name = (opt('--name') || email.split('@')[0]).trim().slice(0, 40);
const generated = !opt('--password') && !process.env.LIVO_ADMIN_PASSWORD;
const password = opt('--password') || process.env.LIVO_ADMIN_PASSWORD || crypto.randomBytes(12).toString('base64url');
if (password.length < 8) die('The password needs at least 8 characters.');

const sqlText = (s) => `'${String(s).replace(/'/g, "''")}'`;

function wrangler(args) {
  const r = spawnSync('npx', ['wrangler', 'd1', 'execute', 'livo-db', target, ...args], {
    cwd: WORKER_DIR,
    encoding: 'utf8',
    shell: process.platform === 'win32',
  });
  if (r.status !== 0) die(`wrangler failed:\n${r.stderr || r.stdout}`);
  return r.stdout;
}

// 1) refuse to touch an existing login
const probe = wrangler(['--json', '--command', `SELECT COUNT(*) AS n FROM auth_users WHERE email = ${sqlText(email)} COLLATE NOCASE`]);
let existing = 0;
try {
  existing = Number(JSON.parse(probe)[0].results[0].n) || 0;
} catch {
  die(`Could not read the database. Did you run the schema migration first?\n${probe}`);
}
if (existing > 0) die(`${email} already has a login. Sign in with it, or pick another email.`);

// 2) structural defaults from seed.sql, minus its demo accounts
const seed = fs.readFileSync(path.join(WORKER_DIR, 'seed.sql'), 'utf8');
const defaults = seed.replace(/^INSERT OR IGNORE INTO (?:auth_users|members)\b[\s\S]*?;[ \t]*$/gm, '');
if (/INTO (auth_users|members)\b/.test(defaults)) die('seed.sql has an unexpected shape; demo accounts were not stripped.');

// 3) the first super admin (same PBKDF2 format as worker/src/auth.ts)
const salt = crypto.randomBytes(16);
const hash = crypto.pbkdf2Sync(password, salt, 100_000, 32, 'sha256');
const passwordHash = `pbkdf2$100000$${salt.toString('base64')}$${hash.toString('base64')}`;
const authId = crypto.randomUUID();
const memberId = `u${Date.now().toString(36)}${crypto.randomBytes(2).toString('hex')}`;
const avatar = name.slice(0, 1).toUpperCase();

const sql = `${defaults}
-- first super admin
INSERT INTO auth_users (id, email, password_hash, banned) VALUES (${sqlText(authId)}, ${sqlText(email)}, ${sqlText(passwordHash)}, 0);
INSERT INTO members (workspace_id, id, name, avatar, role, job_title, color, email, is_active, sort_order, auth_id, theme)
VALUES ('default', ${sqlText(memberId)}, ${sqlText(name)}, ${sqlText(avatar)}, 'super_admin', '', '#FF5630', ${sqlText(email)}, 1, 0, ${sqlText(authId)}, 'dark');
`;
const tmp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'livo-init-')), 'init.sql');
fs.writeFileSync(tmp, sql);
try {
  wrangler([`--file=${tmp}`, '-y']);
} finally {
  fs.rmSync(path.dirname(tmp), { recursive: true, force: true });
}

console.log(`\n✔ LIVO is ready (${target === '--local' ? 'local database' : 'Cloudflare D1'}).`);
console.log(`  Super admin: ${email}`);
if (generated) console.log(`  Password:    ${password}   ← shown once; change it after signing in`);
console.log('');
