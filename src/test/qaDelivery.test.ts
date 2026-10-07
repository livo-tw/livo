// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { deliverQaJob, qaNotificationMessage, qaRouteAllowed, type QaDeliveryState, type QaDeliveryStore } from '../../docker/volumes/functions/slack-deliver/qa-core';
import { type Job, type Row } from '../../docker/volumes/functions/slack-deliver/core';
import { type QaIssue } from '../lib/qa/domain';

const issue = { id: 'issue', workspaceId: 'default', projectId: 'project', title: 'Example <!channel>', reporterId: 'reporter',
  assigneeId: 'member', qaOwnerId: 'qa', state: 'triaged', priority: 2, severity: 'high', dueDate: '2026-10-10', fixCycle: 1,
  version: 2, targets: [], runs: [], taskIds: [] } as QaIssue;
const state: QaDeliveryState = { issue, project: { id: 'project', line_id: 'line', name: 'Example project', is_archived: false }, triagers: ['admin'],
  members: [{ id: 'member', name: 'Example member' }, { id: 'qa', name: 'Example QA' }, { id: 'reporter', name: 'Example reporter' }] };
const config = { enabled: true, teamId: 'TEXAMPLE', dmEnabled: true, routes: [{ lineId: 'line', channelId: 'CTASK' }], qaRoutes: [{ lineId: 'line', channelId: 'CBUG' }] };
const job: Job = { id: 1, task_id: 'qa:issue', team_id: 'TEXAMPLE', target_type: 'channel', target_id: 'CBUG', attempts: 1,
  payload: { recordType: 'qa', kind: 'qa', issueId: 'issue', eventType: 'triage', actorId: 'reporter', detail: '責任人：未指定 → Example member' } };
function setup() {
  let live: QaDeliveryState | undefined = structuredClone(state), liveConfig = structuredClone(config), allowed = true, user: string | undefined = 'UEXAMPLE';
  let thread: string | undefined;
  const posts: Row[] = [], results: Row[] = [];
  const store: QaDeliveryStore = { enabled: async () => true, config: async () => liveConfig, token: async () => 'example-token', binding: async () => user,
    state: async () => live, canRead: vi.fn(async () => allowed), thread: async () => thread, workflow: async () => undefined, canSend: async () => true,
    finish: vi.fn(async (_job, _owner, result) => { results.push(result); return true; }) };
  const fetcher = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url.includes('/auth.test')) return Response.json({ ok: true, team_id: 'TEXAMPLE' });
    if (url.includes('/users.info')) return Response.json({ ok: true, user: { team_id: 'TEXAMPLE' } });
    if (url.includes('/conversations.open')) return Response.json({ ok: true, channel: { id: 'DEXAMPLE' } });
    if (url.includes('/conversations.members')) throw new Error('QA DM must use LIVO permissions');
    posts.push(JSON.parse(String(init?.body))); return Response.json({ ok: true, ts: '1791158400.000001' });
  }) as unknown as typeof fetch;
  return { store, fetcher, posts, results, deny: () => { allowed = false; }, unbind: () => { user = undefined; },
    remove: () => { live = undefined; }, reassign: () => { live!.issue.assigneeId = 'other'; }, reroute: () => { liveConfig.qaRoutes = []; },
    root: (value: string) => { thread = value; } };
}
const personal: Job = { ...job, target_type: 'member', target_id: 'member' };
describe('QA notification channel routing and personal permissions', () => {
  it('uses only QA routes and preserves source-channel echo prevention', () => {
    expect(qaRouteAllowed(config, state, job)).toBe(true);
    expect(qaRouteAllowed(config, state, { ...job, target_id: 'CTASK' })).toBe(false);
    expect(qaRouteAllowed({ ...config, qaRoutes: undefined }, state, job)).toBe(false);
    expect(qaRouteAllowed(config, state, { ...job, payload: { ...job.payload, sourceChannelId: 'CBUG' } })).toBe(false);
  });
  it('posts a Bug card and JJ-style project, people, priority and deadline fields', async () => {
    const t = setup(); expect(await deliverQaJob(job, 'owner', t.store, 'https://example.com', t.fetcher)).toBe('sent');
    expect(t.posts[0]).toMatchObject({ channel: 'CBUG', unfurl_links: false, unfurl_media: false });
    expect(t.posts[0].text).toContain('Example project'); expect(t.posts[0].text).toContain('優先級：高'); expect(t.posts[0].text).not.toContain('P2'); expect(t.posts[0].text).toContain('2026-10-10');
    expect(t.posts[0].text).toContain('Example member'); expect(t.posts[0].text).toContain('&lt;!channel&gt;');
    expect(t.posts[0].blocks.some((b: Row) => b.elements?.some((e: Row) => e.action_id === 'livo_qa_comment'))).toBe(true);
  });
  it('delivers responsible-member DMs without channel membership or channel routes', async () => {
    const t = setup(); t.reroute(); expect(await deliverQaJob(personal, 'owner', t.store, 'https://example.com', t.fetcher)).toBe('sent');
    expect(t.posts[0].channel).toBe('DEXAMPLE'); expect(t.posts[0]).not.toHaveProperty('thread_ts'); expect(t.store.canRead).toHaveBeenCalledTimes(2);
  });
  it('delivers a newly reported Bug to its project coordinator before responsibility is assigned', async () => {
    const t = setup(); t.reroute();
    t.store.state = async () => ({ ...state, issue: { ...issue, state: 'new', assigneeId: null, qaOwnerId: null }, triagers: ['member'] });
    expect(await deliverQaJob({ ...personal, payload: { ...personal.payload, eventType: 'created' } },
      'owner', t.store, 'https://example.com', t.fetcher)).toBe('sent');
    expect(t.posts).toHaveLength(1); expect(t.posts[0].channel).toBe('DEXAMPLE'); expect(t.store.canRead).toHaveBeenCalledTimes(2);
  });
  it.each(['member', 'qa'] as const)('notifies an assigned %s about a newly created Bug through verified personal delivery', async target => {
    const t = setup(); t.reroute();
    t.store.state = async () => ({ ...state, issue: { ...issue, state: 'new' }, triagers: ['admin'] });
    const created = { ...personal, target_id: target, payload: { ...personal.payload, eventType: 'created' } };
    expect(await deliverQaJob(created, 'owner', t.store, 'https://example.com', t.fetcher)).toBe('sent');
    expect(t.posts).toHaveLength(1); expect(t.posts[0].channel).toBe('DEXAMPLE'); expect(t.store.canRead).toHaveBeenCalledTimes(2);
  });
  it.each(['member', 'qa'] as const)('rechecks the created Bug recipient %s after permission, binding or assignment changes', async target => {
    for (const reason of ['permission', 'binding', 'assignment'] as const) {
      const t = setup();
      const live = { ...state, issue: { ...issue, state: 'new' as const }, triagers: ['admin'] };
      t.store.state = async () => live;
      t.store.canSend = async () => {
        if (reason === 'permission') t.deny();
        if (reason === 'binding') t.unbind();
        if (reason === 'assignment') { if (target === 'member') live.issue.assigneeId = 'other'; else live.issue.qaOwnerId = 'other'; }
        return true;
      };
      const created = { ...personal, target_id: target, payload: { ...personal.payload, eventType: 'created' } };
      expect(await deliverQaJob(created, 'owner', t.store, 'https://example.com', t.fetcher)).not.toBe('sent');
      expect(t.posts).toHaveLength(0);
    }
  });
  it('does not send the reporter a self-notice when the default QA owner is the actor', async () => {
    const t = setup();
    t.store.state = async () => ({ ...state, issue: { ...issue, state: 'new', qaOwnerId: 'reporter' }, triagers: ['admin'] });
    const created = { ...personal, target_id: 'reporter', payload: { ...personal.payload, eventType: 'created', actorId: 'reporter' } };
    expect(await deliverQaJob(created, 'owner', t.store, 'https://example.com', t.fetcher)).toBe('skipped');
    expect(t.posts).toHaveLength(0); expect(t.store.canRead).not.toHaveBeenCalled();
  });
  it.each(['permission', 'binding', 'responsibility', 'deleted', 'route'] as const)('does not leak a queued notice after %s changes', async reason => {
    const t = setup();
    t.store.canSend = async () => { if (reason === 'permission') t.deny(); if (reason === 'binding') t.unbind();
      if (reason === 'responsibility') t.reassign(); if (reason === 'deleted') t.remove(); if (reason === 'route') t.reroute(); return true; };
    expect(await deliverQaJob(reason === 'route' ? job : personal, 'owner', t.store, 'https://example.com', t.fetcher)).not.toBe('sent');
    expect(t.posts).toHaveLength(0);
  });
  it('rejects unverified recipients before opening a DM', async () => {
    const t = setup(); t.unbind(); expect(await deliverQaJob(personal, 'owner', t.store, 'https://example.com', t.fetcher)).toBe('failed'); expect(t.posts).toHaveLength(0);
  });
  it('checks binding identity after the last QA record-access read', async () => {
    const t = setup(); let reads = 0;
    t.store.canRead = async () => { if (++reads === 2) t.unbind(); return true; };
    expect(await deliverQaJob(personal, 'owner', t.store, 'https://example.com', t.fetcher)).toBe('failed'); expect(t.posts).toHaveLength(0);
  });
  it('threads updates only within a fixed hour from the root receipt', async () => {
    const now = Date.parse('2026-10-05T09:00:00Z'), t = setup(); t.root(`${now / 1000 - 60}.000001`);
    await deliverQaJob(job, 'owner', t.store, 'https://example.com', t.fetcher, now);
    expect(t.posts[0]).toHaveProperty('thread_ts'); t.root(`${now / 1000 - 3600}.000000`);
    await deliverQaJob(job, 'owner', t.store, 'https://example.com', t.fetcher, now);
    expect(t.posts[1]).not.toHaveProperty('thread_ts');
  });
  it('keeps a post with an unknown transport result for review instead of resending', async () => {
    const t = setup(), base = t.fetcher;
    const fetcher = (async (...args: Parameters<typeof fetch>) => { if (String(args[0]).includes('/chat.postMessage')) throw new Error('network lost'); return base(...args); }) as typeof fetch;
    expect(await deliverQaJob(job, 'owner', t.store, 'https://example.com', fetcher)).toBe('review');
  });
  it('requires a durable receipt and retains an uncertain sending lease on database failure', async () => {
    const t = setup(); t.store.finish = async () => { throw new Error('database unavailable'); };
    await expect(deliverQaJob(job, 'owner', t.store, 'https://example.com', t.fetcher)).rejects.toThrow('database unavailable');
    expect(t.posts).toHaveLength(1);
  });
  it('formats comments as escaped, bounded text', () => {
    const msg = qaNotificationMessage(state, { ...job, payload: { ...job.payload, eventType: 'comment', detail: '<p>Hello &amp; world</p>'.repeat(1000) } }, 'https://example.com');
    expect(msg.blocks.length).toBeLessThanOrEqual(50);
    expect(msg.blocks.filter((b: Row) => b.type === 'section').every((b: Row) => b.text.text.length <= 3000)).toBe(true);
  });
});
