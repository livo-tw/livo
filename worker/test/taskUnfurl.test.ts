// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { runQuery } from '../src/db';
import { createCloudTaskUnfurlActions } from '../src/taskUnfurl';
import { createCloudQaSlackActions } from '../src/qaSlack';
import { handleTaskUnfurl } from '../src/slackTaskUnfurl';
import type { AuthCtx, Env } from '../src/env';

type Row = Record<string, any>;
const route = { enabled: true, teamId: 'TEXAMPLE', routes: [{ projectId: 'project-a', channelId: 'CEXAMPLE' }] };
const context = { waitUntil: (_promise: Promise<unknown>): void => {} };
describe('cloud task preview authority (real SQLite)', () => {
  let db: DatabaseSync, env: Env;
  const auth: AuthCtx = { userId: 'auth-a', email: 'alex@example.com', member: { id: 'member-a', name: 'Alex', email: 'alex@example.com', role: 'super_admin', workspaceId: 'ws-a' } };
  beforeEach(() => {
    db = new DatabaseSync(':memory:'); db.exec(readFileSync(new URL('../schema.sql', import.meta.url), 'utf8'));
    db.exec(`INSERT INTO slack_config(id,bot_token) VALUES('ws-a','synthetic-token');
      INSERT INTO auth_users(id,email) VALUES('auth-a','alex@example.com');
      INSERT INTO members(workspace_id,id,name,avatar,role,email,auth_id,email_identity_verified) VALUES('ws-a','member-a','Alex','','super_admin','alex@example.com','auth-a',1);
      INSERT INTO product_lines(workspace_id,id,name) VALUES('ws-a','line-a','Example line');
      INSERT INTO projects(workspace_id,id,line_id,name,key) VALUES('ws-a','project-a','line-a','Example project','EX');
      INSERT INTO statuses(workspace_id,id,name,color,sort_order) VALUES('ws-a','status-a','Open','#000000',0);
      INSERT INTO tasks(workspace_id,id,task_key,title,project_id,status_id,priority,creator_id) VALUES('ws-a','task-a','EX-12','Example card','project-a','status-a','medium','member-a');`);
    const statement = (sql: string, args: unknown[] = []): any => ({
      bind: (...params: unknown[]) => statement(sql, params),
      all: async () => ({ success: true, results: db.prepare(sql).all(...args as never[]) }),
      first: async () => db.prepare(sql).get(...args as never[]) || null,
      run: async () => ({ success: true, meta: { changes: Number(db.prepare(sql).run(...args as never[]).changes) } }),
    });
    env = { DB: { prepare: statement }, SLACK_BOT_TOKEN: 'synthetic-token', APP_BASE_URL: 'https://app.example.com',
      REALTIME: { idFromName: (name: string) => name, get: () => ({ fetch: async () => new Response('ok') }) } } as unknown as Env;
  });
  afterEach(() => { db.close(); vi.unstubAllGlobals(); });
  const saveRoute = () => db.prepare('INSERT INTO system_settings(workspace_id,key,value) VALUES(?,?,?)').run('ws-a', 'slack_delivery', JSON.stringify(route));
  const actor = () => ({ id: 'member-a', team: 'TEXAMPLE', slack_user: 'UEXAMPLE', auth });
  it.each(['insert', 'upsert', 'update'] as const)('only the current super_admin may %s channel authority, including column case', async op => {
    if (op !== 'insert') saveRoute();
    db.exec("UPDATE members SET role='admin' WHERE id='member-a'");
    for (const key of ['key', 'KEY']) {
      const response = await runQuery(env, context, auth, { table: 'system_settings', op, values: { [key]: 'slack_delivery', value: route }, filters: [{ col: 'key', op: 'eq', val: 'slack_delivery' }] });
      expect(response.error?.code).toBe('42501');
    }
    expect(db.prepare("SELECT value FROM system_settings WHERE workspace_id='ws-a' AND key='slack_delivery'").get()?.value).toBe(op === 'insert' ? undefined : JSON.stringify(route));
  });
  it('blocks broad admin updates while allowing an active owner to configure this workspace only', async () => {
    saveRoute(); db.exec("INSERT INTO system_settings(workspace_id,key,value) VALUES('ws-b','slack_delivery','{}'); UPDATE members SET role='admin' WHERE id='member-a'");
    await runQuery(env, context, auth, { table: 'system_settings', op: 'update', values: { value: { enabled: false } }, filters: [{ col: 'key', op: 'in', val: ['slack_delivery'] }] });
    expect(db.prepare("SELECT value FROM system_settings WHERE workspace_id='ws-a' AND key='slack_delivery'").get()?.value).toBe(JSON.stringify(route));
    db.exec("UPDATE members SET role='super_admin' WHERE id='member-a'");
    const response = await runQuery(env, context, auth, { table: 'system_settings', op: 'upsert', values: { key: 'slack_delivery', value: route } });
    expect(response.error).toBeNull();
    expect(db.prepare("SELECT value FROM system_settings WHERE workspace_id='ws-b' AND key='slack_delivery'").get()?.value).toBe('{}');
  });
  it('reads a card by key/id through the normal workspace query and refuses a stale login', async () => {
    const a = createCloudTaskUnfurlActions(env, 'ws-a', context, async () => actor());
    expect((await a.card(actor(), 'EX-12'))?.task.title).toBe('Example card');
    expect((await a.card(actor(), 'task-a'))?.project.name).toBe('Example project');
    expect(await a.card({ ...actor(), auth: { ...auth, member: { ...auth.member, workspaceId: 'ws-b' } } }, 'EX-12')).toBeUndefined();
    db.exec("UPDATE members SET is_active=0 WHERE id='member-a'");
    expect(await a.card(actor(), 'EX-12')).toBeUndefined();
  });
  it('does not infer a project route from the legacy global notification channel', async () => {
    db.exec("INSERT INTO backup_settings(workspace_id,id,task_notify_channel) VALUES('ws-a','backup-a','CEXAMPLE')");
    const a = createCloudTaskUnfurlActions(env, 'ws-a', context, async () => actor());
    expect(await a.config()).toBeUndefined(); saveRoute(); expect(await a.config()).toEqual(route);
  });
  it.each([
    ['verified email', true, false, false, true], ['unverified email', false, false, false, false],
    ['unlinked email', true, true, false, false], ['owner manual mapping', false, false, true, true],
  ])('uses the existing %s identity rules before task metadata', async (_label, verified, unlinked, manual, allowed) => {
    db.prepare('UPDATE members SET email_identity_verified=? WHERE id=?').run(verified ? 1 : 0, 'member-a');
    if (unlinked) db.exec("INSERT INTO slack_link_preferences(workspace_id,member_id,linking_disabled,updated_at) VALUES('ws-a','member-a',1,'2026-01-01T00:00:00Z')");
    if (manual) db.exec(`INSERT INTO members(workspace_id,id,name,avatar,role,email) VALUES('ws-a','owner-a','Owner','','super_admin','owner@example.com');
      INSERT INTO external_account_bindings(workspace_id,id,member_id,platform,platform_team_id,platform_user_id,is_verified,reconfirm_required,verified_by,verified_by_member_id)
      VALUES('ws-a','binding-a','member-a','slack','TEXAMPLE','UEXAMPLE',1,0,'admin','owner-a');`);
    const fetcher = vi.fn(async (input: string | URL | Request): Promise<Response> => {
      const method = new URL(String(input)).pathname.split('/').pop();
      if (method === 'auth.test') return Response.json({ ok: true, team_id: 'TEXAMPLE' });
      if (method === 'users.info') return Response.json({ ok: true, user: { id: 'UEXAMPLE', team_id: 'TEXAMPLE', profile: { email: 'alex@example.com' } } });
      throw new Error('unexpected_network');
    });
    vi.stubGlobal('fetch', fetcher);
    const actions = createCloudQaSlackActions(env, 'ws-a', context);
    const a = createCloudTaskUnfurlActions(env, 'ws-a', context, actions.actor);
    expect(!!await a.actor({ team_id: 'TEXAMPLE', user_id: 'UEXAMPLE' })).toBe(allowed);
    if (manual) {
      db.exec("UPDATE members SET role='admin' WHERE id='owner-a'");
      expect(await a.actor({ team_id: 'TEXAMPLE', user_id: 'UEXAMPLE' })).toBeUndefined();
    }
    expect(fetcher.mock.calls.some(([input]) => String(input).includes('chat.'))).toBe(false);
  });
  it('processes an approved card using the cloud adapter without a QA feature dependency', async () => {
    saveRoute(); const writes: Row[] = [];
    vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
      if (new URL(String(input)).pathname.endsWith('/conversations.info')) return Response.json({ ok: true, channel: { id: 'CEXAMPLE', is_channel: true, is_im: false, is_mpim: false, is_member: true } });
      if (String(input).endsWith('/chat.unfurl')) { writes.push(JSON.parse(String(init?.body))); return Response.json({ ok: true }); }
      throw new Error('unexpected_network');
    });
    await handleTaskUnfurl({ type: 'event_callback', team_id: 'TEXAMPLE', event: { type: 'link_shared', source: 'conversations_history', user: 'UEXAMPLE', channel: 'CEXAMPLE', message_ts: '1234567890.123456', links: [{ url: 'https://app.example.com/demo/?task=EX-12' }] } }, createCloudTaskUnfurlActions(env, 'ws-a', context, async () => actor()));
    expect(writes).toHaveLength(1); expect(JSON.stringify(writes)).toContain('Example card');
  });
});
