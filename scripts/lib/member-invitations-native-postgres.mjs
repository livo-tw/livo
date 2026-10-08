// Native acceptance uses only an owned local PostgreSQL 15 cluster. The caller
// supplies already-installed binaries and a pg client, both outside checkouts.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { randomUUID, createHash } from 'node:crypto';

function outsideCheckout(value) {
  const absolute = path.resolve(value);
  if (absolute.startsWith('\\\\')) throw new Error('Native tests require local paths');
  // Managed sandboxes put empty .git sentinels at writable roots. Ask Git about
  // an actual checkout rather than mistaking those sentinels for a repository.
  const candidates = new Set([absolute, fs.existsSync(absolute) ? fs.realpathSync(absolute) : absolute]);
  for (const candidate of candidates) for (let current = candidate; ; current = path.dirname(current)) {
    const marker = path.join(current, '.git');
    if (fs.existsSync(marker)) {
      // Fail closed for real worktrees even when Git rejects ownership or its
      // executable is unavailable; no Git metadata contents are read.
      if (fs.statSync(marker).isFile() || fs.existsSync(path.join(marker, 'config')) || fs.existsSync(path.join(marker, 'HEAD'))) {
        throw new Error('Native runtime and artifacts must stay outside Git checkouts');
      }
      const git = spawnSync('git', ['-C', current, 'rev-parse', '--show-toplevel'], {
        encoding: 'utf8', timeout: 5000, windowsHide: true,
      });
      if (git.status === 0) throw new Error('Native runtime and artifacts must stay outside Git checkouts');
    }
    if (current === path.dirname(current)) break;
  }
  return absolute;
}

export async function runMemberInvitationsNative(plan, { binaryDir, clientPackage, reportPath } = {}) {
  if (!binaryDir || !clientPackage) throw new Error('--native requires --pg-bin and --pg-client-package');
  const bin = outsideCheckout(binaryDir), pkg = outsideCheckout(clientPackage);
  const report = reportPath ? outsideCheckout(reportPath) : undefined;
  if (!fs.statSync(pkg).isFile()) throw new Error('The pg client package.json must exist');
  const { Client } = createRequire(pkg)('pg');
  const exe = name => path.join(bin, name + (process.platform === 'win32' ? '.exe' : ''));
  for (const name of ['postgres', 'initdb', 'pg_ctl']) {
    if (!fs.statSync(exe(name)).isFile()) throw new Error('Missing native PostgreSQL binary: ' + name);
  }
  const version = spawnSync(exe('postgres'), ['--version'], { encoding: 'utf8', timeout: 5000, windowsHide: true });
  if (version.status !== 0 || !/PostgreSQL\) 15\./.test(version.stdout)) throw new Error('Acceptance requires PostgreSQL 15');
  const runId = randomUUID(), run = fs.mkdtempSync(path.join(outsideCheckout(os.tmpdir()), 'livo-member-invite-pg-'));
  const data = path.join(run, 'data');
  fs.writeFileSync(path.join(run, 'owner.json'), JSON.stringify({ runId, data }) + '\n');
  fs.writeFileSync(path.join(run, 'plan.sql'), plan.sql, 'utf8');
  const server = net.createServer();
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  const config = { host: '127.0.0.1', port, user: 'postgres', database: 'postgres', connectionTimeoutMillis: 5000, query_timeout: 120000 };
  const result = { ...plan.summary, runId, scope: 'owned_isolated_local_native_postgres', productionOperations: 0,
    nativeVersion: version.stdout.trim(), artifacts: run, planSha256: createHash('sha256').update(plan.sql).digest('hex') };
  let client, startAttempted = false, failure, failurePhase = 'cluster_setup';
  const command = (name, args, label, expectZero = true) => {
    const fd = fs.openSync(path.join(run, label + '.log'), 'w');
    try {
      const outcome = spawnSync(exe(name), args, { windowsHide: true, stdio: ['ignore', fd, fd], timeout: 40000 });
      if (expectZero && outcome.status !== 0) throw new Error(`${label} exited ${outcome.status}: ${outcome.error?.message ?? 'see owned artifact log'}`);
      return outcome.status;
    } finally { fs.closeSync(fd); }
  };
  const execute = async sql => {
    const other = new Client(config);
    try {
      await other.connect();
      const outputs = await other.query(sql);
      return (Array.isArray(outputs) ? outputs : [outputs]).flatMap(output => output.rows ?? [])
        .map(row => Object.values(row).map(value => value === null ? '' : typeof value === 'object' ? JSON.stringify(value) : String(value)).join('|')).join('\n');
    } finally { await other.end().catch(() => {}); }
  };
  try {
    command('initdb', ['-D', data, '--encoding=UTF8', '--locale=C', '--username=postgres', '--auth=trust'], 'init');
    startAttempted = true;
    command('pg_ctl', ['-D', data, '-l', path.join(run, 'engine.log'), '-o', `-p ${port} -h 127.0.0.1 -k ${run} -c shared_buffers=32MB -c max_connections=20 -c statement_timeout=15000 -c lock_timeout=3000`, '-w', 'start'], 'start');
    client = new Client(config);
    await client.connect();
    const engine = (await client.query("SELECT version(),current_setting('data_directory') AS data,current_setting('listen_addresses') AS addresses")).rows[0];
    if (path.resolve(engine.data) !== path.resolve(data) || engine.addresses !== '127.0.0.1') throw new Error('Owned cluster scope mismatch');
    result.engine = engine;
    failurePhase = 'static_assertions';
    const outputs = await client.query(plan.sql);
    const rows = (Array.isArray(outputs) ? outputs : [outputs]).flatMap(output => output.rows ?? []);
    const verified = Object.values(rows.at(-1) ?? {})[0];
    if (verified?.status !== 'passed' || verified.assertions !== plan.summary.assertions) throw new Error('PostgreSQL assertion readback mismatch');
    result.verified = verified;
    if (plan.verifyRaces) {
      failurePhase = 'real_two_session_races';
      const races = await plan.verifyRaces(execute);
      Object.assign(result, races, { assertions: result.assertions + races.raceAssertions });
    }
  } catch (error) {
    failure = error;
    // Record only structural diagnostics, never query text/detail/where/body.
    result.failurePhase = failurePhase;
    result.errorCode = typeof error.code === 'string' && /^[0-9A-Z]{5}$/.test(error.code) ? error.code : null;
    const position = Number(error.position);
    result.errorPosition = Number.isSafeInteger(position) && position > 0 ? position : null;
    result.errorLine = failurePhase === 'static_assertions' && result.errorPosition !== null
      ? Array.from(plan.sql).slice(0, result.errorPosition - 1).join('').split('\n').length : null;
    result.errorTable = typeof error.table === 'string' && /^[A-Za-z0-9_]{1,200}$/.test(error.table) ? error.table : null;
    result.errorConstraint = typeof error.constraint === 'string' && /^[A-Za-z0-9_]{1,200}$/.test(error.constraint) ? error.constraint : null;
  }
  finally {
    if (client) await client.end().catch(() => {});
    const owner = JSON.parse(fs.readFileSync(path.join(run, 'owner.json'), 'utf8'));
    if (owner.runId !== runId || owner.data !== data) {
      failure = new Error('Cluster ownership marker changed; no stop attempted'); result.clusterStopped = false;
    } else if (startAttempted) {
      result.stopExit = command('pg_ctl', ['-D', data, '-m', 'fast', '-w', 'stop'], 'stop', false);
      result.statusExit = command('pg_ctl', ['-D', data, 'status'], 'status', false);
      result.clusterStopped = result.statusExit === 3;
      if (!result.clusterStopped) failure = new Error(`${failure?.message ?? ''} Owned cluster stop unverified`);
    } else result.clusterStopped = true;
  }
  result.status = failure ? 'failed' : 'passed';
  if (failure) result.error = failure.message;
  fs.writeFileSync(path.join(run, 'report.json'), JSON.stringify(result, null, 2) + '\n');
  if (report) fs.writeFileSync(report, JSON.stringify(result, null, 2) + '\n');
  if (failure) throw Object.assign(failure, { report: result });
  return result;
}
