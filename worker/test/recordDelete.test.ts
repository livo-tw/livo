// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { executeQaAction } from '../src/qa';
import type { QaIssue } from '../src/qa/domain';
import type { Env, AuthCtx } from '../src/env';
import { runQuery } from '../src/db';

// Real schema.sql triggers and foreign keys on node:sqlite, as in qa.test.ts.
describe('deleting bugs and tasks on the cloud server', () => {
  let db: DatabaseSync;
  let removed: string[];
  let pending: Promise<unknown>[];
  beforeEach(() => {
    db = new DatabaseSync(':memory:');
    db.exec('PRAGMA foreign_keys=ON');
    db.exec(readFileSync(new URL('../schema.sql', import.meta.url), 'utf8'));
    db.exec(`INSERT INTO product_lines(workspace_id,id,name) VALUES('ws-a','line-a','Line'),('ws-b','line-b','Line');
      INSERT INTO projects(workspace_id,id,line_id,name,key) VALUES('ws-a','project-a','line-a','A','A'),('ws-b','project-b','line-b','B','B');
      INSERT INTO auth_users(id,email) VALUES('auth-admin','admin@example.com'),('auth-reporter','reporter@example.com'),('auth-qa','qa@example.com'),('auth-other','other@example.com'),('auth-b','b@example.com');
      INSERT INTO members(workspace_id,id,name,avatar,role,email,auth_id,is_qa_admin) VALUES
        ('ws-a','admin','Admin','','admin','admin@example.com','auth-admin',0),
        ('ws-a','reporter','Reporter','','member','reporter@example.com','auth-reporter',0),
        ('ws-a','qa-lead','QA','','member','qa@example.com','auth-qa',1),
        ('ws-a','other','Other','','member','other@example.com','auth-other',0),
        ('ws-b','member-b','B','','admin','b@example.com','auth-b',0);
      INSERT INTO system_settings(workspace_id,key,value) VALUES('ws-a','feature_toggles','{"qa":true}'),('ws-b','feature_toggles','{"qa":true}');
      INSERT INTO workspaces(id,name,storage_limit_mb) VALUES('ws-a','A',100);
      INSERT INTO statuses(workspace_id,id,name,sort_order,is_done,auto_start) VALUES
        ('ws-a','todo','To do',1,0,0),('ws-a','doing','Doing',2,0,1),('ws-a','done','Done',3,1,0),('ws-b','todo-b','To do',0,0,0);`);
    removed = []; pending = [];
  });
  afterEach(() => db.close());
  function atomic(fn: () => void) { db.exec('BEGIN'); try { fn(); db.exec('COMMIT'); } catch (e) { db.exec('ROLLBACK'); throw e; } }
  function environment(beforeBatch?: () => void): Env {
    const statement = (sql: string, args: unknown[] = []) => ({
      bind: (...params: unknown[]) => statement(sql, params),
      all: async () => ({ results: db.prepare(sql).all(...args as never[]), success: true }),
      first: async () => db.prepare(sql).get(...args as never[]) ?? null,
      run: async () => ({ success: true, meta: { changes: Number(db.prepare(sql).run(...args as never[]).changes) } }),
      // Like D1: a batch result carries meta.changes for writes and rows for reads.
      execute: () => /^\s*SELECT\b|\bRETURNING\b/i.test(sql)
        ? { results: db.prepare(sql).all(...args as never[]), success: true, meta: { changes: 0 } }
        : { results: [], success: true, meta: { changes: Number(db.prepare(sql).run(...args as never[]).changes) } },
    });
    return {
      DB: { prepare: (sql: string) => statement(sql), batch: async (stmts: Array<{ execute: () => unknown }>) => { let out: unknown[] = []; beforeBatch?.(); atomic(() => { out = stmts.map(s => s.execute()); }); return out; } },
      REALTIME: { idFromName: (name: string) => name, get: () => ({ fetch: async () => new Response('ok') }) },
      ATTACHMENTS: { head: async () => null, delete: async (keys: string | string[]) => { removed.push(...[keys].flat()); }, resumeMultipartUpload: () => ({ abort: async () => {} }) },
    } as unknown as Env;
  }
  const ctx = { waitUntil: (work: Promise<unknown>) => { pending.push(work); } };
  const as = (id: string, role: string, workspaceId = 'ws-a'): AuthCtx => ({ userId: `auth-${id === 'qa-lead' ? 'qa' : id === 'member-b' ? 'b' : id}`, email: `${id}@example.com`, member: { id, role, email: `${id}@example.com`, name: id, workspaceId } });
  const admin = as('admin', 'admin'), reporter = as('reporter', 'member'), qaLead = as('qa-lead', 'member'), other = as('other', 'member');
  const count = (table: string) => Number((db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n);
  async function report(by: AuthCtx = reporter, id = 'bug-1'): Promise<QaIssue> {
    return await executeQaAction(environment(), by, { action: 'create', id, commandId: `create-${id}`, input: { projectId: 'project-a', title: 'Login fails', actual: 'Broken', observedEnvironment: 'Stage' } }, ctx) as QaIssue;
  }
  async function triage(issue: QaIssue): Promise<QaIssue> {
    return await executeQaAction(environment(), admin, { action: 'command', id: issue.id, commandId: `triage-${issue.id}`, expectedVersion: issue.version,
      command: { type: 'triage', assigneeId: 'other', qaOwnerId: 'qa-lead', severity: 'medium', priority: 3, dueDate: null } }, ctx) as QaIssue;
  }
  const remove = (by: AuthCtx, issue: QaIssue, env = environment()) => executeQaAction(env, by, { action: 'delete', id: issue.id, expectedVersion: issue.version }, ctx);

  it('removes a bug with everything attached to it, records who did it and frees its storage', async () => {
    let issue = await report();
    issue = await executeQaAction(environment(), other, { action: 'comment', id: issue.id, commandId: 'comment-1', body: 'Same here' }, ctx) as QaIssue;
    issue = (await executeQaAction(environment(), admin, { action: 'get', id: 'bug-1' }, ctx) as { issue: QaIssue }).issue;
    db.exec(`INSERT INTO qa_upload_sessions(workspace_id,id,issue_id,actor_id,file_name,mime_type,expected_size,storage_key,state,created_at,expires_at)
        VALUES('ws-a','up-1','bug-1','reporter','a.png','image/png',2048,'qa/ws-a/bug-1/up-1','finalizing','now','later');
      INSERT INTO qa_attachments(workspace_id,id,issue_id,uploaded_by,file_name,mime_type,size,storage_key,created_at) VALUES('ws-a','up-1','bug-1','reporter','a.png','image/png',2048,'qa/ws-a/bug-1/up-1','now');
      INSERT INTO qa_slack_links(id,workspace_id,issue_id,team_id,channel_id,thread_ts,card_ts,created_at) VALUES('link-1','ws-a','bug-1','T1','C1','1.0','1.1','now');
      INSERT INTO notifications(workspace_id,id,recipient_id,sender_id,type,content,is_read,created_at) VALUES('ws-a','n-other','admin','reporter','qa_update','{"kind":"qa","issueId":"bug-2"}',0,'now');`);
    expect(count('notifications')).toBeGreaterThan(1);
    expect((db.prepare("SELECT storage_used_bytes AS n FROM workspaces WHERE id='ws-a'").get() as { n: number }).n).toBe(2048);

    await expect(remove(admin, issue)).resolves.toEqual({ id: 'bug-1', deleted: true });
    await Promise.all(pending);
    for (const table of ['qa_issues', 'qa_comments', 'qa_events', 'qa_attachments', 'qa_upload_sessions', 'qa_slack_links', 'qa_commands']) expect(count(table)).toBe(0);
    expect(db.prepare("SELECT id FROM notifications").all()).toEqual([{ id: 'n-other' }]);
    expect((db.prepare("SELECT storage_used_bytes AS n FROM workspaces WHERE id='ws-a'").get() as { n: number }).n).toBe(0);
    expect(db.prepare("SELECT user_id,action,target_type,task_id,task_key,detail FROM activity_logs WHERE action='delete_qa_issue'").get())
      .toEqual({ user_id: 'admin', action: 'delete_qa_issue', target_type: 'qa', task_id: 'bug-1', task_key: '#bug-1', detail: 'Login fails' });
    expect(removed).toEqual(['qa/ws-a/bug-1/up-1']);
  });

  it('lets the reporter delete only while the bug is new, and QA admins at any time', async () => {
    let issue = await report();
    await expect(remove(other, issue)).rejects.toMatchObject({ code: 'qa_forbidden' });
    issue = await triage(issue);
    await expect(remove(reporter, issue)).rejects.toMatchObject({ code: 'qa_forbidden' });
    expect(count('qa_issues')).toBe(1);
    await remove(qaLead, issue);
    expect(count('qa_issues')).toBe(0);

    const own = await report(reporter, 'bug-2');
    await remove(reporter, own);
    expect(count('qa_issues')).toBe(0);
  });

  it('deletes nothing when the bug changed meanwhile, the role was revoked or it belongs to another workspace', async () => {
    const issue = await report();
    await expect(remove(admin, { ...issue, version: issue.version + 1 })).rejects.toMatchObject({ code: 'qa_conflict' });
    // Re-triaged between the read and the transaction: every statement re-checks the version.
    const raced = environment(() => db.exec("UPDATE qa_issues SET version=version+1,data=json_set(data,'$.version',version+1) WHERE id='bug-1'"));
    await expect(remove(reporter, issue, raced)).rejects.toMatchObject({ code: 'qa_conflict' });
    expect(count('qa_issues')).toBe(1);
    expect(count('qa_events')).toBe(1);
    expect(count('activity_logs')).toBe(0);
    const fresh = (await executeQaAction(environment(), admin, { action: 'get', id: 'bug-1' }, ctx) as { issue: QaIssue }).issue;
    const demoted = environment(() => db.exec("UPDATE members SET is_qa_admin=0 WHERE id='qa-lead'"));
    await expect(remove(qaLead, fresh, demoted)).rejects.toMatchObject({ code: 'qa_conflict' });
    await expect(remove(as('member-b', 'admin', 'ws-b'), fresh)).rejects.toMatchObject({ code: 'qa_not_found' });
    expect(count('qa_issues')).toBe(1);
  });

  it('lets a member delete a task they created that nobody has picked up, and admins any task', async () => {
    db.exec(`INSERT INTO tasks(workspace_id,id,task_key,project_id,title,status_id,creator_id,started_at,completed_at) VALUES
      ('ws-a','fresh','A-1','project-a','Fresh','todo','reporter',NULL,NULL),
      ('ws-a','started','A-2','project-a','Started','doing','reporter','2026-10-01',NULL),
      ('ws-a','moved','A-3','project-a','Moved','done','reporter',NULL,NULL),
      ('ws-a','theirs','A-4','project-a','Theirs','todo','other',NULL,NULL),
      ('ws-a','clock','A-5','project-a','Timer ran','todo','reporter','2026-10-02',NULL)`);
    const del = (auth: AuthCtx, id: string) => runQuery(environment(), ctx, auth, { table: 'tasks', op: 'delete', filters: [{ col: 'id', op: 'eq', val: id }], cols: 'id' });
    for (const id of ['started', 'moved', 'theirs', 'clock']) {
      const result = await del(reporter, id);
      expect(result.error).toBeNull();
      expect(result.data).toEqual([]);
    }
    const ids = (result: Awaited<ReturnType<typeof del>>) => (result.data as Array<{ id: string }>).map(row => row.id);
    expect(ids(await del(reporter, 'fresh'))).toEqual(['fresh']);
    expect(ids(await del(admin, 'started'))).toEqual(['started']);
    expect(db.prepare('SELECT id FROM tasks ORDER BY id').all()).toEqual([{ id: 'clock' }, { id: 'moved' }, { id: 'theirs' }]);
    // A delete without a filter stays refused for everyone.
    expect((await runQuery(environment(), ctx, reporter, { table: 'tasks', op: 'delete' })).error).not.toBeNull();
  });
});
