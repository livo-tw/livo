// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createQaService } from '../../docker/volumes/functions/qa/service';

vi.mock('../../docker/volumes/functions/qa/slackSync.ts', () => ({ syncQaSlackIssue: vi.fn() }));
const authId = '11111111-1111-4111-8111-111111111111';
const config: Record<string, string> = { SUPABASE_URL: 'https://example.test', SUPABASE_ANON_KEY: 'example-anon', SUPABASE_SERVICE_ROLE_KEY: 'example-service' };
const env = { get: (key: string): string | undefined => config[key] };
let external: boolean, active: boolean, freshDenied: boolean;
let calls: Array<{ path: string; body: Record<string, unknown> }>;
beforeEach(() => {
  external = false; active = true; freshDenied = false; calls = [];
  vi.stubGlobal('fetch', vi.fn(async (input: string, init: RequestInit = {}): Promise<Response> => {
    const path = new URL(input).pathname, body = init.body ? JSON.parse(String(init.body)) as Record<string, unknown> : {};
    calls.push({ path, body });
    if (path === '/auth/v1/user') return Response.json({ id: authId, app_metadata: { livo_external_qa_password_change_required: false } });
    if (path === '/rest/v1/members') return Response.json(external ? [] : [{ id: 'member-example', role: 'member', auth_id: authId, is_active: active }]);
    if (path === '/rest/v1/external_qa_accounts') return Response.json([{ id: 'eqa-example', name: 'Example tester', is_active: true }]);
    if (path === '/rest/v1/system_settings') return Response.json([{ value: { qa: true } }]);
    if (path === '/rest/v1/rpc/livo_qa_filter_people') return freshDenied
      ? Response.json({ code: '42501', message: 'qa_forbidden' }, { status: 403 })
      : Response.json({ members: [{ id: 'eqa-example', name: 'Example tester', isActive: false }], hasMore: false });
    throw new Error('Unexpected endpoint');
  }));
});
afterEach(() => vi.unstubAllGlobals());
const service = () => createQaService(env, 'example-session');

describe('QA historical filter display directory', () => {
  it.each<{ projectIds?: string[] }>([{ projectIds: undefined }, { projectIds: [] }, { projectIds: ['project-example'] }])('forwards the verified caller and exact project scope $projectIds', async ({ projectIds }) => {
    const result = await service().handle({ action: 'filter_people', projectIds, offset: 100,
      actorId: 'spoofed-member', authId: 'spoofed-login', workspaceId: 'other-workspace' });
    expect(result).toEqual({ members: [{ id: 'eqa-example', name: 'Example tester', isActive: false }], hasMore: false });
    expect(calls.find(call => call.path.endsWith('/livo_qa_filter_people'))!.body).toEqual({
      p_auth_id: authId, p_project_ids: projectIds === undefined ? null : projectIds, p_offset: 100,
    });
    expect(calls.some(call => call.path === '/rest/v1/qa_issues' || call.path.endsWith('/livo_qa_external_roster'))).toBe(false);
  });
  it.each<{ projectIds: unknown }>([{ projectIds: null }, { projectIds: 'project-example' }, { projectIds: ['project-example', 'project-example'] }, { projectIds: ['unsafe,project'] }])('rejects unsafe project scope $projectIds before the directory RPC', async ({ projectIds }) => {
    await expect(service().handle({ action: 'filter_people', projectIds })).rejects.toMatchObject({ status: 400 });
    expect(calls.some(call => call.path.endsWith('/livo_qa_filter_people'))).toBe(false);
  });
  it('does not let an external principal request the internal historical directory', async () => {
    external = true;
    await expect(service().handle({ action: 'filter_people' })).rejects.toMatchObject({ code: 'qa_forbidden', status: 403 });
    expect(calls.some(call => call.path.startsWith('/rest/v1/rpc/'))).toBe(false);
  });
  it('rejects inactive callers and propagates a fresh database identity rejection', async () => {
    active = false;
    await expect(service().handle({ action: 'filter_people' })).rejects.toMatchObject({ code: 'qa_forbidden', status: 403 });
    expect(calls.some(call => call.path.endsWith('/livo_qa_filter_people'))).toBe(false);
    active = true; freshDenied = true;
    await expect(service().handle({ action: 'filter_people' })).rejects.toMatchObject({ code: 'qa_forbidden', status: 403 });
  });
});
