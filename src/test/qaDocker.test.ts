// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { webcrypto } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { createQaService, qaPayloadHash } from '../../docker/volumes/functions/qa/service';
import { validateQaBackup } from '../../docker/volumes/functions/qa/restore';
import { createQaIssue, type QaIssue } from '../lib/qa/domain';
import { DEFAULT_QA_WORKFLOW } from '../lib/qa/workflow';
import { lintUpgradeMigration, makeIdempotent } from '../../scripts/release-upgrades.mjs';

vi.mock('../../docker/volumes/functions/qa/slackSync.ts', () => ({ syncQaSlackIssue: vi.fn(async () => undefined) }));

const AUTH = '11111111-1111-4111-8111-111111111111';
const settings: Record<string, string> = { SUPABASE_URL: 'http://internal.test', SUPABASE_ANON_KEY: 'anon', SUPABASE_SERVICE_ROLE_KEY: 'server-secret' };
const env = { get: (name: string) => settings[name] };
const context = { actor: { id: 'member-1', role: 'member' }, workspaceId: 'default', now: '2026-10-02T00:00:00.000Z',
  newId: () => 'new-id', memberIds: new Set(['member-1', 'member-2']), projectIds: new Set(['project-1']), taskIds: new Set<string>() };
const input = { projectId: 'project-1', title: 'Wallet mismatch', actual: 'Wrong amount', observedEnvironment: 'Stage' };
const fixture = () => createQaIssue(input, 'issue-1', context);
const json = (data: unknown, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(data), { status, headers });
let issue: QaIssue, enabled: unknown, active: boolean, role: string;
let receipt: Record<string, unknown> | undefined;
let rpcError: Record<string, unknown> | undefined;
let workflowSetting: unknown;
let fieldSetting: unknown;
let qaAdmin = false;
let calls: { url: URL; body: any; headers: Headers; method: string }[];

beforeEach(() => {
  vi.stubGlobal('crypto', webcrypto);
  issue = fixture(); enabled = true; active = true; role = 'member'; receipt = undefined; rpcError = undefined; workflowSetting = undefined; fieldSetting = undefined; qaAdmin = false; calls = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit = {}) => {
    const call = { url: new URL(url), body: init.body ? JSON.parse(String(init.body)) : undefined, headers: new Headers(init.headers), method: init.method || 'GET' };
    calls.push(call);
    const endpoint = call.url.pathname;
    if (endpoint === '/auth/v1/user') return json({ id: AUTH });
    if (endpoint === '/rest/v1/system_settings' && call.url.searchParams.get('key') === 'eq.deployment_environments') return json([]);
    if (endpoint === '/rest/v1/system_settings' && call.url.searchParams.get('key') === 'eq.qa_custom_fields') return json(fieldSetting === undefined ? [] : [{value:fieldSetting}]);
    if (endpoint === '/rest/v1/system_settings') return json(call.url.searchParams.get('key') === 'eq.qa_workflow'
      ? workflowSetting === undefined ? [] : [{ value: workflowSetting }] : [{ value: { qa: enabled } }]);
    if (endpoint === '/rest/v1/members') return json(call.url.searchParams.has('auth_id')
      ? active ? [{ id: 'member-1', role, auth_id: AUTH, is_active: true, is_qa_admin: qaAdmin }] : []
      : [{ id: 'member-1' }, { id: 'member-2' }]);
    if (endpoint === '/rest/v1/projects') return json([{ id: 'project-1' }]);
    if (endpoint === '/rest/v1/qa_commands') return json(receipt ? [receipt] : []);
    if (endpoint === '/rest/v1/qa_issues') return json(call.url.searchParams.get('select')?.startsWith('workspaceId:')
      ? [{ workspaceId: issue.workspaceId, projectId: issue.projectId, observedVersion: issue.observedVersion, targets: issue.targets, runs: issue.runs }]
      : [{ data: issue }], 200, { 'Content-Range': '0-0/1' });
    if (endpoint === '/rest/v1/rpc/livo_qa_commit') return rpcError ? json(rpcError, 409) : json(call.body.p_data);
    if (endpoint === '/rest/v1/qa_uploads') return json([call.body]);
    if (endpoint.startsWith('/storage/v1/object/upload/sign/')) return json({ url: '/object/upload/sign/test?token=limited-capability' });
    if (endpoint === '/rest/v1/rpc/livo_qa_finalize_upload') return rpcError ? json(rpcError, 400) : json({ id: 'upload-1', issue_id: 'issue-1', file_name: 'proof.mp4', mime_type: 'video/mp4', size: 100, uploaded_by: 'member-1', created_at: context.now });
    if (endpoint === '/rest/v1/rpc/livo_qa_restore') return json({ validateOnly: call.body.p_validate_only, inserted: 0, skipped: 0, conflicts: [], missingAssets: [], pending: 0 });
    if (endpoint === '/rest/v1/rpc/livo_qa_save_workflow') return rpcError ? json(rpcError, 403) : json(call.body.p_workflow);
    if (endpoint === '/rest/v1/rpc/livo_qa_save_field_configuration') return rpcError ? json(rpcError, 403) : json(call.body.p_configuration);
    if (endpoint === '/rest/v1/tasks') return json([]);
    if (endpoint.startsWith('/rest/v1/qa_')) return json([]);
    throw new Error(`Unexpected fetch: ${endpoint}`);
  }));
});
afterEach(() => vi.unstubAllGlobals());
const service = () => createQaService(env, 'actual-session');

describe('Docker QA field configuration',()=>{
  const configuration={version:1,fields:[{id:'reason',fieldName:'Reason',fieldType:'text',isRequired:true,isEnabled:true,sortOrder:0}]};
  it('uses the authenticated member capability for only scoped settings',async()=>{
    await expect(service().handle({action:'save_field_configuration',configuration,qaAdmin:true})).rejects.toMatchObject({code:'qa_forbidden'});
    qaAdmin=true;
    expect(await service().handle({action:'save_field_configuration',configuration})).toEqual(configuration);
    expect(await service().handle({action:'save_workflow',workflow:DEFAULT_QA_WORKFLOW})).toEqual(DEFAULT_QA_WORKFLOW);
    issue.reporterId='member-2';
    await expect(service().handle({action:'command',id:issue.id,commandId:'outsider-qa-manager',expectedVersion:1,command:{type:'set_state',state:'failed'}})).rejects.toMatchObject({code:'qa_forbidden'});
  });
  it('fails closed for malformed settings and validates report values before RPC',async()=>{
    fieldSetting={version:99,fields:[]};
    await expect(service().handle({action:'get_field_configuration'})).rejects.toMatchObject({code:'qa_invalid_field_configuration'});
    fieldSetting=configuration;
    await expect(service().handle({action:'create',id:'new-issue',commandId:'required-field',input})).rejects.toMatchObject({code:'qa_custom_field_required'});
    const created=await service().handle({action:'create',id:'new-issue',commandId:'valid-field',input:{...input,customFields:{reason:'Observed'}}});
    expect(created.customFields).toEqual({reason:'Observed'});
    const state=await service().handle({action:'command',id:issue.id,commandId:'state-no-fields',expectedVersion:1,command:{type:'set_state',state:'failed'}});
    expect(state.state).toBe('failed');
  });
});

describe('Docker manual QA states', () => {
  it('lets the active reporter move PASS to FAIL and across terminal states with explicit audit metadata', async () => {
    issue.state = 'verified';
    for (const state of ['failed', 'closed', 'new'] as const) {
      const before = issue;
      const next = await service().handle({ action: 'command', id: issue.id, commandId: 'manual-' + state,
        expectedVersion: issue.version, command: { type: 'set_state', state } });
      expect(next).toMatchObject({ state, targets: before.targets, runs: before.runs, fixCycle: before.fixCycle });
      const call = calls.filter(item => item.url.pathname.endsWith('/rpc/livo_qa_commit')).at(-1)!;
      expect(call.body.p_event.type).toBe('set_state');
      expect(JSON.parse(call.body.p_event.detail)).toMatchObject({ mode: 'manual', from: before.state, to: state });
      issue = next;
    }
  });
  it('rejects outsiders, feature-off and inactive sessions before committing a state change', async () => {
    const request = { action: 'command', id: issue.id, commandId: 'manual-forbidden', expectedVersion: issue.version,
      command: { type: 'set_state', state: 'failed' } };
    issue.reporterId = 'member-2';
    await expect(service().handle(request)).rejects.toMatchObject({ code: 'qa_forbidden' });
    issue.reporterId = 'member-1'; enabled = false;
    await expect(service().handle(request)).rejects.toMatchObject({ code: 'qa_disabled' });
    enabled = true; active = false;
    await expect(service().handle(request)).rejects.toBeDefined();
    expect(calls.some(call => call.url.pathname.endsWith('/rpc/livo_qa_commit'))).toBe(false);
  });
});

describe('Docker QA version suggestions', () => {
  it('reads only the selected default-workspace project and version-bearing fields', async () => {
    issue.observedVersion = 'legacy-custom';
    expect(await service().handle({ action: 'versions', projectId: 'project-1' })).toEqual(['legacy-custom']);
    const query = calls.find(c => c.url.pathname === '/rest/v1/qa_issues')!.url.searchParams;
    expect(query.get('project_id')).toBe('eq.project-1'); expect(query.get('workspace_id')).toBe('eq.default');
    expect(query.get('select')).not.toContain('*'); expect(query.get('select')).not.toContain('version:');
    expect(calls.some(c => c.method !== 'GET')).toBe(false);
  });
  it.each([{ enabled: false, active: true }, { enabled: true, active: false }])('requires active membership and the QA feature: %j', async state => {
    enabled = state.enabled; active = state.active;
    await expect(service().handle({ action: 'versions', projectId: 'project-1' })).rejects.toMatchObject({ status: 403 });
    expect(calls.some(c => c.url.pathname === '/rest/v1/qa_issues')).toBe(false);
  });
  it('rejects missing project selection rather than returning every project', async () => {
    await expect(service().handle({ action: 'versions', projectId: '' })).rejects.toMatchObject({ code: 'qa_invalid_id' });
    expect(calls.some(c => c.url.pathname === '/rest/v1/qa_issues')).toBe(false);
  });
});

describe('Docker grouped QA list', () => {
  it('uses one scoped IN filter with the same server pagination and count', async () => {
    const result = await service().handle({action:'list',input:{states:['new','triaged'],offset:20,limit:20}});
    const query = calls.find(call=>call.url.pathname==='/rest/v1/qa_issues');
    expect(query?.url.searchParams.get('workspace_id')).toBe('eq.default');
    expect(query?.url.searchParams.get('state')).toBe('in.(new,triaged)');
    expect(query?.url.searchParams.get('offset')).toBe('20');
    expect(query?.headers.get('Prefer')).toBe('count=exact');
    expect(result).toMatchObject({total:1,hasMore:false});
  });
  it.each([[],['new','new'],['new','untrusted'],['new,closed']].map(states=>({states})))('rejects unsafe or ambiguous grouped states $states',async ({states})=>{
    await expect(service().handle({action:'list',input:{states}})).rejects.toMatchObject({code:'qa_invalid_state'});
  });
  it('rejects simultaneous singular and grouped filters',async()=>{
    await expect(service().handle({action:'list',input:{state:'new',states:['new','triaged']}})).rejects.toMatchObject({code:'qa_invalid_state'});
  });
});

describe('Docker company QA display workflow', () => {
  const workflow = () => ({ ...DEFAULT_QA_WORKFLOW, order: [...DEFAULT_QA_WORKFLOW.order].reverse(),
    labels: { ...DEFAULT_QA_WORKFLOW.labels, new: '回報', triaged: '已分流', in_progress: '修正中', verification: 'QA 檢驗', closed: '' } });
  it('lets an active member read defaults when no company configuration exists', async () => {
    expect(await service().handle({ action: 'get_workflow' })).toEqual(DEFAULT_QA_WORKFLOW);
  });
  it('reads company labels and order without changing any issue state', async () => {
    workflowSetting = workflow();
    expect(await service().handle({ action: 'get_workflow' })).toEqual(workflow());
    expect(issue.state).toBe('new'); expect(calls.some(c => c.method === 'POST')).toBe(false);
  });
  it('falls back safely when a saved legacy value is invalid', async () => {
    workflowSetting = { order: ['approved'], labels: {} };
    expect(await service().handle({ action: 'get_workflow' })).toEqual(DEFAULT_QA_WORKFLOW);
  });
  it.each(['admin', 'super_admin'])('allows %s to save through the guarded service RPC', async memberRole => {
    role = memberRole;
    expect(await service().handle({ action: 'save_workflow', workflow: workflow() })).toEqual(workflow());
    expect(calls.find(c => c.url.pathname.endsWith('livo_qa_save_workflow'))?.body).toEqual({ p_auth_id: AUTH, p_workflow: workflow() });
    expect(calls.some(c => c.url.pathname === '/rest/v1/qa_issues')).toBe(false);
  });
  it('refuses an ordinary member even if the request forges an administrator role', async () => {
    await expect(service().handle({ action: 'save_workflow', role: 'admin', workflow: workflow() }))
      .rejects.toMatchObject({ code: 'qa_forbidden', status: 403 });
    expect(calls.some(c => c.method === 'POST')).toBe(false);
  });
  it.each(['get_workflow', 'save_workflow'])('keeps %s behind the QA switch', async action => {
    enabled = false; role = 'admin';
    await expect(service().handle({ action, workflow: workflow() })).rejects.toMatchObject({ code: 'qa_disabled', status: 403 });
    expect(calls.some(c => c.method === 'POST')).toBe(false);
  });
  it.each([
    { ...workflow(), order: ['new', 'triaged', 'in_progress', 'verification', 'approved'] },
    { ...workflow(), order: ['new', 'new', 'in_progress', 'verification', 'closed'] },
    { ...workflow(), labels: { ...workflow().labels, new: '同名', closed: '同名' } },
    { ...workflow(), labels: { ...workflow().labels, new: 'x'.repeat(41) } },
  ])('rejects a new state ID, duplicate slot/name, or oversized label before RPC', async invalid => {
    role = 'admin';
    await expect(service().handle({ action: 'save_workflow', workflow: invalid })).rejects.toMatchObject({ code: 'qa_invalid_workflow' });
    expect(calls.some(c => c.method === 'POST')).toBe(false);
  });
  it.each(['member_inactive', 'qa_disabled'])('honors transaction-time rejection: %s', async reason => {
    role = 'admin'; rpcError = { code: '42501', message: reason };
    await expect(service().handle({ action: 'save_workflow', workflow: workflow() }))
      .rejects.toMatchObject({ code: reason === 'qa_disabled' ? reason : `qa_${reason}`, status: 403 });
  });
});

describe('Docker QA session and feature boundary', () => {
  it.each(['', 'anon', 'server-secret'])('does not treat %s as a member session', async token => {
    await expect(createQaService(env, token).handle({ action: 'list' })).rejects.toMatchObject({ code: 'qa_unauthorized', status: 401 });
    expect(calls).toHaveLength(0);
  });
  it('rejects a session without an active member before any QA read', async () => {
    active = false;
    await expect(service().handle({ action: 'list' })).rejects.toMatchObject({ code: 'qa_forbidden' });
    expect(calls.some(c => c.url.pathname.includes('/qa_'))).toBe(false);
  });
  it.each([false, undefined, 'true', 1])('requires the exact true feature value (%s)', async flag => {
    enabled = flag;
    await expect(service().handle({ action: 'upload_init', id: 'issue-1', fileName: 'x.mp4', size: 10, mimeType: 'video/mp4' }))
      .rejects.toMatchObject({ code: 'qa_disabled', status: 403 });
    expect(calls.some(c => c.method === 'POST')).toBe(false);
  });
  it('derives reporter and commit identity from the verified session, ignoring forged caller identity', async () => {
    const created = await service().handle({ action: 'create', id: 'issue-2', commandId: 'command-1', input, actorId: 'super-admin' });
    expect(created.reporterId).toBe('member-1');
    const commit = calls.find(c => c.url.pathname.endsWith('/livo_qa_commit'))!;
    expect(commit.body.p_auth_id).toBe(AUTH);
    expect(commit.body.p_data.workspaceId).toBe('default');
    expect(commit.headers.get('Authorization')).toBe('Bearer server-secret');
  });
  it('refuses reporter-only triage even if a forged role is supplied', async () => {
    await expect(service().handle({ action: 'command', id: issue.id, commandId: 'command-2', expectedVersion: 1,
      role: 'super_admin', command: { type: 'triage', assigneeId: 'member-2', qaOwnerId: 'member-1', severity: 'high', priority: 1, dueDate: null } }))
      .rejects.toMatchObject({ code: 'qa_forbidden' });
    expect(calls.some(c => c.url.pathname.endsWith('/livo_qa_commit'))).toBe(false);
  });
});

describe('Docker QA replay and concurrency', () => {
  it('returns the original response on retry even after the issue changed', async () => {
    const request = { action: 'create', id: 'issue-1', commandId: 'command-3', input };
    const original = fixture(); issue = { ...issue, state: 'closed', version: 8 };
    receipt = { actor_id: 'member-1', issue_id: 'issue-1', payload_hash: await qaPayloadHash(request), response: original };
    expect(await service().handle(request)).toEqual(original);
    expect(calls.some(c => c.url.pathname.endsWith('/livo_qa_commit'))).toBe(false);
  });
  it('rejects command ID reuse with changed content', async () => {
    receipt = { actor_id: 'member-1', issue_id: 'issue-1', payload_hash: 'different', response: issue };
    await expect(service().handle({ action: 'comment', id: issue.id, commandId: 'command-4', body: 'edited retry' }))
      .rejects.toMatchObject({ code: 'qa_command_id_reused', status: 409 });
  });
  it('rejects stale expectedVersion before attempting a mutation', async () => {
    await expect(service().handle({ action: 'command', id: issue.id, commandId: 'command-5', expectedVersion: 2, command: { type: 'hold', reason: 'Wait' } }))
      .rejects.toMatchObject({ code: 'qa_version_conflict', status: 409 });
  });
  it('surfaces a database CAS conflict that occurred after the initial read', async () => {
    rpcError = { code: '40001', message: 'version_conflict' };
    await expect(service().handle({ action: 'command', id: issue.id, commandId: 'command-6', expectedVersion: 1, command: { type: 'hold', reason: 'Wait' } }))
      .rejects.toMatchObject({ code: 'qa_version_conflict', status: 409 });
  });
  it('hashes equivalent JSON key order consistently', async () => {
    expect(await qaPayloadHash({ a: [1, { z: 'x', b: false }], c: null })).toBe(await qaPayloadHash({ c: null, a: [1, { b: false, z: 'x' }] }));
  });
});

describe('Docker QA private evidence', () => {
  it.each([
    { fileName: '../escape.mp4', mimeType: 'video/mp4', size: 10 },
    { fileName: 'unsafe.html', mimeType: 'text/html', size: 10 },
    { fileName: 'large.mp4', mimeType: 'video/mp4', size: 200 * 1024 * 1024 + 1 },
  ])('refuses invalid uploads before creating a reservation: $fileName', async upload => {
    await expect(service().handle({ action: 'upload_init', id: issue.id, ...upload })).rejects.toMatchObject({ code: 'qa_invalid_file' });
    expect(calls.some(c => c.method === 'POST')).toBe(false);
  });
  it('returns only a scoped signed upload capability with a private deterministic path', async () => {
    const upload = await service().handle({ action: 'upload_init', id: issue.id, fileName: 'proof.mp4', mimeType: 'video/mp4', size: 200 * 1024 * 1024 });
    expect(upload).toMatchObject({ provider: 'supabase', bucket: 'qa-evidence', partSize: 0, token: 'limited-capability' });
    expect(upload.path).toBe(`default/${issue.id}/${upload.id}`);
    expect(JSON.stringify(upload)).not.toContain('server-secret');
  });
  it('does not accept caller metadata to bypass storage finalization', async () => {
    rpcError = { code: '22023', message: 'upload_metadata_mismatch' };
    await expect(service().handle({ action: 'upload_complete', uploadId: 'upload-1', size: 10, mimeType: 'image/png' }))
      .rejects.toMatchObject({ code: 'qa_upload_metadata_mismatch' });
    expect(calls.find(c => c.url.pathname.endsWith('/livo_qa_finalize_upload'))?.body).toEqual({ p_auth_id: AUTH, p_upload_id: 'upload-1' });
  });
});

const emptyBackup = (): Record<string, Record<string, unknown>[]> => Object.fromEntries(
  ['qa_issues', 'qa_commands', 'qa_events', 'qa_comments', 'qa_uploads', 'qa_attachments', 'qa_slack_links']
    .map((t): [string, Record<string, unknown>[]] => [t, []]));
const issueRow = (data = fixture()) => ({ id: data.id, workspace_id: 'default', project_id: data.projectId, state: data.state,
  reporter_id: data.reporterId, assignee_id: data.assigneeId, qa_owner_id: data.qaOwnerId, title: data.title, version: data.version, updated_at: data.updatedAt, data });
describe('Docker QA restore preflight', () => {
  it('accepts a valid own-workspace snapshot', () => {
    const backup = { ...emptyBackup(), qa_issues: [issueRow()] };
    expect(validateQaBackup(backup)).toBe(backup);
  });
  it('round-trips manually closed/dismissed issues and historical custom values without fabricated resolutions',()=>{
    for(const state of ['closed','dismissed'] as const){
      issue={...issue,state,closedAt:context.now,closedBy:'member-1',resolution:null,customFields:{disabled:'Historical',flag:false}};
      const backup={...emptyBackup(),qa_issues:[issueRow()]};
      expect(validateQaBackup(backup)).toBe(backup);
    }
  });
  it.each([
    () => ({ ...emptyBackup(), qa_issues: [issueRow({ ...fixture(), workspaceId: 'another' })] }),
    () => ({ ...emptyBackup(), qa_issues: [issueRow({ ...fixture(), version: 0 })] }),
    () => ({ ...emptyBackup(), qa_issues: [issueRow({ ...fixture(), targets: [null] } as unknown as QaIssue)] }),
    () => ({ ...emptyBackup(), qa_issues: [issueRow(), issueRow()] }),
    () => ({ ...emptyBackup(), qa_attachments: [{ id: 'f1', workspace_id: 'default', issue_id: 'issue-1', uploaded_by: 'member-1',
      file_name: 'x.png', mime_type: 'image/png', size: 10, created_at: context.now, storage_path: 'another/private-file' }] }),
  ])('rejects corrupted or cross-workspace JSON before the restore RPC', make => expect(() => validateQaBackup(make())).toThrow('qa_invalid_backup'));
  it('requires a superadmin for restoring even when ordinary members can report bugs', async () => {
    await expect(service().handle({ action: 'restore', tables: emptyBackup() })).rejects.toMatchObject({ code: 'qa_forbidden' });
  });
  it('defaults to validation only', async () => {
    role = 'super_admin';
    expect(await service().handle({ action: 'restore', tables: emptyBackup() })).toMatchObject({ validateOnly: true, inserted: 0 });
  });
});

describe('Docker QA upgrade contract', () => {
  const sql = fs.readFileSync(path.resolve(__dirname, '../../supabase/migrations/20261002_qa_workflow.sql'), 'utf8');
  it('passes the non-destructive idempotent release migration lint', () => expect(lintUpgradeMigration(makeIdempotent(sql))).toEqual([]));
  it('keeps client access closed and commit/finalization/restore service-only', () => {
    expect(sql).toContain('REVOKE ALL ON TABLE public.%I FROM anon, authenticated');
    for (const fn of ['livo_qa_commit(uuid,text,text,text,integer,text,jsonb,jsonb)', 'livo_qa_finalize_upload(uuid,text)', 'livo_qa_restore(uuid,jsonb,boolean)'])
      expect(sql).toContain(`REVOKE ALL ON FUNCTION public.${fn} FROM PUBLIC,anon,authenticated`);
    expect(sql).toContain('receipt.payload_hash<>p_payload_hash');
    expect(sql).toContain("workspace_id='default' FOR UPDATE");
    expect(sql).toContain('jsonb_array_length(conflicts)=0 AND jsonb_array_length(missing_assets)=0');
    expect(sql).toContain("obj.metadata->>'size'");
    expect(sql).toContain("obj.metadata->>'mimetype'");
  });
});

describe('Docker QA workflow settings migration', () => {
  const sql = fs.readFileSync(path.resolve(__dirname, '../../supabase/migrations/20261002_qa_workflow_settings.sql'), 'utf8');
  it('is a separate non-destructive, repeatable upgrade', () => expect(lintUpgradeMigration(makeIdempotent(sql))).toEqual([]));
  it('rechecks the live role and feature gate and forbids direct authenticated writes', () => {
    expect(sql).toContain("role::text IN ('admin','super_admin')");
    expect(sql).toContain('is_active=true');
    expect(sql).toContain("pg_advisory_xact_lock(hashtext('livo-qa-feature'))");
    expect(sql).toContain('IF NOT public.livo_qa_enabled()');
    expect(sql).toContain("current_user IN ('anon','authenticated')");
    expect(sql).toContain('REVOKE ALL ON FUNCTION public.livo_qa_save_workflow(uuid,jsonb) FROM PUBLIC,anon,authenticated');
    expect(sql).not.toMatch(/UPDATE public\.qa_issues|INSERT INTO public\.qa_issues/);
  });
});
