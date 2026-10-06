// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { activeThread, currentPersonalPayload, DeliveryError, deliverJob, failureResult, isChannelMember, memberAllowed, notificationMessage, routeAllowed, weeklyMessage, type DeliveryStore, type Job } from '../../docker/volumes/functions/slack-deliver/core';
import { deliveryStore, drainDeliveries } from '../../docker/volumes/functions/slack-deliver/backend';
import { requireSlackReceipt } from '../lib/slackReceipt';

const config = { enabled: true, teamId: 'TEXAMPLE', dmEnabled: false, routes: [{ lineId: 'line-example', channelId: 'CEXAMPLE' }] };
const project = { id: 'project-example', line_id: 'line-example', is_archived: false };
const job: Job = { id: 1, team_id: 'TEXAMPLE', task_id: 'task-example', target_type: 'channel', target_id: 'CEXAMPLE', attempts: 1,
  payload: { kind: 'created', taskKey: 'EXAMPLE-123', taskTitle: 'Example task', actorName: 'Example member', projectName: 'Example project', priority: 'high' } };
function setup() {
  const sent: Record<string, any>[] = [], results: Record<string, any>[] = [];
  let thread: string | undefined;
  const store: DeliveryStore = { config: async () => config, claim: async () => job, token: async () => 'example-token',
    project: async () => project, binding: async () => 'UEXAMPLE', canReadTask: async () => true, thread: async () => thread,
    currentTask: async () => ({ assignee_id: 'member-example', reviewer_id: null, status_id: 'todo' }),
    queueWeekly: async () => 0, weeklyTasks: async () => [], canSend: async () => true,
    finish: vi.fn(async (_job, _owner, result) => { results.push(result); if (result.status === 'sent') thread = result.threadTs; return true; }) };
  const fetcher = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    if (String(url).endsWith('/auth.test')) return Response.json({ ok: true, team_id: 'TEXAMPLE' });
    sent.push(JSON.parse(String(init?.body)));
    return Response.json({ ok: true, ts: `${Math.floor(Date.now() / 1000)}.00000${sent.length}` });
  }) as unknown as typeof fetch;
  return { store, sent, results, fetcher };
}
describe('durable Slack notification delivery', () => {
  it.each(['assignee','reviewer'])('delivers current %s due reminders despite historical snooze settings without consulting them', async role => {
    const t=setup(); let posts=0;
    t.store.config=async()=>({...config,dmEnabled:true});
    t.store.currentTask=async()=>({assignee_id:role==='assignee'?'member-example':null,reviewer_id:role==='reviewer'?'member-example':null,due_date:'2026-10-10',statuses:{is_done:false}});
    t.store.reminderPaused=vi.fn(async()=>true);
    const fetcher=vi.fn(async(input:string|URL|Request)=>{
      const endpoint=String(input);
      if(endpoint.includes('/auth.test'))return Response.json({ok:true,team_id:'TEXAMPLE'});
      if(endpoint.includes('/users.info'))return Response.json({ok:true,user:{team_id:'TEXAMPLE'}});
      if(endpoint.includes('/conversations.members'))return Response.json({ok:true,members:['UEXAMPLE']});
      if(endpoint.includes('/conversations.open'))return Response.json({ok:true,channel:{id:'DEXAMPLE'}});
      posts++;return Response.json({ok:true,ts:'1791158400.000001'});
    }) as unknown as typeof fetch;
    const due:Job={...job,target_type:'member',target_id:'member-example',payload:{...job.payload,kind:'personal',reason:'due_soon',dueDate:'2026-10-10'}};
    expect(await deliverJob(due,'owner',t.store,'https://example.com',fetcher)).toBe('sent');expect(posts).toBe(1);
    expect(await deliverJob({...due,id:2,payload:{...due.payload,reason:role==='assignee'?'assigned':'review'}},'owner',t.store,'https://example.com',fetcher)).toBe('sent');
    expect(posts).toBe(2);expect(t.store.reminderPaused).not.toHaveBeenCalled();
  });
  it.each([undefined, 'UREBOUND'])('does not post to an old DM after binding changes to %s', async changedUser => {
    const t = setup(); let user: string | undefined = 'UEXAMPLE', posts = 0;
    t.store.config = async () => ({ ...config, dmEnabled: true });
    t.store.binding = async () => user;
    const fetcher = vi.fn(async (input: string | URL | Request) => {
      const endpoint = String(input);
      if (endpoint.includes('/auth.test')) return Response.json({ ok: true, team_id: 'TEXAMPLE' });
      if (endpoint.includes('/users.info')) return Response.json({ ok: true, user: { team_id: 'TEXAMPLE' } });
      if (endpoint.includes('/conversations.members')) return Response.json({ ok: true, members: ['UEXAMPLE'] });
      if (endpoint.includes('/conversations.open')) { user = changedUser; return Response.json({ ok: true, channel: { id: 'DEXAMPLE' } }); }
      posts++; return Response.json({ ok: true, ts: '1791158400.000001' });
    }) as unknown as typeof fetch;
    const assigned: Job = { ...job, target_type: 'member', target_id: 'member-example', payload: { ...job.payload, kind: 'personal', reason: 'assigned' } };
    expect(await deliverJob(assigned, 'owner', t.store, 'https://example.com', fetcher)).toBe('failed');
    expect(posts).toBe(0); expect(t.results[0].error).toBe('recipient_not_verified');
  });
  it('keeps later updates and comments in the current card thread within one hour', async () => {
    const t = setup();
    await deliverJob(job, 'owner', t.store, 'https://example.com', t.fetcher);
    await deliverJob({ ...job, id: 2, payload: { ...job.payload, kind: 'comment', content: '<p>Example comment</p>' } }, 'owner', t.store, 'https://example.com', t.fetcher);
    expect(t.sent[0]).not.toHaveProperty('thread_ts');
    expect(t.sent[1].thread_ts).toBe(t.results[0].messageTs);
    expect(t.results.every(r => r.status === 'sent')).toBe(true);
    expect(t.sent[1]).toMatchObject({ unfurl_links: false, unfurl_media: false });
  });
  it('rechecks the route before posting, including a project moved to another line', async () => {
    const t = setup(); t.store.project = async () => ({ ...project, line_id: 'other-line' });
    expect(await deliverJob(job, 'owner', t.store, 'https://example.com', t.fetcher)).toBe('skipped');
    expect(t.fetcher).not.toHaveBeenCalled();
    expect(routeAllowed(config, project, { ...job, payload: { ...job.payload, sourceChannelId: 'CEXAMPLE' } })).toBe(false);
    expect(routeAllowed({ ...config, teamId: 'TOTHER' }, project, job)).toBe(false);
  });
  it('retries a definite rate-limit rejection with Retry-After', async () => {
    const t = setup();
    const fetcher = vi.fn(async (url: string | URL | Request) => String(url).endsWith('/auth.test')
      ? Response.json({ ok: true, team_id: 'TEXAMPLE' }) : new Response('', { status: 429, headers: { 'retry-after': '180' } })) as unknown as typeof fetch;
    expect(await deliverJob(job, 'owner', t.store, 'https://example.com', fetcher)).toBe('pending');
    expect(t.results[0]).toMatchObject({ error: 'ratelimited', delay: 180 });
    expect(failureResult(new DeliveryError('ratelimited', true), 8).status).toBe('failed');
  });
  it('requires review after a send timeout, without reposting', async () => {
    const t = setup(); let posts = 0;
    const fetcher = vi.fn(async (url: string | URL | Request) => {
      if (String(url).endsWith('/auth.test')) return Response.json({ ok: true, team_id: 'TEXAMPLE' });
      posts++; throw new Error('timeout');
    }) as unknown as typeof fetch;
    expect(await deliverJob(job, 'owner', t.store, 'https://example.com', fetcher)).toBe('review');
    expect(posts).toBe(1);
  });
  it('does not convert a failed receipt write into a second Slack post', async () => {
    const t = setup(); t.store.finish = vi.fn(async () => { throw new Error('database unavailable'); });
    await expect(deliverJob(job, 'owner', t.store, 'https://example.com', t.fetcher)).rejects.toThrow('database unavailable');
    expect(t.sent).toHaveLength(1);
    expect(t.store.finish).toHaveBeenCalledTimes(1);
  });
  it('refuses a bot from a different workspace before sending', async () => {
    const t = setup();
    const fetcher = vi.fn(async () => Response.json({ ok: true, team_id: 'TOTHER' })) as unknown as typeof fetch;
    expect(await deliverJob(job, 'owner', t.store, 'https://example.com', fetcher)).toBe('failed');
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it('does not fall back to a same-name recipient when an account is unverified', async () => {
    const t = setup(); t.store.config = async () => ({ ...config, dmEnabled: true }); t.store.binding = async () => undefined;
    expect(await deliverJob({ ...job, target_type: 'member', target_id: 'member-example' }, 'owner', t.store, 'https://example.com', t.fetcher)).toBe('failed');
    expect(t.sent).toHaveLength(0);
    expect(t.results[0].error).toBe('recipient_not_verified');
  });
  it('escapes message mentions and HTML while preserving the root task link', () => {
    const msg = notificationMessage({ ...job.payload, kind: 'comment', taskTitle: '<!channel>', content: '<p>Hello &amp; <@UEXAMPLE></p><script>bad()</script>' }, 'https://example.com/');
    expect(msg.text).toContain('&lt;!channel&gt;');
    expect(msg.text).not.toContain('bad()');
    expect(msg.blocks[1]).toMatchObject({ elements: [{ url: 'https://example.com/?task=EXAMPLE-123' },
      { action_id: 'livo_task_open', value: JSON.stringify({ key: 'EXAMPLE-123' }) }] });
  });
  it('verifies a bound recipient with the users.info GET contract before opening a DM', async () => {
    const t = setup(); t.store.config = async () => ({ ...config, dmEnabled: true });
    t.store.thread = vi.fn(async () => `${Date.now() / 1000}`);
    const fetcher = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const endpoint = new URL(String(url));
      if (endpoint.pathname.endsWith('/auth.test')) return Response.json({ ok: true, team_id: 'TEXAMPLE' });
      if (endpoint.pathname.endsWith('/users.info')) {
        expect(init?.method).toBe('GET'); expect(init?.body).toBeUndefined();
        expect(endpoint.searchParams.get('user')).toBe('UEXAMPLE');
        return Response.json({ ok: true, user: { id: 'UEXAMPLE', team_id: 'TEXAMPLE', deleted: false, is_bot: false } });
      }
      if (endpoint.pathname.endsWith('/conversations.members')) {
        expect(init?.method).toBe('GET'); expect(init?.body).toBeUndefined();
        expect(endpoint.searchParams.get('channel')).toBe('CEXAMPLE');
        return Response.json({ ok: true, members: ['UEXAMPLE'] });
      }
      const args = JSON.parse(String(init?.body));
      if (endpoint.pathname.endsWith('/conversations.open')) {
        expect(args.users).toBe('UEXAMPLE');
        return Response.json({ ok: true, channel: { id: 'DEXAMPLE' } });
      }
      expect(args.channel).toBe('DEXAMPLE');
      expect(args).not.toHaveProperty('thread_ts');
      return Response.json({ ok: true, ts: '1234567890.000001' });
    }) as unknown as typeof fetch;
    expect(await deliverJob({ ...job, target_type: 'member', target_id: 'member-example' }, 'owner', t.store, 'https://example.com', fetcher)).toBe('sent');
    expect(fetcher).toHaveBeenCalledTimes(4);
    expect(t.store.thread).not.toHaveBeenCalled();
  });
  it('uses a fixed 60-minute root window, including the exact boundary and invalid timestamps', () => {
    const root = '1791158400.000000', start = Number(root) * 1000;
    expect(activeThread(root, start + 3599999)).toBe(root);
    expect(activeThread(root, start + 3600000)).toBeUndefined();
    expect(activeThread(root, start - 1)).toBeUndefined();
    expect(activeThread('invalid', start)).toBeUndefined();
    expect(activeThread(undefined, start)).toBeUndefined();
  });
  it('opens a new root after expiry and reuses that new root for the next change', async () => {
    const t = setup(); t.store.thread = async () => '1234567890.000001';
    await deliverJob(job, 'owner', t.store, 'https://example.com', t.fetcher);
    expect(t.sent[0]).not.toHaveProperty('thread_ts');
    const root = t.results[0].threadTs; t.store.thread = async () => root;
    await deliverJob({ ...job, id: 2 }, 'owner', t.store, 'https://example.com', t.fetcher);
    expect(t.sent[1].thread_ts).toBe(root);
  });
  it('requests the newest root mapping without renewing it from reply receipts', async () => {
    const fetcher = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(String(input));
      expect(url.searchParams.get('order')).toBe('created_at.desc,slack_thread_ts.desc');
      expect(url.searchParams.get('limit')).toBe('1');
      return Response.json([{ slack_thread_ts: '1791158400.000001' }]);
    });
    vi.stubGlobal('fetch', fetcher);
    try {
      const store = deliveryStore({ get: key => key === 'SUPABASE_URL' ? 'https://db.example.com' : 'example' });
      expect(await store.thread('task', 'TEXAMPLE', 'CEXAMPLE')).toBe('1791158400.000001');
    } finally { vi.unstubAllGlobals(); }
  });
  it('skips stale handoffs before opening a DM and retains only still-current roles', async () => {
    const t = setup(); t.store.config = async () => ({ ...config, dmEnabled: true });
    const personal: Job = { ...job, target_type: 'member', target_id: 'member-example', payload: { ...job.payload, kind: 'personal',
      recipientRules: [{ code: 'handoff', role: 'reviewer', statusId: 'review' }] } };
    expect(await deliverJob(personal, 'owner', t.store, 'https://example.com', t.fetcher)).toBe('skipped');
    expect(t.fetcher).not.toHaveBeenCalled();
    const both = { ...personal, payload: { ...personal.payload, recipientRules: [
      { code: 'assigned', role: 'assignee' }, { code: 'reviewer_assigned', role: 'reviewer' }] } };
    expect(currentPersonalPayload(both, { assignee_id: 'member-example', reviewer_id: null })?.recipientRules)
      .toEqual([{ code: 'assigned', role: 'assignee' }]);
    expect(currentPersonalPayload(both, undefined)).toBeUndefined();
  });
  it('enforces an explicit test-recipient allowlist without assuming an invalid list means everyone', () => {
    const enabled = { ...config, dmEnabled: true };
    expect(memberAllowed(enabled, 'one')).toBe(true);
    expect(memberAllowed({ ...enabled, dmMemberIds: ['one'] }, 'two')).toBe(false);
    expect(memberAllowed({ ...enabled, dmMemberIds: [] }, 'one')).toBe(false);
    expect(memberAllowed({ ...enabled, dmMemberIds: null }, 'one')).toBe(false);
  });
  it('renders assignment and reviewer handoff reasons with title links and escaped user text', () => {
    const msg = notificationMessage({ ...job.payload, kind: 'personal', recipientRules: [
      { code: 'assigned', role: 'assignee' }, { code: 'reviewer_assigned', role: 'reviewer' },
      { code: 'handoff', role: 'reviewer', statusName: '待驗收 <!channel>' }], dueDate: '2026-10-10' }, 'https://example.com');
    expect(msg.text).toContain('[個人通知]'); expect(msg.text).toContain('任務已指派給你');
    expect(msg.text).toContain('你已被指定為驗收人'); expect(msg.text).toContain('請你驗收');
    expect(msg.text).toContain('&lt;!channel&gt;'); expect(msg.text).toContain('2026-10-10');
    expect(msg.text).toContain('<https://example.com/?task=EXAMPLE-123|EXAMPLE-123 - Example task>');
  });
  it('rechecks weekly tasks and avoids sending an empty or stale weekly report', async () => {
    const t = setup(); t.store.config = async () => ({ ...config, dmEnabled: true, weekly: { enabled: true } });
    const weekly: Job = { ...job, target_type: 'member', target_id: 'member-example', payload: { kind: 'weekly', weekStart: '2026-10-05' } };
    const monday = Date.parse('2026-10-05T09:00:00+08:00');
    expect(await deliverJob(weekly, 'owner', t.store, 'https://example.com', t.fetcher, monday)).toBe('skipped');
    t.store.weeklyTasks = vi.fn(async () => [{ taskKey: 'EX-1' }]);
    expect(await deliverJob(weekly, 'owner', t.store, 'https://example.com', t.fetcher, monday + 7 * 86400000)).toBe('skipped');
    expect(t.store.weeklyTasks).not.toHaveBeenCalled(); expect(t.fetcher).not.toHaveBeenCalled();
  });
  it('formats weekly overdue/due groups within Slack block limits', () => {
    const items = Array.from({ length: 800 }, (_, i) => ({ taskKey: `EX-${i}`, taskTitle: '<!channel>'.repeat(40),
      dueDate: i < 20 ? '2026-10-04' : '2026-10-11', role: i % 2 ? 'reviewer' : 'assignee', projectName: 'Example' }));
    const msg = weeklyMessage(items, '2026-10-05', 'https://example.com');
    expect(msg.text).toContain('逾期 20 張、當週到期 780 張');
    expect(msg.blocks.length).toBeLessThanOrEqual(50);
    expect(msg.blocks.filter(b => b.type === 'section').every(b => b.text.text.length <= 3000)).toBe(true);
    expect(JSON.stringify(msg)).not.toContain('<!channel>');
    expect(JSON.stringify(msg)).toContain('另有');
  });
  it('queues scheduled work in the regular drain before claiming delivery', async () => {
    const t = setup(), calls: string[] = [];
    t.store.queueWeekly = async () => { calls.push('weekly'); return 0; };
    t.store.claim = async () => { calls.push('claim'); return undefined; };
    expect((await drainDeliveries({ get: () => '' }, t.store, t.fetcher)).processed).toBe(0);
    expect(calls).toEqual(['weekly', 'claim']);
  });
  it('paginates channel membership and rejects incomplete reads', async () => {
    const slack = vi.fn(async (_method: string, args: Record<string, unknown>) => args.cursor
      ? { members: ['UEXAMPLE'] } : { members: ['UOTHER'], response_metadata: { next_cursor: 'page-two' } });
    expect(await isChannelMember(slack, 'CEXAMPLE', 'UEXAMPLE')).toBe(true);
    expect(slack).toHaveBeenLastCalledWith('conversations.members', { channel: 'CEXAMPLE', limit: '200', cursor: 'page-two' });
    expect(await isChannelMember(async () => ({ members: [] }), 'CEXAMPLE', 'UEXAMPLE')).toBe(false);
    await expect(isChannelMember(async () => ({ members: [], response_metadata: { next_cursor: 'same' } }), 'CEXAMPLE', 'UEXAMPLE'))
      .rejects.toThrow('membership_check_incomplete');
  });
  it('never posts after the sender loses its delivery lease', async () => {
    const t = setup(); t.store.canSend = async () => false;
    expect(await deliverJob(job, 'owner', t.store, 'https://example.com', t.fetcher)).toBe('review');
    expect(t.sent).toHaveLength(0);
  });
  it('drops due reminders after completion, due-date changes, or loss of both responsibilities', () => {
    const due: Job = { ...job, target_type: 'member', target_id: 'member-example', payload: { ...job.payload, reason: 'due_soon', dueDate: '2026-10-10' } };
    const task = { assignee_id: 'member-example', due_date: '2026-10-10', statuses: { is_done: false } };
    expect(currentPersonalPayload(due, task)).toBeDefined();
    expect(currentPersonalPayload(due, { ...task, statuses: { is_done: true } })).toBeUndefined();
    expect(currentPersonalPayload(due, { ...task, due_date: '2026-10-20' })).toBeUndefined();
    expect(currentPersonalPayload(due, { ...task, completed_at: '2026-10-09T12:00:00Z' })).toBeUndefined();
    expect(currentPersonalPayload(due, { ...task, assignee_id: 'other', reviewer_id: 'another-reviewer' })).toBeUndefined();
  });
  it('delivers a reviewer-only due reminder and rechecks that responsibility before posting', async () => {
    const due: Job = { ...job, target_type: 'member', target_id: 'member-example',
      payload: { ...job.payload, kind: 'personal', reason: 'due_soon', dueDate: '2026-10-10' } };
    const task = { assignee_id: null as string | null, reviewer_id: 'member-example', due_date: '2026-10-10', statuses: { is_done: false } };
    expect(currentPersonalPayload(due, task)).toBeDefined();
    expect(currentPersonalPayload(due, { ...task, assignee_id: 'other' })).toBeDefined();
    const t = setup(); let reviewer: string | null = 'member-example';
    t.store.config = async () => ({ ...config, dmEnabled: true });
    t.store.currentTask = async () => ({ ...task, reviewer_id: reviewer });
    t.store.reminderPaused = vi.fn(async () => false);
    const fetcher = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const endpoint = String(input);
      if (endpoint.includes('/auth.test')) return Response.json({ ok: true, team_id: 'TEXAMPLE' });
      if (endpoint.includes('/users.info')) return Response.json({ ok: true, user: { team_id: 'TEXAMPLE' } });
      if (endpoint.includes('/conversations.open')) return Response.json({ ok: true, channel: { id: 'DEXAMPLE' } });
      t.sent.push(JSON.parse(String(init?.body))); return Response.json({ ok: true, ts: '1791158400.000001' });
    }) as unknown as typeof fetch;
    expect(await deliverJob(due, 'owner', t.store, 'https://example.com', fetcher)).toBe('sent');
    expect(t.sent).toHaveLength(1); expect(t.sent[0].channel).toBe('DEXAMPLE');
    t.store.canSend = async () => { reviewer = null; return true; };
    expect(await deliverJob({ ...due, id: 2 }, 'owner', t.store, 'https://example.com', fetcher)).toBe('skipped');
    expect(t.sent).toHaveLength(1); expect(t.results[1].error).toBe('recipient_no_longer_responsible');
  });
  it('sends a standalone weekly DM containing only tasks allowed by recipient RLS', async () => {
    const t = setup(); const posted: Record<string, unknown>[] = [];
    t.store.config = async () => ({ ...config, dmEnabled: true, weekly: { enabled: true }, routes: [
      ...config.routes, { lineId: 'other-line', channelId: 'COTHER' }] });
    t.store.project = async () => { throw new Error('weekly job is not a task'); };
    t.store.canReadTask = async (_member, _team, id) => id === 'visible-task';
    t.store.weeklyTasks = async () => [
      { taskId: 'visible-task', taskKey: 'EX-1', taskTitle: 'Visible', projectId: 'project-example', lineId: 'line-example', dueDate: '2026-10-04', projectName: 'Example' },
      { taskId: 'private-task', taskKey: 'OTHER-1', taskTitle: 'Private', projectId: 'other-project', lineId: 'other-line', dueDate: '2026-10-06', projectName: 'Private' },
    ];
    const fetcher = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith('/auth.test')) return Response.json({ ok: true, team_id: 'TEXAMPLE' });
      if (url.pathname.endsWith('/users.info')) return Response.json({ ok: true, user: { team_id: 'TEXAMPLE' } });
      if (url.pathname.endsWith('/conversations.members')) return Response.json({ ok: true,
        members: url.searchParams.get('channel') === 'CEXAMPLE' ? ['UEXAMPLE'] : [] });
      if (url.pathname.endsWith('/conversations.open')) return Response.json({ ok: true, channel: { id: 'DEXAMPLE' } });
      posted.push(JSON.parse(String(init?.body))); return Response.json({ ok: true, ts: '1791158400.000001' });
    }) as unknown as typeof fetch;
    const weekly: Job = { ...job, target_type: 'member', target_id: 'member-example', payload: { kind: 'weekly', weekStart: '2026-10-05' } };
    expect(await deliverJob(weekly, 'owner', t.store, 'https://example.com', fetcher, Date.parse('2026-10-05T09:00:00+08:00'))).toBe('sent');
    expect(posted).toHaveLength(1); expect(posted[0]).not.toHaveProperty('thread_ts');
    expect(JSON.stringify(posted)).toContain('Visible'); expect(JSON.stringify(posted)).not.toContain('Private');
    expect(posted[0].text).toContain('逾期 1 張、當週到期 0 張');
  });
  it('retries transient Slack read failures without attempting a post', async () => {
    const t = setup();
    const fetcher = vi.fn(async () => Response.json({ ok: false, error: 'internal_error' })) as unknown as typeof fetch;
    expect(await deliverJob(job, 'owner', t.store, 'https://example.com', fetcher)).toBe('pending');
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});
describe('Slack report delivery receipts', () => {
  it.each([{ data: { error: 'channel_not_found' } }, { data: { accepted: true } }, { data: null }, { error: new Error('network') }])(
    'does not mark an unsuccessful request as sent', result => expect(() => requireSlackReceipt(result)).toThrow());
  it('accepts only an explicit successful delivery', () => expect(() => requireSlackReceipt({ data: { success: true } })).not.toThrow());
});
