// Runner-only checks. These do not claim that PostgreSQL migrations have run.
// @vitest-environment node
import { describe,expect,it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildPlan,containerArgs,isLocalDockerEndpoint,IMAGE } from '../test-qa-postgres.mjs';
import { buildQaPostgresCases } from './qa-postgres-cases.mjs';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
describe('isolated QA PostgreSQL acceptance runner',()=>{
  it('plan works without Docker in PATH and cannot touch a remote Docker endpoint',()=>{
    const output=execFileSync(process.execPath,[path.join(root,'scripts/test-qa-postgres.mjs'),'--plan'],{
      encoding:'utf8',env:{...process.env,PATH:'',DOCKER_HOST:'tcp://production.invalid:2376'},
    });
    expect(JSON.parse(output)).toMatchObject({status:'not-run',executesDocker:false,migrationPasses:2});
  });
  it.each(['tcp://127.0.0.1:2375','tcp://company:2376','ssh://company','unix:///tmp/untrusted.sock','',undefined])('refuses an unapproved endpoint: %s',endpoint=>{
    expect(isLocalDockerEndpoint(endpoint)).toBe(false);
  });
  it.each(['npipe:////./pipe/docker_engine','npipe:////./pipe/dockerDesktopLinuxEngine','unix:///var/run/docker.sock'])('accepts a named local endpoint: %s',endpoint=>{
    expect(isLocalDockerEndpoint(endpoint)).toBe(true);
  });
  it('uses a unique labelled resource with bounded memory, no network and no persistent mounts',()=>{
    const args=containerArgs('livo-qa-pg-0123456789abcdef01234567','01234567-89ab-4def-8123-0123456789ab');
    const value=(flag)=>args[args.indexOf(flag)+1];
    expect(value('--network')).toBe('none');
    expect(value('--cpus')).toBe('1');
    expect(value('--memory')).toBe('512m');
    expect(value('--memory-swap')).toBe('512m');
    expect(value('--pids-limit')).toBe('128');
    expect(value('--tmpfs')).toBe('/var/lib/postgresql/data:rw,noexec,nosuid,size=256m');
    expect(value('--restart')).toBe('no');
    expect(args).toContain('--pull=never');
    expect(args).toContain(IMAGE);
    for(const flag of ['-v','--volume','--mount','-p','--publish','--privileged'])expect(args).not.toContain(flag);
    expect(()=>containerArgs('existing-db','01234567-89ab-4def-8123-0123456789ab')).toThrow();
  });
  it('executes each unmodified migration twice and snapshots data between passes',()=>{
    const plan=buildPlan();
    expect(plan.summary.migrations.map(({name})=>name)).toEqual([
      '20261002_qa_workflow.sql','20261002_qa_workflow_settings.sql',
      '20261006_deployment_environments.sql','20261007_qa_status_semantics.sql','20261013_qa_manual_state.sql',
      '20261014_qa_admin_capability.sql','20261015_qa_custom_fields.sql','20261017_notifications_task_optional.sql',
    ]);
    for(const {name} of plan.summary.migrations) {
      const source=readFileSync(path.join(root,'supabase/migrations',name),'utf8').trimEnd();
      expect(plan.sql.split(source).length-1).toBe(2);
    }
    expect(plan.sql).toContain('ON_ERROR_STOP on');
    expect(plan.sql.indexOf('CREATE TABLE qa_test.before_rerun')).toBeLessThan(plan.sql.lastIndexOf('CREATE TABLE IF NOT EXISTS public.qa_issues'));
    expect(plan.sql).toContain('second migration pass preserves every QA row and company workflow');
  });
  it('has distinct failure-sensitive assertions and covers the requested permission matrix',()=>{
    const cases=buildQaPostgresCases();
    expect(new Set(cases.labels).size).toBe(cases.labels.length);
    expect(cases.assertionCount).toBe(cases.labels.length+2);
    for(const actor of ['member','admin','super'])expect(cases.labels).toContain(`${actor} cannot directly call commit`);
    expect(cases.labels).toContain('revoked member cannot replay committed report');
    expect(cases.labels).toContain('demoted admin cannot save workflow');
    expect(cases.labels).toContain('disabled QA rejects commit');
    expect(cases.labels).toContain('create rejects another workspace');
    for(const actor of ['member','assignee','qa','admin','super']) {
      expect(cases.labels).toContain(`${actor} may manually set failed`);
      expect(cases.labels).toContain(`${actor} may manually set closed`);
      expect(cases.labels).toContain(`inactive ${actor} cannot manually change state`);
    }
    expect(cases.labels).toContain('unrelated active member cannot manually change state');
    expect(cases.labels).toContain('manual PASS to FAIL replay returns its original response');
    expect(cases.labels).toContain('manual migration retains submit fix environment guard');
    expect(cases.labels).toContain('manual states and audit events pass restore validation without fabricated evidence');
  });
});
