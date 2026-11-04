// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import { handleSlackNotify } from '../../docker/volumes/functions/slack-notify/service';
import { createActions } from '../../docker/volumes/functions/slack-interact/backend';
import { convertMrkdwn } from '../../docker/volumes/functions/slack-interact/core';
import { commentMentionIds, dmRecipients, fitText, mrkdwn, notifyChannelId, reportMessage, slackDmEligible } from '@/lib/slackNotifyCore';

type Row = Record<string, any>;
const environment: Record<string, string> = { SUPABASE_URL: 'https://db.example.com', SUPABASE_SERVICE_ROLE_KEY: 'example-service-role-key-with-32-characters',
  SUPABASE_ANON_KEY: 'example-anon', APP_BASE_URL: 'https://app.example.com', JWT_SECRET: 'example-only-secret-with-at-least-32-characters' };
const env = { get: (name: string) => environment[name] };
afterEach(() => vi.unstubAllGlobals());

function backend(tables: Record<string, Row[]> = {}, directoryPageSize = Number.MAX_SAFE_INTEGER) {
  const db: Record<string, Row[]> = {
    members: [
      { id: 'actor', name: 'Example actor', email: 'actor@example.com', role: 'member', is_active: true, email_identity_verified: true, auth_id: 'auth-actor' },
      { id: 'assignee', name: 'Example assignee', email: 'assignee@example.com', role: 'member', is_active: true, email_identity_verified: true },
      { id: 'reviewer', name: 'Example reviewer', email: 'reviewer@example.com', role: 'member', is_active: true, email_identity_verified: true },
      { id: 'outsider', name: 'Example outsider', email: 'outsider@example.com', role: 'member', is_active: true, email_identity_verified: true },
      { id: 'guest', name: 'Example guest', email: 'guest@example.com', role: 'member', is_active: true, email_identity_verified: true }],
    tasks: [{ id: 'task', task_key: 'EX-1', title: 'Stored &lt;!channel&gt; title', priority: 'high', project_id: 'project', status_id: 'todo', assignee_id: 'assignee', reviewer_id: 'reviewer' }],
    projects: [{ id: 'project', name: 'Example <!here> project' }],
    statuses: [{ id: 'todo', name: 'Todo' }],
    slack_config: [{ id: 'singleton', bot_token: 'xoxb-example' }],
    backup_settings: [{ task_notify_channel: 'notify', dm_notify_enabled: true, dm_notify_start_hour: 0, dm_notify_end_hour: 24 }],
    system_settings: [], comments: [], qa_slack_receipts: [], slack_delivery_outbox: [], ...tables,
  };
  const slackUsers: Record<string, Row> = {
    'assignee@example.com': { id: 'UASSIGNEE', profile: { email: 'assignee@example.com' } },
    'reviewer@example.com': { id: 'UREVIEWER', profile: { email: 'reviewer@example.com' } },
    'outsider@example.com': { id: 'UOUTSIDER', profile: { email: 'outsider@example.com' } },
    'guest@example.com': { id: 'UGUEST', is_restricted: true, profile: { email: 'guest@example.com' } },
  };
  const slack: { method: string; args: Row }[] = [], rest: { table: string; auth: string }[] = [], failing = new Set<string>();
  const postResult = vi.fn(async () => Response.json({ ok: true, ts: '1.0' }));
  const fetcher = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input)), auth = String((init?.headers as Row)?.Authorization || '');
    if (url.hostname === 'slack.com') {
      const method = url.pathname.split('/').pop()!, args = init?.body ? JSON.parse(String(init.body)) : Object.fromEntries(url.searchParams);
      slack.push({ method, args });
      if (method === 'conversations.list') return Response.json({ ok: true, channels: [{ id: 'C0NOTIFY', name: 'notify' }, { id: 'C0REPORT', name: 'reports' }] });
      if (method === 'users.lookupByEmail') return slackUsers[args.email] ? Response.json({ ok: true, user: slackUsers[args.email] }) : Response.json({ ok: false, error: 'users_not_found' });
      if (method === 'conversations.open') return Response.json({ ok: true, channel: { id: `D${args.users}` } });
      if (method === 'chat.postMessage') return postResult();
      return Response.json({ ok: true, ts: '1.0' });
    }
    if (url.pathname === '/auth/v1/user') return auth === 'Bearer member-jwt' ? Response.json({ id: 'auth-actor' }) : Response.json({}, { status: 401 });
    if (url.pathname === '/functions/v1/slack-notify') return handleSlackNotify(new Request(url, init), env, fetcher as unknown as typeof fetch);
    const table = url.pathname.split('/').pop()!;
    rest.push({ table, auth });
    if (failing.has(table)) return Response.json({ message: 'relation "backup_settings" does not exist (10.0.0.5:5432)' }, { status: 500 });
    if (table === 'qa_slack_receipts' && init?.method === 'POST') {
      expect(auth).toBe(`Bearer ${environment.SUPABASE_SERVICE_ROLE_KEY}`);
      expect((init.headers as Row).Prefer).toBe('return=representation,resolution=ignore-duplicates');
      expect(url.searchParams.get('on_conflict')).toBe('id');
      const row = JSON.parse(String(init.body));
      expect(row.workspace_id).toBe('default');
      if (db.qa_slack_receipts.some(existing => existing.id === row.id)) return Response.json([]);
      db.qa_slack_receipts.push(row);
      return Response.json([row]);
    }
    const rows = (db[table] || []).filter(row => [...url.searchParams].every(([key, value]) => {
      if (['select', 'limit', 'order', 'offset'].includes(key)) return true;
      if (value.startsWith('eq.')) return String(row[key]) === value.slice(3);
      if (value.startsWith('in.(')) return value.slice(4, -1).split(',').includes(String(row[key]));
      return true;
    }));
    const offset = url.searchParams.get('offset');
    return Response.json(offset === null ? rows : rows.slice(Number(offset), Number(offset) + directoryPageSize));
  });
  vi.stubGlobal('fetch', fetcher);
  const send = async (payload: Row, token = 'member-jwt') => {
    const response = await handleSlackNotify(new Request('https://example.com/functions/v1/slack-notify', { method: 'POST',
      headers: { Authorization: `Bearer ${token}` }, body: JSON.stringify(payload) }), env, fetcher as unknown as typeof fetch);
    return { status: response.status, body: await response.json() as Row };
  };
  const posts = () => slack.filter(call => call.method === 'chat.postMessage').map(call => call.args);
  const text = (post: Row) => JSON.stringify(post.blocks) + post.text;
  return { db, slack, rest, send, posts, text, fetcher, failing, postResult };
}
const recent = (content: string, user = 'actor') => ({ id: 'comment-1', task_id: 'task', user_id: user, content, source: 'web', created_at: new Date().toISOString() });
const commentEvent = (commentId = 'comment-1') => ({ type: 'comment_added', taskId: 'task', commentId });

describe('Slack notification text rules', () => {
  it('escapes Slack control characters after decoding, so encoded mentions stay inert', () => {
    const decoded = convertMrkdwn('ping &lt;!channel&gt; and <!here> and &lt;https://phish.example.com|LIVO&gt;').plain;
    expect(decoded).toContain('<!channel>');
    expect(mrkdwn(decoded)).not.toMatch(/<!channel>|<https:/);
    expect(mrkdwn('a & <b>')).toBe('a &amp; &lt;b&gt;');
    expect(fitText(`${'x'.repeat(10)}&amp;`, 13)).toBe('xxxxxxxxxx…');
  });
  it('builds report blocks itself and names the sender', () => {
    const msg = reportMessage('Weekly <!channel>', '<https://phish.example.com|Reset password>', '<!here> Example');
    const json = JSON.stringify(msg);
    expect(json).not.toMatch(/<!channel>|<https:\/\/phish/);
    expect(msg.blocks[1]).toEqual({ type: 'context', elements: [{ type: 'plain_text', text: '由 <!here> Example 透過 LIVO 傳送', emoji: false }] });
  });
  it('accepts only channels, never a person or DM id', () => {
    const channels = [{ id: 'C0NOTIFY', name: 'notify' }, { id: 'UUSER', name: 'user' }];
    expect(notifyChannelId(channels, '#notify')).toBe('C0NOTIFY');
    expect(notifyChannelId(channels, 'G0PRIVATE')).toBe('G0PRIVATE');
    for (const target of ['UUSER', 'user', 'DPRIVATE', 'WENTERPRISE', 'unknown', '', 42]) expect(notifyChannelId(channels, target)).toBeUndefined();
  });
  it('limits DMs to stored task recipients and full Slack accounts with the same email', () => {
    const task = { assignee_id: 'assignee', reviewer_id: 'reviewer' };
    expect([...dmRecipients('comment_added', task, 'actor', ['guest', 'actor'])]).toEqual([['guest', 'mention'], ['assignee', 'comment'], ['reviewer', 'comment']]);
    expect([...dmRecipients('assignee_changed', task, 'assignee')]).toEqual([['reviewer', 'reviewer']]);
    expect(dmRecipients('status_changed', task, 'actor').size).toBe(0);
    expect(commentMentionIds('<span data-type="mention" data-id="guest">@g</span><span data-id="x&quot;"></span>')).toEqual(['guest']);
    const user = { id: 'UPERSON', profile: { email: 'Person@Example.com' } };
    expect(slackDmEligible(user, 'person@example.com')).toBe(true);
    for (const flag of ['deleted', 'is_bot', 'is_restricted', 'is_ultra_restricted']) expect(slackDmEligible({ ...user, [flag]: true }, 'person@example.com')).toBe(false);
    expect(slackDmEligible(user, 'other@example.com')).toBe(false);
  });
});

describe('Docker slack-notify', () => {
  it('rejects callers without an active LIVO account', async () => {
    const t = backend();
    expect((await t.send({ type: 'report', reportContent: 'Hello' }, 'forged')).status).toBe(401);
    expect(t.posts()).toEqual([]);
  });
  it('never posts caller-built report blocks and escapes report text', async () => {
    const t = backend();
    const result = await t.send({ type: 'report', channelTarget: 'reports', reportTitle: 'Weekly <!channel>',
      reportContent: 'Ping &lt;!channel&gt; and <https://phish.example.com|LIVO login>',
      blocks: [{ type: 'section', text: { type: 'mrkdwn', text: '<!channel> <https://phish.example.com|Reset your LIVO password>' } }] });
    expect(result.body).toEqual({ success: true });
    const [post] = t.posts();
    expect(post.channel).toBe('C0REPORT');
    expect(t.text(post)).not.toMatch(/<!channel>|<!here>|<https:\/\/phish|Reset your LIVO password/);
    expect(t.text(post)).toContain('&amp;lt;!channel&amp;gt;');
    expect(t.text(post)).toContain('Example actor');
  });
  it.each(['UOUTSIDER', 'DPRIVATE', 'WENTERPRISE'])('refuses a report to a person or DM id (%s)', async target => {
    const t = backend();
    expect((await t.send({ type: 'report', channelTarget: target, reportContent: 'Hello' })).body.error).toBe('channel_not_found');
    expect(t.posts()).toEqual([]);
  });
  it('reads the task through the caller session and escapes everything that reaches mrkdwn', async () => {
    const t = backend({ comments: [recent('<p>&lt;!channel&gt; please check</p>')] });
    await t.send({ ...commentEvent(), taskKey: 'EX-1', taskTitle: '<https://phish.example.com|Forged>',
      actorName: '<!here> boss', projectName: 'Forged', commentPreview: 'forged preview' });
    expect(t.rest.filter(r => r.table === 'tasks').map(r => r.auth)).toEqual(['Bearer member-jwt']);
    const [post] = t.posts();
    expect(post.channel).toBe('C0NOTIFY');
    const body = t.text(post);
    expect(body).not.toMatch(/<!channel>|<!here>|phish\.example\.com|forged preview|Forged/);
    expect(body).toContain('<https://app.example.com/?task=EX-1|EX-1 - Stored &amp;lt;!channel&amp;gt; title>');
    expect(body).toContain('&lt;!channel&gt; please check');
    expect(body).toContain('Example &lt;!here&gt; project');
  });
  it('refuses a task the caller cannot read and a comment notice without a new comment', async () => {
    const t = backend();
    expect((await t.send({ type: 'status_changed', taskId: 'missing' })).status).toBe(404);
    expect((await t.send({ type: 'comment_added', taskId: 'task' })).body.error).toBe('comment_unavailable');
    expect(t.posts()).toEqual([]);
  });
  it('sends DMs only to stored task recipients, by email, never to guests or display-name matches', async () => {
    const t = backend({ comments: [recent('<p><span data-type="mention" data-id="guest">@Example guest</span> hi</p>')] });
    await t.send({ ...commentEvent(), dmTargets: [
      { email: 'outsider@example.com', reason: 'Spoofed' }, { email: 'guest@example.com', reason: '你在留言中被提及' },
      { email: 'nobody@example.com', name: 'Example assignee', reason: '你被指派為經辦人' }, { email: 'reviewer@example.com', reason: 'x' }] });
    const dms = t.posts().filter(post => String(post.channel).startsWith('D'));
    expect(dms.map(post => post.channel)).toEqual(['DUREVIEWER']);
    expect(t.slack.some(call => call.method === 'users.list')).toBe(false);
    expect(t.text(dms[0])).toContain('你的任務有新留言');
    expect(t.text(dms[0])).not.toContain('Spoofed');
  });
  it('sends a manually typed mention in a stored comment without trusting the request preview', async () => {
    const t = backend({ comments: [recent('<p>@Example&nbsp;outsider, please check.</p>')] });
    await t.send({ ...commentEvent(), commentPreview: '@Example reviewer',
      dmTargets: [{ email: 'outsider@example.com' }] });
    expect(t.posts().map(post => post.channel)).toEqual(['C0NOTIFY', 'DUOUTSIDER']);
    expect(t.text(t.posts()[1])).toContain('你在留言中被提及');
    expect(t.slack.filter(call => call.method === 'users.lookupByEmail').map(call => call.args.email))
      .toEqual(['outsider@example.com']);
  });
  it('keeps a typed name ambiguous when another active match is on a later directory page', async () => {
    const t = backend({ comments: [recent('<p>@Example outsider, please check.</p>')] }, 4);
    t.db.members.push({ id: 'same-name', name: 'Example outsider', email: 'same-name@example.com',
      role: 'member', is_active: true, email_identity_verified: false });
    await t.send({ ...commentEvent(), dmTargets: [{ email: 'outsider@example.com' }] });
    expect(t.posts().map(post => post.channel)).toEqual(['C0NOTIFY']);
    expect(t.slack.some(call => call.method === 'users.lookupByEmail')).toBe(false);
  });
  it('uses the exact delayed comment and ignores repeats even after a newer comment', async () => {
    const first = { ...recent('<p>Earlier note <span data-id="outsider">@Example outsider</span></p>'), id: 'first',
      created_at: new Date(Date.now() - 1000).toISOString() };
    const second = { ...recent('<p>Later note</p>'), id: 'second' };
    const t = backend({ comments: [second, first] });
    const event = { ...commentEvent('first'), dmTargets: [{ email: 'outsider@example.com', reason: 'mention' }] };
    expect((await t.send(event)).body).toEqual({ success: true });
    expect((await t.send(commentEvent('second'))).body).toEqual({ success: true });
    expect((await t.send(event)).body).toEqual({ success: true, duplicate: true });
    expect(t.posts().map(post => post.channel)).toEqual(['C0NOTIFY', 'DUOUTSIDER', 'C0NOTIFY']);
    expect(t.text(t.posts()[0])).toContain('Earlier note');
    expect(t.text(t.posts()[1])).toContain('Earlier note');
    expect(t.text(t.posts()[2])).toContain('Later note');
  });
  it('claims one comment across concurrent requests', async () => {
    const t = backend({ comments: [recent('One note')] });
    const results = await Promise.all([t.send(commentEvent()), t.send(commentEvent())]);
    expect(results.filter(result => result.body.duplicate === true)).toHaveLength(1);
    expect(t.posts()).toHaveLength(1);
    expect(t.db.qa_slack_receipts).toHaveLength(1);
  });
  it('requires the persisted comment ID to match the task and active author', async () => {
    const t = backend({ comments: [recent('Own note'),
      { ...recent('Another author', 'reviewer'), id: 'other-author' },
      { ...recent('Another task'), id: 'other-task', task_id: 'different-task' },
      { ...recent('Future note'), id: 'future', created_at: new Date(Date.now() + 120000).toISOString() }] });
    for (const commentId of [undefined, 'missing', 'other-author', 'other-task', 'future']) {
      expect(await t.send({ ...commentEvent(), commentId })).toEqual({ status: 404, body: { error: 'comment_unavailable' } });
    }
    expect(t.posts()).toEqual([]);
    expect(t.db.qa_slack_receipts).toEqual([]);
  });
  it('leaves the comment available to send after a destination is repaired', async () => {
    const t = backend({ comments: [recent('After configuration')] });
    t.db.backup_settings[0].task_notify_channel = 'unknown-channel';
    expect((await t.send(commentEvent())).body).toEqual({ error: 'channel_not_found' });
    expect(t.db.qa_slack_receipts).toEqual([]);
    t.db.backup_settings[0].task_notify_channel = 'C0NOTIFY';
    expect((await t.send(commentEvent())).body).toEqual({ success: true });
    expect(t.posts()).toHaveLength(1);
  });
  it.each(['rejected', 'unknown'] as const)('keeps the receipt after a %s post outcome', async outcome => {
    const t = backend({ comments: [recent('One attempt')] });
    if (outcome === 'rejected') t.postResult.mockResolvedValueOnce(Response.json({ ok: false, error: 'not_in_channel' }));
    else t.postResult.mockResolvedValueOnce(new Response('invalid acknowledgement'));
    expect(await t.send(commentEvent())).toEqual({ status: 502,
      body: { error: outcome === 'rejected' ? 'comment_delivery_failed' : 'comment_delivery_unknown' } });
    expect((await t.send(commentEvent())).body).toEqual({ success: true, duplicate: true });
    expect(t.posts()).toHaveLength(1);
  });
  it('sends no DM to a member who unlinked Slack in My settings', async () => {
    const t = backend({ slack_link_preferences: [{ member_id: 'reviewer', linking_disabled: true }, { member_id: 'assignee', linking_disabled: false }] });
    await t.send({ type: 'assignee_changed', taskId: 'task',
      dmTargets: [{ email: 'assignee@example.com', reason: 'x' }, { email: 'reviewer@example.com', reason: 'x' }] });
    expect(t.posts().filter(post => String(post.channel).startsWith('D')).map(post => post.channel)).toEqual(['DUASSIGNEE']);
    expect(t.slack.filter(call => call.method === 'users.lookupByEmail').map(call => call.args.email)).toEqual(['assignee@example.com']);
  });
  it('does not look up or DM a self-asserted member email, even when a client claims a target', async () => {
    const t = backend();
    t.db.members.find(member => member.id === 'assignee')!.email_identity_verified = false;
    await t.send({ type: 'assignee_changed', taskId: 'task',
      dmTargets: [{ email: 'assignee@example.com', reason: 'x', email_identity_verified: true }] });
    expect(t.slack.filter(call => call.method === 'users.lookupByEmail').map(call => call.args.email)).not.toContain('assignee@example.com');
    expect(t.posts().filter(post => String(post.channel).startsWith('D')).map(post => post.channel)).not.toContain('DUASSIGNEE');
  });
  it('keeps the database outbox as the single sender when durable delivery is on', async () => {
    const delivery: { enabled: boolean; routes: unknown[] } = { enabled: true, routes: [] };
    const t = backend({ system_settings: [{ key: 'slack_delivery', value: delivery }],
      comments: [recent('Already queued')], slack_delivery_outbox: [{ id: 'job', task_id: 'task', event_key: 'comment:comment-1' }] });
    expect((await t.send({ type: 'status_changed', taskId: 'task' })).body).toEqual({ accepted: true, managedBy: 'database' });
    expect((await t.send(commentEvent())).body).toEqual({ accepted: true, managedBy: 'database' });
    delivery.enabled = false;
    expect((await t.send(commentEvent())).body).toEqual({ accepted: true, managedBy: 'database' });
    expect(t.posts()).toEqual([]);
    expect(t.db.qa_slack_receipts).toEqual([]);
  });
  it('refuses fabricated approval notices and returns only generic errors', async () => {
    const t = backend();
    expect((await t.send({ type: 'approval_completed', blocks: [] })).status).toBe(409);
    t.failing.add('backup_settings');
    const failed = await t.send({ type: 'report', reportContent: 'x' });
    expect(failed).toEqual({ status: 500, body: { error: 'notify_failed' } });
  });
  it('delivers Slack comments as escaped text to the comment recipients', async () => {
    const converted = convertMrkdwn('&lt;!channel&gt; <!here> hi <@UOUTSIDER> <@UGUEST>', {
      UOUTSIDER: { id: 'outsider', name: 'Example outsider' }, UGUEST: { id: 'guest', name: 'Example guest' },
    });
    const t = backend({ comments: [{ ...recent(converted.html), source: 'slack' }, { ...recent('Unrelated newer note'), id: 'other' }] });
    const actions = createActions(env, () => {});
    const actor = { id: 'actor', name: 'Forged caller name', jwt: 'member-jwt' };
    const receipt = { kind: 'comment', task: t.db.tasks[0], comment_id: 'comment-1', preview: 'Caller preview', mentioned_ids: converted.mentionedIds };
    await actions.deliver(actor, receipt, { channel: 'C0OTHER' });
    await actions.deliver(actor, receipt, { channel: 'C0OTHER' });
    const [channelPost, ...dms] = t.posts();
    expect(channelPost.channel).toBe('C0NOTIFY');
    expect(t.text(channelPost)).not.toMatch(/<!channel>|<!here>/);
    expect(t.text(channelPost)).toContain('&lt;!channel&gt;');
    expect(t.text(channelPost)).toContain('Example actor');
    expect(t.text(channelPost)).not.toMatch(/Caller preview|Forged caller name|Unrelated newer note/);
    // Mentioned members and the task's assignee/reviewer; a Slack guest never gets one.
    expect(dms.map(post => post.channel).sort()).toEqual(['DUASSIGNEE', 'DUOUTSIDER', 'DUREVIEWER']);
    expect(t.text(dms.find(post => post.channel === 'DUOUTSIDER')!)).toContain('你在留言中被提及');
  });
  it('rejects legacy service requests for web comments or inactive authors', async () => {
    const t = backend({ comments: [recent('Web note'), { ...recent('Slack note'), id: 'slack-note', source: 'slack' }] });
    const service = environment.SUPABASE_SERVICE_ROLE_KEY;
    expect((await t.send({ ...commentEvent(), actorId: 'actor' }, service)).status).toBe(404);
    t.db.members.find(member => member.id === 'actor')!.is_active = false;
    expect((await t.send({ ...commentEvent('slack-note'), actorId: 'actor' }, service)).status).toBe(404);
    expect(t.posts()).toEqual([]);
    expect(t.db.qa_slack_receipts).toEqual([]);
  });
});
