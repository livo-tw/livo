// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createQaService } from '../../docker/volumes/functions/qa/service';
import { createQaIssue, type QaIssue } from '../lib/qa/domain';

vi.mock('../../docker/volumes/functions/qa/slackSync.ts', () => ({ syncQaSlackIssue: vi.fn() }));
const AUTH = '11111111-1111-4111-8111-111111111111';
const env = { get: (key: string): string => ({ SUPABASE_URL: 'https://example.test', SUPABASE_ANON_KEY: 'example-anon',
  SUPABASE_SERVICE_ROLE_KEY: 'example-service-role' } as Record<string, string>)[key] || '' };
type Person = { id: string; name: string; [key: string]: unknown };
type Call = { path: string; query: URLSearchParams; body: Record<string, unknown> };
function makeIssue(id: string, projectId: string, qaOwnerId: string | null, assigneeId: string | null = 'member-example'): QaIssue {
  return { ...createQaIssue({ projectId, title: 'Example issue', actual: 'Example failure', observedEnvironment: 'Stage' }, id, {
    actor: { id: 'member-example', role: 'member' }, workspaceId: 'default', now: '2026-11-09T00:00:00Z', newId: () => 'example',
    memberIds: new Set(['member-example']), projectIds: new Set([projectId]), taskIds: new Set(),
  }), qaOwnerId, assigneeId };
}

let calls: Call[], issues: QaIssue[], internal: Person[], rosters: Record<string, Person[]>;
let external: boolean, denied: boolean;
beforeEach(() => {
  calls = []; external = false; denied = false;
  issues = [makeIssue('issue-a', 'project-a', 'eqa-tester-a'), makeIssue('issue-b', 'project-a', 'eqa-tester-a'),
    makeIssue('issue-c', 'project-b', 'eqa-tester-b')];
  internal = [{ id: 'member-example', name: 'Example engineer', email: 'engineer@example.com', auth_id: AUTH, role: 'member' }];
  rosters = {
    'project-a': [{ id: 'eqa-tester-a', name: 'Example tester A', is_active: true }, { id: 'eqa-unrelated', name: 'Unrelated tester', is_active: true }],
    'project-b': [{ id: 'eqa-tester-b', name: 'Example tester B', is_active: true }],
  };
  vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(String(input)), body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : {};
    calls.push({ path: url.pathname, query: url.searchParams, body });
    const json = (value: unknown, status = 200, headers: Record<string, string> = {}) => Response.json(value, { status, headers });
    if (url.pathname === '/auth/v1/user') return json({ id: AUTH, app_metadata: { livo_external_qa_password_change_required: false } });
    if (url.pathname === '/rest/v1/system_settings') return json([{ value: { qa: true } }]);
    if (url.pathname === '/rest/v1/members') {
      if (url.searchParams.has('auth_id')) return json(external ? [] : [{ id: 'member-example', role: 'member', is_active: true, auth_id: AUTH }]);
      const ids = (url.searchParams.get('id') || '').slice(4, -1).split(',');
      return json(internal.filter(person => ids.includes(person.id)));
    }
    if (url.pathname === '/rest/v1/external_qa_accounts') {
      expect(url.searchParams.has('auth_id')).toBe(true);
      return json([{ id: 'eqa-caller', name: 'Example external caller', is_active: true }]);
    }
    if (url.pathname === '/rest/v1/qa_issues') return json(issues.map(data => ({ data })), 200, { 'Content-Range': '0-2/8' });
    if (url.pathname === '/rest/v1/rpc/livo_qa_external_read') {
      expect(body.p_action).toBe('list');
      return denied ? json({ code: '42501', message: 'qa_forbidden' }, 403) : json({ issues, total: 8, hasMore: true });
    }
    if (url.pathname === '/rest/v1/rpc/livo_qa_external_roster') return json(rosters[String(body.p_project_id)] || []);
    throw new Error('unexpected endpoint');
  }));
});
afterEach(() => vi.unstubAllGlobals());
const service = () => createQaService(env, 'example-member-session');
const rosterCalls = () => calls.filter(call => call.path.endsWith('/livo_qa_external_roster'));

describe('QA list participant display labels', () => {
  it('batches labels by the actual page projects and preserves pagination without exposing unrelated people', async () => {
    const result = await service().handle({ action: 'list', input: { projectIds: ['project-a', 'project-b', 'project-hidden'] } });
    expect(result).toMatchObject({ issues, total: 8, hasMore: true, memberNames: {
      'member-example': 'Example engineer', 'eqa-tester-a': 'Example tester A', 'eqa-tester-b': 'Example tester B',
    } });
    expect(rosterCalls()).toHaveLength(2);
    expect(rosterCalls().map(call => call.body.p_project_id).sort()).toEqual(['project-a', 'project-b']);
    expect(result.memberNames).not.toHaveProperty('eqa-unrelated');
    expect(Object.keys(result.memberNames)).toHaveLength(3);
    expect(result).not.toHaveProperty('members');
    expect(JSON.stringify(result.memberNames)).not.toMatch(/email|auth_id|role/);
    const labelCall = calls.find(call => call.path === '/rest/v1/members' && call.query.has('id'))!;
    expect(labelCall.query.get('select')).toBe('id,name');
    expect(labelCall.query.get('limit')).toBe('3');
    expect(labelCall.query.get('id')).toBe('in.(member-example,eqa-tester-a,eqa-tester-b)');
  });

  it('finishes the external page authorization before looking up only its returned participant references', async () => {
    external = true;
    issues = [makeIssue('issue-a', 'project-a', 'eqa-tester-a')];
    const result = await service().handle({ action: 'list', input: { projectIds: ['project-a', 'project-hidden'] } });
    expect(result.memberNames).toEqual({ 'member-example': 'Example engineer', 'eqa-tester-a': 'Example tester A' });
    expect(calls.some(call => call.path === '/rest/v1/qa_issues')).toBe(false);
    const authorization = calls.findIndex(call => call.path.endsWith('/livo_qa_external_read'));
    expect(calls.findIndex(call => call.path === '/rest/v1/members' && call.query.has('id'))).toBeGreaterThan(authorization);
    expect(calls.findIndex(call => call.path.endsWith('/livo_qa_external_roster'))).toBeGreaterThan(authorization);
    expect(rosterCalls().map(call => call.body.p_project_id)).toEqual(['project-a']);
  });

  it('does not load participant metadata when the external list is rejected', async () => {
    external = true; denied = true;
    await expect(service().handle({ action: 'list' })).rejects.toMatchObject({ code: 'qa_forbidden', status: 403 });
    expect(rosterCalls()).toEqual([]);
    expect(calls.some(call => call.path === '/rest/v1/members' && call.query.has('id'))).toBe(false);
  });

  it('keeps internal members authoritative regardless of id prefixes', async () => {
    issues = [makeIssue('issue-a', 'project-a', 'eqa-internal', 'member-example')];
    internal.push({ id: 'eqa-internal', name: 'Example internal QA' });
    rosters['project-a'].push({ id: 'eqa-internal', name: 'Wrong external label' });
    const result = await service().handle({ action: 'list' });
    expect(result.memberNames).toEqual({ 'member-example': 'Example engineer', 'eqa-internal': 'Example internal QA' });
    expect(rosterCalls()).toEqual([]);
  });

  it('keeps missing or revoked labels unknown and filters roster labels to the matching project references', async () => {
    issues = [makeIssue('issue-a', 'project-a', 'eqa-revoked'), makeIssue('issue-b', 'project-b', 'eqa-tester-b')];
    rosters['project-a'].push({ id: 'eqa-tester-b', name: 'Wrong project label' });
    rosters['project-b'] = [];
    const result = await service().handle({ action: 'list' });
    expect(result.memberNames).toEqual({ 'member-example': 'Example engineer' });
    expect(result.memberNames).not.toHaveProperty('eqa-revoked');
    expect(result.memberNames).not.toHaveProperty('eqa-tester-b');
    expect(rosterCalls()).toHaveLength(2);
  });

  it.each([false, true])('skips directories for an empty page or unassigned cards (external caller: %s)', async isExternal => {
    external = isExternal;
    for (const page of [[], [makeIssue('issue-a', 'project-a', null, null)]]) {
      issues = page; calls = [];
      const result = await service().handle({ action: 'list' });
      expect(result.memberNames).toEqual({});
      expect(rosterCalls()).toEqual([]);
      expect(calls.some(call => call.path === '/rest/v1/members' && call.query.has('id'))).toBe(false);
    }
  });
});
