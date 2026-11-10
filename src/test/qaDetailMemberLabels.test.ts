// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createQaService } from '../../docker/volumes/functions/qa/service';
import { createQaIssue } from '../lib/qa/domain';

vi.mock('../../docker/volumes/functions/qa/slackSync.ts', () => ({ syncQaSlackIssue: vi.fn() }));

const authId = '11111111-1111-4111-8111-111111111111';
const projectId = 'project-example';
const internal = { id: 'eqa-internal-owner', name: 'Example internal QA' };
const external = { id: 'visitor-fixer', name: 'Example external RD', is_active: true };
const issue = () => createQaIssue({ projectId, title: 'Example report', actual: 'Example result',
  observedEnvironment: 'Stage', assigneeId: external.id, qaOwnerId: internal.id }, 'issue-example', {
  actor: { id: 'member-caller', role: 'member' }, workspaceId: 'default', now: '2026-11-06T00:00:00Z',
  newId: () => 'unused', memberIds: new Set(['member-caller', internal.id, external.id]),
  projectIds: new Set([projectId]), taskIds: new Set<string>(),
});
const settings: Record<string, string> = { SUPABASE_URL: 'http://backend.example.com',
  SUPABASE_ANON_KEY: 'anon-example', SUPABASE_SERVICE_ROLE_KEY: 'service-example' };
const env = { get: (name: string) => settings[name] };
const json = (value: unknown) => new Response(JSON.stringify(value), { status: 200,
  headers: { 'Content-Type': 'application/json' } });

type Row = Record<string, unknown>;
let card = issue(), active = true, missingIssue = false;
let labels: Row[], comments: Row[], events: Row[], attachments: Row[];
let calls: Array<{ path: string; query: URLSearchParams; body: Row | undefined }>;
beforeEach(() => {
  card = issue(); active = true; missingIssue = false;
  labels = [external, { id: 'unrelated-visitor', name: 'Unrelated person' },
    { id: internal.id, name: 'Wrong external label' }];
  comments = []; events = []; attachments = [];
  calls = [];
  vi.stubGlobal('fetch', vi.fn(async (input: string, init: RequestInit = {}) => {
    const url = new URL(input), path = url.pathname;
    const body = init.body ? JSON.parse(String(init.body)) as Row : undefined;
    calls.push({ path, query: url.searchParams, body });
    if (path === '/auth/v1/user') return json({ id: authId, user_metadata: {}, app_metadata: {} });
    if (path === '/rest/v1/system_settings') return json([{ value: { qa: true } }]);
    if (path === '/rest/v1/members') {
      if (url.searchParams.has('auth_id')) return json([{ id: 'member-caller', role: 'member',
        auth_id: authId, is_active: active, is_qa_admin: false }]);
      const ids = (url.searchParams.get('id') || '').slice(4, -1).split(',');
      return json([internal, { id: 'member-caller', name: 'Example reporter' }].filter(person => ids.includes(person.id)));
    }
    if (path === '/rest/v1/qa_issues') return json(missingIssue ? [] : [{ data: card }]);
    if (path === '/rest/v1/external_qa_accounts') {
      expect(url.searchParams.get('select')).toBe('id,name');
      expect(url.searchParams.get('limit')).toBe('100');
      const ids = (url.searchParams.get('id') || '').slice(4, -1).split(',');
      return json(labels.filter(person => ids.includes(String(person.id))));
    }
    if (path === '/rest/v1/projects') return json([{ id: projectId, name: 'Example project', is_archived: false }]);
    if (path === '/rest/v1/qa_comments') return json(comments);
    if (path === '/rest/v1/qa_events') return json(events);
    if (path === '/rest/v1/qa_attachments') return json(attachments);
    if (path === '/rest/v1/qa_project_coordination') return json([]);
    throw new Error('Unexpected read: ' + path);
  }));
});
afterEach(() => vi.unstubAllGlobals());

describe('Canonical Docker QA detail member labels', () => {
  it('resolves an actual external owner without overriding an internal ID prefix', async () => {
    const detail = await createQaService(env, 'normal-example-session').handle({ action: 'get', id: card.id });
    expect(detail.memberNames).toEqual({ [internal.id]: internal.name, [external.id]: external.name, 'member-caller': 'Example reporter' });
    const lookup = calls.filter(c => c.path === '/rest/v1/external_qa_accounts');
    expect(lookup).toHaveLength(1);
    expect(lookup[0].query.get('id')).toBe(`in.(${external.id})`);
    expect(detail.memberNames).not.toHaveProperty('unrelated-visitor');
  });
  it('does not invent a label when the referenced external account is unavailable', async () => {
    labels = [{ id: 'other-project-visitor', name: 'Another project' }];
    const detail = await createQaService(env, 'normal-example-session').handle({ action: 'get', id: card.id });
    expect(detail.memberNames).toEqual({ [internal.id]: internal.name, 'member-caller': 'Example reporter' });
  });
  it('keeps ordinary internal details independent of the external roster', async () => {
    card = { ...card, assigneeId: internal.id };
    const detail = await createQaService(env, 'normal-example-session').handle({ action: 'get', id: card.id });
    expect(detail.memberNames).toEqual({ [internal.id]: internal.name, 'member-caller': 'Example reporter' });
    expect(calls.some(c => c.path === '/rest/v1/external_qa_accounts')).toBe(false);
  });
  it('keeps an external reporter and historical authors named after responsibility moves internally', async () => {
    card = { ...card, assigneeId: internal.id, reporterId: 'eqa-former-reporter', closedBy: 'eqa-closer',
      targets: [{ id: 'target-example', environment: 'Stage', component: '', build: 'example-build', required: true,
        deployedAt: '2026-11-06T01:00:00Z', deployedBy: 'eqa-deployer', deploymentEvidence: '' }],
      runs: [{ id: 'run-example', sequence: 1, fixCycle: 1, targetId: 'target-example', environment: 'Stage', component: '',
        build: 'example-build', result: 'pass', note: '', testerId: 'eqa-verifier', createdAt: '2026-11-06T02:00:00Z' }],
    };
    comments = [{ id: 'comment-example', issue_id: card.id, actor_id: 'eqa-commenter', body: 'Example comment', created_at: card.createdAt }];
    events = [{ id: 'event-example', issue_id: card.id, actor_id: 'eqa-historian', type: 'update_fields', version: 2,
      detail: JSON.stringify({ before: { qaOwnerId: 'eqa-old-owner' }, after: { qaOwnerId: internal.id } }), created_at: card.createdAt }];
    attachments = [{ id: 'file-example', issue_id: card.id, uploaded_by: 'eqa-uploader', file_name: 'example.txt', mime_type: 'text/plain', size: 1, created_at: card.createdAt }];
    const refs = ['eqa-former-reporter', 'eqa-closer', 'eqa-deployer', 'eqa-verifier', 'eqa-commenter', 'eqa-historian', 'eqa-old-owner', 'eqa-uploader'];
    labels = refs.map((id, index) => ({ id, name: `Historical example ${index}`, is_active: false }));
    labels.push({ id: 'eqa-unrelated', name: 'Unrelated account' });
    const before = JSON.stringify({ card, comments, events, attachments });
    const detail = await createQaService(env, 'normal-example-session').handle({ action: 'get', id: card.id });
    expect(detail.memberNames).toEqual({ [internal.id]: internal.name, ...Object.fromEntries(labels.filter(person => refs.includes(String(person.id))).map(person => [person.id, person.name])) });
    expect(detail.memberProfiles[internal.id]).toEqual({ name: internal.name, isExternal: false });
    for (const id of refs) expect(detail.memberProfiles[id]).toEqual({ name: labels.find(person => person.id === id)!.name, isExternal: true });
    expect(detail.memberProfiles).not.toHaveProperty('eqa-unrelated');
    expect(detail.memberNames).not.toHaveProperty('eqa-unrelated');
    expect(JSON.stringify({ card, comments, events, attachments })).toBe(before);
    const labelRead = calls.findIndex(call => call.path === '/rest/v1/external_qa_accounts');
    expect(labelRead).toBeGreaterThan(calls.findIndex(call => call.path === '/rest/v1/qa_issues'));
    expect(labelRead).toBeGreaterThan(calls.findIndex(call => call.path === '/rest/v1/qa_comments'));
    expect(calls.filter(call => call.path === '/rest/v1/external_qa_accounts')).toHaveLength(1);
  });
  it('does not read any roster for an inactive caller', async () => {
    active = false;
    await expect(createQaService(env, 'normal-example-session').handle({ action: 'get', id: card.id }))
      .rejects.toMatchObject({ code: 'qa_forbidden', status: 403 });
    expect(calls.some(c => c.path === '/rest/v1/external_qa_accounts')).toBe(false);
  });
  it('does not resolve names for an unreadable issue', async () => {
    missingIssue = true;
    await expect(createQaService(env, 'normal-example-session').handle({ action: 'get', id: card.id }))
      .rejects.toMatchObject({ code: 'qa_issue_not_found', status: 404 });
    expect(calls.some(c => c.path === '/rest/v1/external_qa_accounts')).toBe(false);
  });
});
