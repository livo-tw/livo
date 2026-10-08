#!/usr/bin/env node
// Type-checks the React app against a baseline of known errors.
//
// `npx tsc --noEmit` in this folder checks no file at all: tsconfig.json only
// lists project references ("files": []). The app's own tsconfig.app.json is
// strict and still has several hundred older errors, so it cannot simply be
// switched on in CI. This runs it and fails on any error that is not in
// scripts/app-type-baseline.txt, so new code is checked (an undefined name would
// otherwise reach production as a runtime error, since vite does not type-check)
// while the old errors are fixed over time.
//
//   node scripts/check-app-types.mjs            check (CI)
//   node scripts/check-app-types.mjs --update   rewrite the baseline after fixing errors
//
// Errors are compared by file, code and message, not line number, so moving code
// does not count as a new error.
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const baselinePath = join(root, 'scripts', 'app-type-baseline.txt');
const tsc = createRequire(import.meta.url).resolve('typescript/bin/tsc');
const run = spawnSync(process.execPath, [tsc, '-p', 'tsconfig.app.json', '--noEmit', '--pretty', 'false'], { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
if (run.error) { console.error(run.error); process.exit(2); }

const ERROR = /^(.+?)\((\d+),(\d+)\): error (TS\d+): (.*)$/;
const current = [];
for (const line of `${run.stdout}${run.stderr}`.split(/\r?\n/)) {
  const match = ERROR.exec(line);
  if (match) current.push({ key: `${relative(root, join(root, match[1])).split('\\').join('/')}: ${match[4]}: ${match[5]}`, where: `${match[1]}(${match[2]},${match[3]})` });
}
if (run.status !== 0 && !current.length) { console.error(`${run.stdout}${run.stderr}`); console.error('tsc failed without reporting type errors.'); process.exit(2); }

const keys = current.map(error => error.key).sort();
if (process.argv.includes('--update')) {
  writeFileSync(baselinePath, keys.length ? `${keys.join('\n')}\n` : '');
  console.log(`Baseline updated: ${keys.length} known type errors.`);
  process.exit(0);
}

const remaining = new Map();
if (existsSync(baselinePath)) for (const key of readFileSync(baselinePath, 'utf8').split('\n').filter(Boolean)) remaining.set(key, (remaining.get(key) || 0) + 1);
const fresh = [];
for (const error of current) {
  const left = remaining.get(error.key) || 0;
  if (left > 0) remaining.set(error.key, left - 1); else fresh.push(error);
}
const fixed = [...remaining.values()].reduce((sum, count) => sum + count, 0);

if (fresh.length) {
  console.error(`${fresh.length} new type error(s) in the app (not in scripts/app-type-baseline.txt):`);
  for (const error of fresh) console.error(`  ${error.where}: ${error.key.slice(error.key.indexOf(': ') + 2)}`);
  console.error('Fix them. Only if an existing error moved to a new message, run: node scripts/check-app-types.mjs --update');
  process.exit(1);
}
console.log(`App type check: no new errors (${current.length} known${fixed ? `, ${fixed} fixed since the baseline; run with --update to lower it` : ''}).`);
