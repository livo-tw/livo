// @vitest-environment node
import { afterEach, expect, it, vi } from 'vitest';
import { createQaService } from '../../docker/volumes/functions/qa/service';
import { createQaIssue } from '@/lib/qa/domain';

vi.mock('../../docker/volumes/functions/qa/slackSync.ts', () => ({ syncQaSlackIssue: vi.fn() }));
afterEach(() => vi.unstubAllGlobals());

it('classifies only the external profile directory IDs and keeps an eqa-looking internal member internal', async () => {
  const auth = '11111111-1111-4111-8111-111111111111';
  const selected: string[] = [];
  const profile = { external: true, id: 'visitor', name: 'Example visitor', qaEnabled: true, environments: ['Stage'], projects: [] as never[],
    members: [{ id: 'visitor', name: 'Example visitor', jobTitle: '' }, { id: 'eqa-internal', name: 'Example engineer', jobTitle: '' }] };
  vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    if (url.pathname === '/auth/v1/user') return Response.json({ id: auth, app_metadata: { livo_external_qa_password_change_required: false } });
    if (url.pathname === '/rest/v1/system_settings') return Response.json([{ value: { qa: true } }]);
    if (url.pathname === '/rest/v1/external_qa_accounts') return Response.json([{ id: 'visitor', name: 'Example visitor', is_active: true }]);
    if (url.pathname === '/rest/v1/members') {
      if (url.searchParams.has('auth_id')) return Response.json([]);
      expect(url.searchParams.get('select')).toBe('id');
      selected.push(url.searchParams.get('id')!);
      return Response.json([{ id: 'eqa-internal' }, { id: 'unrelated-internal' }]);
    }
    if (url.pathname.endsWith('/livo_qa_external_read')) {
      expect(JSON.parse(String(init?.body))).toMatchObject({ p_auth_id: auth, p_action: 'profile' });
      return Response.json(profile);
    }
    throw new Error('Unexpected endpoint');
  }));
  const env = { get: (name: string) => ({ SUPABASE_URL: 'https://example.test', SUPABASE_ANON_KEY: 'example-anon', SUPABASE_SERVICE_ROLE_KEY: 'example-service' } as Record<string, string>)[name] };
  const result = await createQaService(env, 'example-session').handle({ action: 'external_profile' });
  expect(selected).toEqual(['in.(visitor,eqa-internal)']);
  expect(result.members).toEqual([{ ...profile.members[0], isExternal: true }, { ...profile.members[1], isExternal: false }]);
  expect(result.members).toHaveLength(2);
  expect(profile.members.every(person => person.jobTitle === '')).toBe(true);
});

it('returns external detail profiles only for actual authorized participants, never arbitrary label-map entries', async () => {
  const auth = '11111111-1111-4111-8111-111111111111';
  const issue = createQaIssue({ projectId: 'example-project', title: 'Example issue', actual: 'Example result', observedEnvironment: 'Stage' }, 'example-issue', {
    actor: { id: 'visitor', role: 'member' }, workspaceId: 'default', now: '2026-11-09T00:00:00Z', newId: () => 'example-id',
    memberIds: new Set(['visitor']), projectIds: new Set(['example-project']), taskIds: new Set(),
  });
  const lookedUp: string[] = [];
  vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => {
    const url = new URL(String(input));
    if (url.pathname === '/auth/v1/user') return Response.json({ id: auth, app_metadata: { livo_external_qa_password_change_required: false } });
    if (url.pathname === '/rest/v1/system_settings') return Response.json([{ value: { qa: true } }]);
    if (url.pathname === '/rest/v1/members') return Response.json([]);
    if (url.pathname === '/rest/v1/external_qa_accounts') {
      if (url.searchParams.has('id')) { lookedUp.push(url.searchParams.get('id')!); expect(url.searchParams.get('select')).toBe('id,name'); }
      return Response.json([{ id: 'visitor', name: 'Historical visitor', is_active: true }]);
    }
    if (url.pathname.endsWith('/livo_qa_external_read')) return Response.json({ issue, comments: [], events: [], attachments: [], memberNames: { visitor: 'Historical visitor', unrelated: 'Unrelated person' } });
    throw new Error('Unexpected endpoint');
  }));
  const env = { get: (name: string) => ({ SUPABASE_URL: 'https://example.test', SUPABASE_ANON_KEY: 'example-anon', SUPABASE_SERVICE_ROLE_KEY: 'example-service' } as Record<string, string>)[name] };
  const result = await createQaService(env, 'example-session').handle({ action: 'get', id: issue.id });
  expect(lookedUp).toEqual([]);
  expect(result.memberProfiles).toEqual({ visitor: { name: 'Historical visitor', isExternal: true } });
  expect(result.memberNames).toEqual({ visitor: 'Historical visitor', unrelated: 'Unrelated person' });
  expect(result.memberProfiles).not.toHaveProperty('unrelated');
});

it('rejects a denied external detail before any participant metadata lookup', async () => {
  let directoryReads = 0;
  vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => {
    const url = new URL(String(input));
    if (url.pathname === '/auth/v1/user') return Response.json({ id: '11111111-1111-4111-8111-111111111111', app_metadata: { livo_external_qa_password_change_required: false } });
    if (url.pathname === '/rest/v1/system_settings') return Response.json([{ value: { qa: true } }]);
    if (url.pathname === '/rest/v1/members') {
      if (url.searchParams.has('auth_id')) return Response.json([]);
      directoryReads++; return Response.json([]);
    }
    if (url.pathname === '/rest/v1/external_qa_accounts') return Response.json([{ id: 'visitor', name: 'Example visitor', is_active: true }]);
    if (url.pathname.endsWith('/livo_qa_external_read')) return Response.json({ code: '42501', message: 'qa_forbidden' }, { status: 403 });
    throw new Error('Unexpected endpoint');
  }));
  const env = { get: (name: string) => ({ SUPABASE_URL: 'https://example.test', SUPABASE_ANON_KEY: 'example-anon', SUPABASE_SERVICE_ROLE_KEY: 'example-service' } as Record<string, string>)[name] };
  await expect(createQaService(env, 'example-session').handle({ action: 'get', id: 'forbidden-issue' }))
    .rejects.toMatchObject({ code: 'qa_forbidden', status: 403 });
  expect(directoryReads).toBe(0);
});
