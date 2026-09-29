#!/usr/bin/env node
// Migrate data from the legacy local Docker Supabase (Postgres) into D1.
//
// Prereq: Docker Desktop running with the old supabase compose project up
//   (cd LIVO-local-ready/docker && docker compose up -d db)
// Usage:
//   node migrate/migrate-from-docker.mjs export     # postgres -> data/*.json
//   node migrate/migrate-from-docker.mjs transform  # data/*.json -> out/import.sql (+ url rewrite)
//   node migrate/migrate-from-docker.mjs import-local   # wrangler d1 execute --local
//   node migrate/migrate-from-docker.mjs import-remote  # wrangler d1 execute --remote
//   node migrate/migrate-from-docker.mjs storage-remote # copy storage volume files to R2
//
// The cloud Supabase project (legdqetwqoioyiigiqxz) no longer resolves in DNS,
// so the only migratable data source is this local Docker instance.

import { execSync, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DATA = path.join(HERE, 'data');
const OUT = path.join(HERE, 'out');
const STORAGE_VOL = path.resolve(HERE, '../../docker/volumes/storage');

const NEW_STORAGE_BASE = process.env.NEW_STORAGE_BASE || 'https://api.livo-tw.com/api/storage';
// Old absolute storage URL prefixes to rewrite (cloud + local docker):
const OLD_URL_RE =
  /https?:\/\/(?:legdqetwqoioyiigiqxz\.supabase\.co|localhost:8000)\/storage\/v1\/object\/public\/(task-images|backups)\//g;

const TABLES = [
  // ordered so FK parents import first
  'members', 'product_lines', 'projects', 'statuses', 'sprints', 'tags',
  'tasks', 'task_tags', 'task_specs', 'task_checks', 'task_todos',
  'task_deployments', 'task_attachments', 'task_dependencies', 'comments',
  'status_logs', 'notifications', 'activity_logs', 'member_manuals',
  'system_settings', 'team_settings', 'backup_settings', 'backup_history',
  'profiles', 'user_column_configs', 'user_board_prefs', 'custom_fields',
  'task_custom_field_values', 'task_templates', 'work_reports',
  'user_report_configs', 'user_notification_preferences', 'field_locks',
  'status_transition_rules', 'orders',
  'approval_rules', 'approval_rule_steps', 'approval_requests', 'approval_actions',
  'standup_sessions', 'standup_member_durations',
  'notification_rules', 'notification_templates', 'notification_delivery_logs',
  'report_send_targets', 'report_send_logs',
  'external_account_bindings', 'external_action_logs',
  'interaction_tokens', 'due_date_reminders', 'slack_thread_mappings',
];

function dbContainer() {
  const out = execSync('docker ps --format "{{.Names}}" --filter "name=db"', { encoding: 'utf8' });
  const name = out.split('\n').map((s) => s.trim()).find((n) => /supabase.*db|db.*supabase|^supabase-db$/i.test(n) || n === 'supabase-db');
  if (!name) throw new Error('No running supabase db container found. Start it: cd docker && docker compose up -d db');
  return name;
}

function psqlJson(container, sql) {
  return execFileSync(
    'docker', ['exec', container, 'psql', '-U', 'postgres', '-d', 'postgres', '-At', '-c', sql],
    { encoding: 'utf8', maxBuffer: 1024 * 1024 * 512 }
  ).trim();
}

function exportData() {
  fs.mkdirSync(DATA, { recursive: true });
  const c = dbContainer();
  for (const t of TABLES) {
    try {
      const json = psqlJson(c, `SELECT COALESCE(json_agg(row_to_json(t)), '[]') FROM public."${t}" t`);
      fs.writeFileSync(path.join(DATA, `${t}.json`), json || '[]');
      console.log(`${t}: ${JSON.parse(json || '[]').length} rows`);
    } catch (e) {
      console.warn(`${t}: SKIP (${String(e.message).split('\n')[0]})`);
      fs.writeFileSync(path.join(DATA, `${t}.json`), '[]');
    }
  }
  // auth users (bcrypt hashes) — GoTrue schema
  try {
    const json = psqlJson(c, `SELECT COALESCE(json_agg(json_build_object('id', id::text, 'email', lower(email), 'hash', encrypted_password, 'banned', (banned_until IS NOT NULL AND banned_until > now()))), '[]') FROM auth.users WHERE email IS NOT NULL`);
    fs.writeFileSync(path.join(DATA, 'auth_users.json'), json || '[]');
    console.log(`auth_users: ${JSON.parse(json || '[]').length} rows`);
  } catch (e) {
    console.warn(`auth_users: SKIP (${String(e.message).split('\n')[0]})`);
  }
}

function sqlLit(v) {
  if (v === null || v === undefined) return 'NULL';
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : 'NULL';
  if (typeof v === 'boolean') return v ? '1' : '0';
  let s;
  if (typeof v === 'object') s = JSON.stringify(v);
  else s = String(v);
  s = s.replace(OLD_URL_RE, `${NEW_STORAGE_BASE}/$1/`);
  return `'${s.replace(/'/g, "''")}'`;
}

function transform() {
  fs.mkdirSync(OUT, { recursive: true });
  const lines = ['PRAGMA defer_foreign_keys = on;'];
  for (const t of TABLES) {
    const file = path.join(DATA, `${t}.json`);
    if (!fs.existsSync(file)) continue;
    const rows = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!rows.length) continue;
    const chunk = 40;
    for (let i = 0; i < rows.length; i += chunk) {
      for (const row of rows.slice(i, i + chunk)) {
        const cols = Object.keys(row);
        lines.push(
          `INSERT OR REPLACE INTO "${t}" (${cols.map((cc) => `"${cc}"`).join(',')}) VALUES (${cols.map((cc) => sqlLit(row[cc])).join(',')});`
        );
      }
    }
    console.log(`${t}: ${rows.length} rows -> SQL`);
  }
  // auth users: keep bcrypt hashes, verified lazily on first login then re-hashed
  const authFile = path.join(DATA, 'auth_users.json');
  if (fs.existsSync(authFile)) {
    for (const u of JSON.parse(fs.readFileSync(authFile, 'utf8'))) {
      if (!u.email) continue;
      const hash = u.hash ? `'bcrypt$${String(u.hash).replace(/'/g, "''")}'` : 'NULL';
      lines.push(
        `INSERT OR REPLACE INTO auth_users (id, email, password_hash, banned, created_at) VALUES ('${u.id}', '${u.email.replace(/'/g, "''")}', ${hash}, ${u.banned ? 1 : 0}, '${new Date().toISOString()}');`
      );
    }
  }
  fs.writeFileSync(path.join(OUT, 'import.sql'), lines.join('\n'));
  console.log(`Wrote ${path.join(OUT, 'import.sql')} (${lines.length} statements)`);
}

function importDb(where) {
  const flag = where === 'remote' ? '--remote' : '--local';
  execSync(`npx wrangler d1 execute livo-db ${flag} --file=./migrate/out/import.sql -y`, {
    cwd: path.resolve(HERE, '..'),
    stdio: 'inherit',
  });
}

function walk(dir, base = '') {
  const out = [];
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const rel = base ? `${base}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(...walk(path.join(dir, e.name), rel));
    else out.push(rel);
  }
  return out;
}

function storageRemote() {
  // supabase storage-api "file" backend keeps objects under volumes/storage/<bucket>/<key...>
  const files = walk(STORAGE_VOL);
  if (!files.length) {
    console.log(`No files under ${STORAGE_VOL} — nothing to copy.`);
    return;
  }
  for (const rel of files) {
    const key = rel.replace(/\\/g, '/');
    console.log(`put ${key}`);
    execSync(`npx wrangler r2 object put "livo-attachments/${key}" --file="${path.join(STORAGE_VOL, rel)}" --remote`, {
      cwd: path.resolve(HERE, '..'),
      stdio: 'inherit',
    });
  }
}

const cmd = process.argv[2];
if (cmd === 'export') exportData();
else if (cmd === 'transform') transform();
else if (cmd === 'import-local') importDb('local');
else if (cmd === 'import-remote') importDb('remote');
else if (cmd === 'storage-remote') storageRemote();
else {
  console.log('Usage: node migrate/migrate-from-docker.mjs <export|transform|import-local|import-remote|storage-remote>');
  process.exit(1);
}
