// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import { deliverJob, type DeliveryStore, type Job } from '../../docker/volumes/functions/slack-deliver/core';
import { deliverRelease, type ReleaseDeliveryStore } from '../../docker/volumes/functions/slack-deliver/release-core';
import { handleSlackActionsConfig } from '../../docker/volumes/functions/slack-actions-config/handler';
import { NO_ACCOUNT } from '../../docker/volumes/functions/slack-interact/core';
import { createActions } from '../../docker/volumes/functions/slack-interact/backend';
import { handleKnowledgeSlack, type KnowledgeSlackActions } from '@/lib/knowledgeSlack';
import { drainQaSlackInbox, type QaSlackActions, type QaSlackPayload } from '@/lib/qa/slack';
import { QaError } from '@/lib/qa/domain';

type Row = Record<string, any>;
afterEach(() => vi.unstubAllGlobals());
const guest = { id: 'UGUEST', team_id: 'TEXAMPLE', is_restricted: true };
const singleChannelGuest = { ...guest, is_restricted: false, is_ultra_restricted: true };

describe('Slack guests at delivery time', () => {
  const config = { enabled: true, teamId: 'TEXAMPLE', dmEnabled: true, routes: [{ lineId: 'line', channelId: 'CEXAMPLE' }] };
  const job: Job = { id: 1, team_id: 'TEXAMPLE', task_id: 'task', target_type: 'member', target_id: 'member', attempts: 1,
    payload: { kind: 'personal', reason: 'assigned', taskKey: 'EX-1', taskTitle: 'Example', projectName: 'Example' } };
  it.each([guest, singleChannelGuest])('never DMs a Slack guest bound to a member', async user => {
    const results: Row[] = [], calls: string[] = [];
    const store: DeliveryStore = { config: async () => config, claim: async () => job, token: async () => 'xoxb-example',
      project: async () => ({ id: 'project', line_id: 'line', is_archived: false }), binding: async () => user.id, thread: async () => undefined,
      currentTask: async () => ({ assignee_id: 'member' }), queueWeekly: async () => 0, weeklyTasks: async () => [], canSend: async () => true,
      finish: async (_job, _owner, result) => { results.push(result); return true; } };
    const fetcher = vi.fn(async (input: string | URL | Request) => {
      const method = new URL(String(input)).pathname.split('/').pop()!; calls.push(method);
      if (method === 'auth.test') return Response.json({ ok: true, team_id: 'TEXAMPLE' });
      if (method === 'users.info') return Response.json({ ok: true, user });
      if (method === 'conversations.members') return Response.json({ ok: true, members: [user.id] });
      if (method === 'conversations.open') return Response.json({ ok: true, channel: { id: 'DGUEST' } });
      return Response.json({ ok: true, ts: '1.0' });
    }) as unknown as typeof fetch;
    expect(await deliverJob(job, 'owner', store, 'https://example.com', fetcher)).toBe('failed');
    expect(results[0].error).toBe('recipient_unavailable');
    expect(calls).not.toContain('chat.postMessage');
  });
  it.each([guest, singleChannelGuest])('never publishes a release thread for a Slack guest', async user => {
    const results: Row[] = [], calls: string[] = [];
    const state = { batch: { id: 'b', title: 'Example', status: 'active', version: 1, manifestRevision: 1, components: [{ projectId: 'p', name: 'Web', targets: [] as Row[] }] },
      event: { id: 'e', operation: 'create', version: 1 }, publication: { team_id: 'TEXAMPLE', channel_id: 'CEXAMPLE' },
      projects: [{ id: 'p', name: 'Example', line_id: 'line', is_archived: false }], ownerName: 'Example', publisherUser: user.id };
    const store: ReleaseDeliveryStore = { config: async () => config, claim: async () => undefined, snapshot: async () => state, token: async () => 'xoxb-example',
      canSend: async () => true, finish: async (_job, _owner, result) => { results.push(result); return true; } };
    const fetcher = vi.fn(async (input: string | URL | Request) => {
      const method = new URL(String(input)).pathname.split('/').pop()!; calls.push(method);
      if (method === 'auth.test') return Response.json({ ok: true, team_id: 'TEXAMPLE', user_id: 'UBOT' });
      if (method === 'users.info') return Response.json({ ok: true, user });
      if (method === 'conversations.members') return Response.json({ ok: true, members: [user.id, 'UBOT'] });
      return Response.json({ ok: true, ts: '1.0' });
    }) as unknown as typeof fetch;
    await deliverRelease({ id: 'j', event_id: 'e', batch_id: 'b', workspace_id: 'default', attempts: 1 }, 'owner', store, 'https://example.com', fetcher);
    expect(results[0].error).toBe('publication_member_unavailable');
    expect(calls).not.toContain('chat.postMessage');
  });
});

describe('/livo kb feature toggle', () => {
  it('checks the toggle before resolving the Slack identity', async () => {
    const jobs: Promise<unknown>[] = [];
    const actions: KnowledgeSlackActions = { enabled: vi.fn(async () => false), actor: vi.fn(async () => ({ id: 'member' })),
      search: vi.fn(), link: () => '', slack: vi.fn(async () => ({ view: { id: 'V1', hash: 'h' } })), background: job => { jobs.push(job); } };
    await handleKnowledgeSlack({ command: '/livo', text: 'kb release', trigger_id: 't', user_id: 'U1', team_id: 'T1' }, actions);
    await Promise.all(jobs);
    expect(actions.actor).not.toHaveBeenCalled();
    expect(JSON.stringify(vi.mocked(actions.slack).mock.calls.at(-1))).toContain('Slack');
  });
});

describe('QA Slack inbox', () => {
  const event: QaSlackPayload = { type: 'event_callback', team_id: 'T1', event: { type: 'message', user: 'U1', channel: 'C1', thread_ts: '100.1', ts: '101.1', text: 'Follow-up' } };
  function inbox(actor: () => Promise<Row>, get: () => Promise<Row>) {
    return { enabled: vi.fn(async () => true), actor: vi.fn(actor), api: vi.fn(async (_a: unknown, body: Row) => body.action === 'get' ? get() : {}),
      mapped: vi.fn(async () => 'bug-a'), pendingEvents: vi.fn(async () => [{ id: 'queued-1', payload: event }]), completeEvent: vi.fn(async () => {}),
      claimNotice: vi.fn(async () => false), slack: vi.fn() } as unknown as QaSlackActions;
  }
  const noAccount = () => Promise.reject(Object.assign(new Error(NO_ACCOUNT), { name: 'ActionError', code: 'no_account' }));
  it('gets a machine-readable no-account error from the self-hosted actor lookup', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => String(input).includes('slack_config')
      ? Response.json([{ bot_token: 'xoxb-example' }]) : Response.json({ ok: true, team_id: 'TOTHER' })));
    const env = { get: (key: string) => key === 'SUPABASE_URL' ? 'https://db.example.com' : 'example' };
    await expect(createActions(env, () => {}).actor({ user_id: 'U1', team_id: 'T1' })).rejects.toMatchObject({ message: NO_ACCOUNT, code: 'no_account' });
  });
  it.each([
    ['the author has no LIVO account (self-hosted)', noAccount, async () => ({})],
    ['the author has no LIVO account (cloud)', () => Promise.reject(new Error('qa_forbidden')), async () => ({})],
    ['the bug was deleted (self-hosted)', async () => ({ id: 'qa', role: 'member', team: 'T1' }), () => Promise.reject(new QaError('qa_issue_not_found', 404))],
    ['the bug was deleted (cloud)', async () => ({ id: 'qa', role: 'member', team: 'T1' }), () => Promise.reject(new QaError('qa_not_found', 404))],
  ])('drops an event that can never succeed: %s', async (_label, actor, get) => {
    const d = inbox(actor, get);
    await drainQaSlackInbox(d);
    expect(d.completeEvent).toHaveBeenCalledWith('queued-1');
  });
  it.each([
    ['a Slack outage', () => Promise.reject(new Error('Slack operation failed')), async () => ({})],
    ['a database outage', async () => ({ id: 'qa', role: 'member', team: 'T1' }), () => Promise.reject(new QaError('qa_storage_unavailable', 503))],
  ])('keeps retrying after %s', async (_label, actor, get) => {
    const d = inbox(actor, get);
    await drainQaSlackInbox(d);
    expect(d.completeEvent).not.toHaveBeenCalled();
  });
});

describe('Slack people list', () => {
  const people = [{ id: 'member-owner', name: 'Example Owner', role: 'super_admin', is_active: true, auth_id: 'auth-owner' },
    { id: 'member-admin', name: 'Example Admin', role: 'admin', is_active: true, auth_id: 'auth-admin' }];
  const env = { get: (key: string) => key === 'SUPABASE_URL' ? 'https://db.example.com' : 'example' };
  it.each([['admin', 'auth-admin', 403], ['owner', 'auth-owner', 200]])('lists Slack people and their emails only for owners (%s)', async (_label, caller, status) => {
    const slack = vi.fn();
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => {
      const url = new URL(String(input)), table = url.pathname.split('/').pop()!;
      if (url.hostname === 'slack.com') { slack(table); return Response.json({ ok: true, members: [{ id: 'UPERSON', name: 'person', profile: { email: 'person@example.org' } }] }); }
      if (url.pathname === '/auth/v1/user') return Response.json({ id: caller });
      if (table === 'system_settings') return Response.json([{ value: { slackActions: true } }]);
      if (table === 'slack_config') return Response.json([{ bot_token: 'example-bot' }]);
      if (table === 'members') return Response.json(people.filter(p => p.auth_id === url.searchParams.get('auth_id')?.slice(3)));
      return Response.json([]);
    }));
    const response = await handleSlackActionsConfig(new Request('https://example.com/functions/v1/slack-actions-config?slackUsers=1',
      { headers: { Authorization: 'Bearer member-session' } }), env);
    expect(response.status).toBe(status);
    if (status === 200) expect((await response.json()).users).toEqual([{ id: 'UPERSON', name: 'person', email: 'person@example.org' }]);
    else expect(slack).not.toHaveBeenCalled();
  });
});
