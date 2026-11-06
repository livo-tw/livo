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
let roster: Row[];
let calls: Array<{ path: string; query: URLSearchParams; body: Row | undefined }>;
beforeEach(() => {
  card = issue(); active = true; missingIssue = false;
  roster = [external, { id: 'unrelated-visitor', name: 'Unrelated person' },
    { id: internal.id, name: 'Wrong external label' }];
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
      return json([internal]);
    }
    if (path === '/rest/v1/qa_issues') return json(missingIssue ? [] : [{ data: card }]);
    if (path === '/rest/v1/rpc/livo_qa_external_roster') return json(roster);
    if (path === '/rest/v1/projects') return json([{ id: projectId, name: 'Example project', is_archived: false }]);
    if (path === '/rest/v1/qa_project_coordination' ||
      ['/rest/v1/qa_comments', '/rest/v1/qa_events', '/rest/v1/qa_attachments'].includes(path)) return json([]);
    throw new Error('Unexpected read: ' + path);
  }));
});
afterEach(() => vi.unstubAllGlobals());

describe('Canonical Docker QA detail member labels', () => {
  it('resolves a granted external owner from the issue project roster without overriding an internal ID prefix', async () => {
    const detail = await createQaService(env, 'normal-example-session').handle({ action: 'get', id: card.id });
    expect(detail.memberNames).toEqual({ [internal.id]: internal.name, [external.id]: external.name });
    expect(calls.filter(c => c.path.endsWith('/livo_qa_external_roster'))).toEqual([
      expect.objectContaining({ body: { p_project_id: projectId } }),
    ]);
    expect(calls.some(c => c.path === '/rest/v1/external_qa_accounts')).toBe(false);
    expect(detail.memberNames).not.toHaveProperty('unrelated-visitor');
  });
  it('does not invent a label when the project roster no longer authorizes the external owner', async () => {
    roster = [{ id: 'other-project-visitor', name: 'Another project' }];
    const detail = await createQaService(env, 'normal-example-session').handle({ action: 'get', id: card.id });
    expect(detail.memberNames).toEqual({ [internal.id]: internal.name });
  });
  it('keeps ordinary internal details independent of the external roster', async () => {
    card = { ...card, assigneeId: internal.id };
    const detail = await createQaService(env, 'normal-example-session').handle({ action: 'get', id: card.id });
    expect(detail.memberNames).toEqual({ [internal.id]: internal.name });
    expect(calls.some(c => c.path.endsWith('/livo_qa_external_roster'))).toBe(false);
  });
  it('does not read any roster for an inactive caller', async () => {
    active = false;
    await expect(createQaService(env, 'normal-example-session').handle({ action: 'get', id: card.id }))
      .rejects.toMatchObject({ code: 'qa_forbidden', status: 403 });
    expect(calls.some(c => c.path.endsWith('/livo_qa_external_roster'))).toBe(false);
  });
  it('does not resolve names for an unreadable issue', async () => {
    missingIssue = true;
    await expect(createQaService(env, 'normal-example-session').handle({ action: 'get', id: card.id }))
      .rejects.toMatchObject({ code: 'qa_issue_not_found', status: 404 });
    expect(calls.some(c => c.path.endsWith('/livo_qa_external_roster'))).toBe(false);
  });
});
