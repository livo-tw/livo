// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import { deliveryStore, recipientCanRead } from '../../docker/volumes/functions/slack-deliver/backend';
import { deliverJob, type DeliveryStore, type Job, type Row } from '../../docker/volumes/functions/slack-deliver/core';

const values: Record<string, string> = { SUPABASE_URL: 'https://db.example.com', SUPABASE_SERVICE_ROLE_KEY: 'example-service',
  SUPABASE_ANON_KEY: 'example-anon', JWT_SECRET: 'example-signing-secret-at-least-32-chars' };
const env = { get: (key: string) => values[key] };
function backend(options: { inactive?: boolean; noAuth?: boolean; disabled?: boolean; duplicate?: boolean; denied?: boolean; issuerRole?: string;
  qaIssue?: Row | null; qaStatus?: number; qaUnavailable?: boolean } = {}) {
  const reads: Row[] = [];
  vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input)), table = url.pathname.split('/').at(-1);
    if (table === 'members') {
      if (url.searchParams.get('id') === 'eq.issuer') return Response.json([{ id: 'issuer', role: options.issuerRole || 'super_admin', is_active: true }]);
      return Response.json(options.inactive ? [] : [{ id: 'member', auth_id: options.noAuth ? null : 'auth-member', email: 'member@example.com' }]);
    }
    if (table === 'slack_link_preferences') return Response.json(options.disabled ? [{ member_id: 'member' }] : []);
    if (table === 'external_account_bindings') {
      expect(url.searchParams.get('is_verified')).toBe('eq.true'); expect(url.searchParams.get('platform_team_id')).toBe('eq.TEXAMPLE');
      const binding = { id: 'binding', platform_user_id: 'UEXAMPLE', platform_team_id: 'TEXAMPLE', is_verified: true, verified_by: 'admin', verified_by_member_id: 'issuer' };
      return Response.json(options.duplicate ? [binding, binding] : [binding]);
    }
    if (table === 'qa_issues') throw new Error('QA tables are not an authenticated member API');
    if (table === 'tasks' || table === 'qa') {
      const auth = (init?.headers as Row).Authorization;
      expect(auth).not.toBe('Bearer example-service');
      const claims = JSON.parse(Buffer.from(auth.split('.')[1], 'base64url').toString());
      reads.push({ table, claims, query: Object.fromEntries(url.searchParams) });
      if (table === 'qa') {
        expect(url.pathname).toBe('/functions/v1/qa'); expect(init?.method).toBe('POST');
        expect((init?.headers as Row).apikey).toBe('example-anon');
        expect(JSON.parse(String(init?.body))).toEqual({ action: 'get', id: 'record' });
        if (options.qaUnavailable) throw new Error('QA transport unavailable');
        if (options.qaStatus) return Response.json({ error: { code: 'qa_forbidden' } }, { status: options.qaStatus });
        return Response.json({ issue: options.qaIssue === undefined ? { id: 'record', workspaceId: 'default' } : options.qaIssue });
      }
      return Response.json(options.denied ? [] : [{ id: 'record' }]);
    }
    throw new Error('unexpected database read');
  }));
  return reads;
}
afterEach(() => vi.unstubAllGlobals());
describe('Slack personal delivery uses the recipient LIVO identity', () => {
  it.each(['tasks', 'qa_issues'] as const)('reads %s through its member contract with verified Slack claims', async table => {
    const reads = backend();
    expect(await recipientCanRead(env, 'member', 'TEXAMPLE', table, 'record')).toBe(true);
    expect(reads[0].claims).toMatchObject({ sub: 'auth-member', role: 'authenticated', livo_slack_binding: 'binding', livo_slack_team: 'TEXAMPLE', livo_slack_user: 'UEXAMPLE' });
    expect(reads).toHaveLength(1);
    if (table === 'tasks') expect(reads[0]).toMatchObject({ table: 'tasks', query: { select: 'id', id: 'eq.record', limit: '1' } });
    else expect(reads[0].table).toBe('qa');
  });
  it.each([{ inactive: true }, { noAuth: true }, { disabled: true }, { duplicate: true }, { issuerRole: 'admin' }])('fails closed for an unusable identity %j', async options => {
    const reads = backend(options);
    expect(await deliveryStore(env).binding('member', 'TEXAMPLE')).toBeUndefined();
    expect(await recipientCanRead(env, 'member', 'TEXAMPLE', 'tasks', 'record')).toBe(false);
    expect(await recipientCanRead(env, 'member', 'TEXAMPLE', 'qa_issues', 'record')).toBe(false);
    expect(reads).toHaveLength(0);
  });
  it('honors an RLS-filtered empty task read', async () => {
    backend({ denied: true });
    expect(await recipientCanRead(env, 'member', 'TEXAMPLE', 'tasks', 'record')).toBe(false);
  });
  it.each([null, {}, { id: 'another-record', workspaceId: 'default' }, { id: 'record', workspaceId: 'another-workspace' }])(
    'fails closed when the QA member response does not identify this workspace record: %j', async qaIssue => {
      backend({ qaIssue });
      expect(await recipientCanRead(env, 'member', 'TEXAMPLE', 'qa_issues', 'record')).toBe(false);
    });
  it.each([{ qaStatus: 403 }, { qaStatus: 404 }, { qaStatus: 503 }, { qaUnavailable: true }])(
    'never substitutes a service-role QA read after the member endpoint fails: %j', async options => {
      const reads = backend(options);
      await expect(recipientCanRead(env, 'member', 'TEXAMPLE', 'qa_issues', 'record')).rejects.toThrow('recipient_permission_unavailable');
      expect(reads).toHaveLength(1); expect(reads[0].table).toBe('qa');
    });
});

const config: Row = { enabled: true, teamId: 'TEXAMPLE', dmEnabled: true, routes: [] };
const job: Job = { id: 1, team_id: 'TEXAMPLE', task_id: 'task', target_type: 'member', target_id: 'member', attempts: 1,
  payload: { kind: 'personal', reason: 'assigned', taskKey: 'EX-1', taskTitle: 'Example' } };
function personal() {
  let permission = true, enabled = true;
  const results: Row[] = [], posts: Row[] = [];
  const store: DeliveryStore = { config: async () => ({ ...config, dmEnabled: enabled }), claim: async () => job, token: async () => 'example-token',
    project: async () => ({ id: 'project', is_archived: false }), binding: async () => 'UEXAMPLE', canReadTask: vi.fn(async () => permission),
    thread: async () => undefined, currentTask: async () => ({ assignee_id: 'member' }), queueWeekly: async () => 0, weeklyTasks: async () => [],
    canSend: async () => true, finish: async (_job, _owner, result) => { results.push(result); return true; } };
  const fetcher = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url.includes('/auth.test')) return Response.json({ ok: true, team_id: 'TEXAMPLE' });
    if (url.includes('/users.info')) return Response.json({ ok: true, user: { team_id: 'TEXAMPLE' } });
    if (url.includes('/conversations.open')) return Response.json({ ok: true, channel: { id: 'DEXAMPLE' } });
    if (url.includes('/conversations.members')) throw new Error('DM must not depend on channel membership');
    posts.push(JSON.parse(String(init?.body))); return Response.json({ ok: true, ts: '1791158400.000001' });
  }) as unknown as typeof fetch;
  return { store, fetcher, posts, results, deny: () => { permission = false; }, disable: () => { enabled = false; } };
}
describe('personal notification permission races', () => {
  it('delivers to a responsible authorized member with no subscribed Slack channel', async () => {
    const t = personal();
    expect(await deliverJob(job, 'owner', t.store, 'https://example.com', t.fetcher)).toBe('sent');
    expect(t.posts).toHaveLength(1); expect(t.store.canReadTask).toHaveBeenCalledTimes(2);
  });
  it('does not open a DM for a member who cannot read the task', async () => {
    const t = personal(); t.deny();
    expect(await deliverJob(job, 'owner', t.store, 'https://example.com', t.fetcher)).toBe('failed');
    expect(t.posts).toHaveLength(0); expect(t.results[0].error).toBe('recipient_permission_denied');
    expect(vi.mocked(t.fetcher).mock.calls.some(c => String(c[0]).includes('/conversations.open'))).toBe(false);
  });
  it('rechecks permission immediately before posting', async () => {
    const t = personal(); t.store.canSend = async () => { t.deny(); return true; };
    expect(await deliverJob(job, 'owner', t.store, 'https://example.com', t.fetcher)).toBe('failed');
    expect(t.posts).toHaveLength(0);
  });
  it('honors DM opt-out while a delivery is in flight', async () => {
    const t = personal(); t.store.canSend = async () => { t.disable(); return true; };
    expect(await deliverJob(job, 'owner', t.store, 'https://example.com', t.fetcher)).toBe('skipped');
    expect(t.posts).toHaveLength(0);
  });
  it('checks the Slack identity after the final RLS read', async () => {
    const t = personal(); let user = 'UEXAMPLE', reads = 0;
    t.store.binding = async () => user;
    t.store.canReadTask = async () => { if (++reads === 2) user = 'UREBOUND'; return true; };
    expect(await deliverJob(job, 'owner', t.store, 'https://example.com', t.fetcher)).toBe('failed');
    expect(t.posts).toHaveLength(0); expect(t.results[0].error).toBe('recipient_not_verified');
  });
});
