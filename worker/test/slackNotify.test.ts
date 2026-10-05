// @vitest-environment node
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
vi.mock('../src/license', () => ({ checkProfessional: async () => true }));
import { handleSlackNotify, runSlackDigest } from '../src/functions/slack';
import type { AuthCtx, Env } from '../src/env';

type Row = Record<string, any>;
const databases: DatabaseSync[] = [];
afterEach(() => { for (const db of databases.splice(0)) db.close(); vi.unstubAllGlobals(); });
function fixture() {
  const db = new DatabaseSync(':memory:'); databases.push(db);
  db.exec(readFileSync(path.resolve(__dirname, '../schema.sql'), 'utf8'));
  for (const [id, email] of [['actor', 'actor@example.com'], ['assignee', 'assignee@example.com'], ['reviewer', 'reviewer@example.com'],
    ['outsider', 'outsider@example.com'], ['guest', 'guest@example.com']])
    db.prepare("INSERT INTO members(id,workspace_id,name,avatar,email,is_active) VALUES(?,?,?,?,?,1)").run(id, 'one', `Example ${id}`, '', email);
  db.exec(`INSERT INTO product_lines(id,workspace_id,name) VALUES('line','one','Line');
    INSERT INTO projects(id,workspace_id,line_id,name,key) VALUES('project','one','line','Example <!here> project','EX');
    INSERT INTO statuses(id,workspace_id,name) VALUES('todo','one','Todo');
    INSERT INTO tasks(id,workspace_id,task_key,project_id,title,status_id,priority,creator_id,assignee_id,reviewer_id)
      VALUES('task','one','EX-1','project','Stored &lt;!channel&gt; title','todo','high','actor','assignee','reviewer');
    INSERT INTO slack_config(id,bot_token) VALUES('one','xoxb-example');
    INSERT INTO backup_settings(id,workspace_id,task_notify_channel) VALUES('settings','one','C0NOTIFY');`);
  const statement = (sql: string, values: unknown[] = []) => ({
    first: async () => db.prepare(sql).get(...values as never[]) ?? null,
    all: async () => ({ results: db.prepare(sql).all(...values as never[]) }),
    run: async () => { const r = db.prepare(sql).run(...values as never[]); return { meta: { changes: Number(r.changes) } }; },
  });
  const env = { APP_BASE_URL: 'https://app.example.com', DB: { prepare: (sql: string) => ({ ...statement(sql), bind: (...v: unknown[]) => statement(sql, v) }) } } as unknown as Env;
  const auth: AuthCtx = { userId: 'actor-auth', email: 'actor@example.com', member: { id: 'actor', name: 'Example actor', role: 'member', email: 'actor@example.com', workspaceId: 'one' } };
  const calls: { method: string; args: Row }[] = [];
  const users: Record<string, Row> = {
    'assignee@example.com': { id: 'UASSIGNEE', profile: { email: 'assignee@example.com' } },
    'reviewer@example.com': { id: 'UREVIEWER', profile: { email: 'reviewer@example.com' } },
    'outsider@example.com': { id: 'UOUTSIDER', profile: { email: 'outsider@example.com' } },
    'guest@example.com': { id: 'UGUEST', is_restricted: true, profile: { email: 'guest@example.com' } },
  };
  vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input)), method = url.pathname.split('/').pop()!;
    const args = init?.body ? JSON.parse(String(init.body)) : Object.fromEntries(url.searchParams);
    calls.push({ method, args });
    if (method === 'conversations.list') return Response.json({ ok: true, channels: [{ id: 'C0NOTIFY', name: 'notify' }, { id: 'C0REPORT', name: 'reports' }] });
    if (method === 'users.lookupByEmail') return users[args.email] ? Response.json({ ok: true, user: users[args.email] }) : Response.json({ ok: false, error: 'users_not_found' });
    if (method === 'users.list') return Response.json({ ok: true, members: [{ id: 'UNAMESAKE1', real_name: 'Example assignee', profile: { display_name: 'Example assignee' } },
      { id: 'UNAMESAKE2', real_name: 'Example outsider', profile: { display_name: 'Example outsider' } }] });
    if (method === 'conversations.open') return Response.json({ ok: true, channel: { id: `D${args.users}` } });
    return Response.json({ ok: true, ts: '1.0' });
  }));
  const send = async (payload: Row) => {
    const c = { env, get: () => auth, req: { json: async () => payload },
      json: (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } }) };
    const response = await handleSlackNotify(c as never);
    return { status: response.status, body: await response.json() as Row };
  };
  const posts = () => calls.filter(call => call.method === 'chat.postMessage').map(call => call.args);
  const text = (post: Row) => JSON.stringify(post.blocks) + post.text;
  return { db, env, send, calls, posts, text };
}

describe('cloud slack-notify', () => {
  it('never posts caller-built report blocks and escapes report text', async () => {
    const f = fixture();
    const result = await f.send({ type: 'report', channelTarget: 'reports', reportTitle: 'Weekly <!channel>',
      reportContent: 'Ping &lt;!channel&gt; and <https://phish.example.com|LIVO login>',
      blocks: [{ type: 'section', text: { type: 'mrkdwn', text: '<!channel> <https://phish.example.com|Reset your LIVO password>' } }] });
    expect(result.body).toEqual({ success: true });
    const [post] = f.posts();
    expect(post.channel).toBe('C0REPORT');
    expect(f.text(post)).not.toContain('<https://phish');
    expect(f.text(post)).not.toContain('Reset your LIVO password');
    expect(f.text(post)).not.toMatch(/<!channel>|<!here>/);
    expect(f.text(post)).toContain('&amp;lt;!channel&amp;gt;');
    expect(f.text(post)).toContain('Example actor');
  });
  it.each(['UOUTSIDER', 'DPRIVATE', 'WENTERPRISE'])('refuses a report to a person or DM id (%s)', async target => {
    const f = fixture();
    const result = await f.send({ type: 'report', channelTarget: target, reportContent: 'Hello' });
    expect(result.body.error).toBeTruthy();
    expect(f.posts()).toEqual([]);
  });
  it('builds task notices from the stored task, escaping everything that reaches mrkdwn', async () => {
    const f = fixture();
    f.db.exec("INSERT INTO comments(id,workspace_id,task_id,user_id,content) VALUES('c1','one','task','actor','<p>&lt;!channel&gt; please check</p>')");
    await f.send({ type: 'comment_added', taskId: 'task', taskKey: 'EX-1', taskTitle: '<https://phish.example.com|Forged>',
      actorName: '<!here> boss', projectName: 'Forged', commentPreview: '&lt;!channel&gt; forged' });
    const [post] = f.posts();
    expect(post.channel).toBe('C0NOTIFY');
    const body = f.text(post);
    expect(body).not.toMatch(/<!channel>|<!here>/);
    expect(body).not.toContain('phish.example.com');
    expect(body).toContain('<https://app.example.com/demo/?task=EX-1|EX-1 - Stored &amp;lt;!channel&amp;gt; title>');
    expect(body).toContain('Example actor');
    expect(body).toContain('Example &lt;!here&gt; project');
  });
  it('sends DMs only to stored task recipients, by email, never to guests or display-name matches', async () => {
    const f = fixture();
    f.db.exec("INSERT INTO comments(id,workspace_id,task_id,user_id,content) VALUES('c1','one','task','actor','<p><span data-type=\"mention\" data-id=\"guest\">@Example guest</span> hi</p>')");
    await f.send({ type: 'comment_added', taskId: 'task', commentPreview: 'hi', dmTargets: [
      { email: 'outsider@example.com', reason: 'Spoofed' }, { email: 'guest@example.com', reason: '你在留言中被提及' },
      { email: 'nobody@example.com', name: 'Example assignee', reason: '你被指派為經辦人' }, { email: 'reviewer@example.com', reason: 'x' }] });
    const dms = f.posts().filter(post => String(post.channel).startsWith('D'));
    expect(dms.map(post => post.channel)).toEqual(['DUREVIEWER']);
    expect(f.calls.some(call => call.method === 'users.list')).toBe(false);
    expect(f.text(dms[0])).toContain('你的任務有新留言');
    expect(f.text(dms[0])).not.toContain('Spoofed');
  });
  it('sends task digests only to the email-matched account, with escaped titles', async () => {
    const f = fixture();
    const hour = new Date(Date.now() + 8 * 60 * 60 * 1000).getUTCHours();
    f.db.prepare("INSERT INTO user_notification_preferences(workspace_id,user_id,enabled,frequency,hour) VALUES('one','assignee',1,'daily',?)").run(hour);
    f.db.prepare("INSERT INTO user_notification_preferences(workspace_id,user_id,enabled,frequency,hour) VALUES('one','outsider',1,'daily',?)").run(hour);
    f.db.exec(`UPDATE members SET email='renamed@example.com' WHERE id='outsider';
      INSERT INTO tasks(id,workspace_id,task_key,project_id,title,status_id,priority,creator_id,assignee_id)
        VALUES('task-2','one','EX-2','project','<!channel> urgent','todo','high','actor','outsider')`);
    await runSlackDigest(f.env, { waitUntil: () => {} } as never);
    const dms = f.posts();
    expect(dms.map(post => post.channel)).toEqual(['DUASSIGNEE']);
    expect(f.calls.some(call => call.method === 'users.list')).toBe(false);
    expect(f.text(dms[0])).toContain('Stored &amp;lt;!channel&amp;gt; title');
  });
  it('sends no task DM or digest to a member who unlinked Slack in My settings', async () => {
    const f = fixture();
    const hour = new Date(Date.now() + 8 * 60 * 60 * 1000).getUTCHours();
    f.db.exec(`INSERT INTO slack_link_preferences(workspace_id,member_id,linking_disabled,updated_at) VALUES('one','reviewer',1,'2026-10-04T00:00:00Z'),('one','assignee',0,'2026-10-04T00:00:00Z')`);
    await f.send({ type: 'assignee_changed', taskId: 'task', dmTargets: [{ email: 'assignee@example.com', reason: 'x' }, { email: 'reviewer@example.com', reason: 'x' }] });
    expect(f.posts().filter(post => String(post.channel).startsWith('D')).map(post => post.channel)).toEqual(['DUASSIGNEE']);
    f.calls.length = 0;
    f.db.exec("UPDATE slack_link_preferences SET linking_disabled=1 WHERE member_id='assignee'");
    f.db.prepare("INSERT INTO user_notification_preferences(workspace_id,user_id,enabled,frequency,hour) VALUES('one','assignee',1,'daily',?)").run(hour);
    await runSlackDigest(f.env, { waitUntil: () => {} } as never);
    expect(f.posts()).toEqual([]);
    expect(f.calls.some(call => call.method === 'users.lookupByEmail')).toBe(false);
  });
  it('returns a generic error instead of internal details', async () => {
    const f = fixture();
    f.db.exec('DROP TABLE backup_settings');
    const result = await f.send({ type: 'report', channelTarget: 'reports', reportContent: 'Hello' });
    expect(result.status).toBe(500);
    expect(result.body).toEqual({ error: 'notify_failed' });
  });
});
