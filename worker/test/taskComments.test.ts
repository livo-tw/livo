// @vitest-environment node
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanupTaskCommentUploads, cleanupLateTaskCommentObject, taskAttachmentSummary, handleTaskComments } from '../src/taskComments';
describe('task comment production SQLite transaction triggers',()=>{
  let db:DatabaseSync;
  beforeEach(()=>{
    db=new DatabaseSync(':memory:');
    db.exec(`PRAGMA foreign_keys=ON;
      CREATE TABLE workspaces(id TEXT PRIMARY KEY,storage_used_bytes INTEGER NOT NULL DEFAULT 0,storage_limit_mb INTEGER NOT NULL);
      CREATE TABLE members(workspace_id TEXT,id TEXT PRIMARY KEY,is_active INTEGER);
      CREATE TABLE tasks(workspace_id TEXT,id TEXT PRIMARY KEY,comment_count INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE comments(workspace_id TEXT,id TEXT PRIMARY KEY,task_id TEXT REFERENCES tasks(id) ON DELETE CASCADE,user_id TEXT,content TEXT,created_at TEXT,attachment_url TEXT,attachment_size INTEGER DEFAULT 0);
      CREATE TABLE task_attachments(workspace_id TEXT,id TEXT PRIMARY KEY,task_id TEXT,file_size INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE notifications(workspace_id TEXT,id TEXT PRIMARY KEY,recipient_id TEXT,sender_id TEXT,type TEXT,task_id TEXT,content TEXT,created_at TEXT);
      CREATE TABLE qa_upload_sessions(workspace_id TEXT,expected_size INTEGER,state TEXT);
      CREATE TABLE task_planning_import_guard(workspace_id TEXT PRIMARY KEY);
      INSERT INTO workspaces VALUES('ws-a',0,1),('ws-b',0,1);
      INSERT INTO members VALUES('ws-a','actor-a',1),('ws-a','other-a',1),('ws-b','actor-b',1);
      INSERT INTO tasks VALUES('ws-a','task-a',0),('ws-a','task-other',0),('ws-b','task-b',0);`);
    const schema=readFileSync(new URL('../schema.sql',import.meta.url),'utf8'),start=schema.indexOf('CREATE TABLE IF NOT EXISTS task_comment_uploads');
    expect(start).toBeGreaterThan(-1);db.exec(schema.slice(start));
  });
  afterEach(()=>db.close());
  const stamp='2026-01-01T00:00:00Z';
  const reserve=(id:string,size=8,actor='actor-a',task='task-a',ws='ws-a')=>db.prepare('INSERT INTO task_comment_uploads(workspace_id,id,task_id,actor_id,file_name,mime_type,expected_size,storage_key,state,created_at,expires_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(ws,id,task,actor,'example.png','image/png',size,`task-comment/${ws}/${task}/${id}`,'complete',stamp,'2099-01-01T00:00:00Z');
  const publish=(id:string,uploads:string[],actor='actor-a',task='task-a',ws='ws-a')=>db.prepare('INSERT INTO task_comment_commands(workspace_id,id,task_id,actor_id,payload_hash,body,upload_ids,notifications,created_at) VALUES(?,?,?,?,?,?,?,?,?)').run(ws,id,task,actor,'hash','',JSON.stringify(uploads),JSON.stringify([{id:'other-a',type:'comment',content:''}]),stamp);
  const value=(sql:string)=>Object.values(db.prepare(sql).get()!)[0];
  const context=(storage:unknown)=>{
    const statement=(sql:string,args:unknown[]=[])=>({
      bind:(...values:unknown[])=>statement(sql,values),
      first:async()=>db.prepare(sql).get(...args as any[])||null,
      all:async()=>({results:db.prepare(sql).all(...args as any[])}),
      run:async()=>({meta:db.prepare(sql).run(...args as any[])}),
    });
    return {get:()=>({member:{workspaceId:'ws-a',id:'actor-a'}}),env:{ATTACHMENTS:storage,DB:{prepare:statement,batch:async(statements:any[])=>{db.exec('BEGIN');try{const results=[];for(const row of statements)results.push(await row.run());db.exec('COMMIT');return results;}catch(error){db.exec('ROLLBACK');throw error;}}}}} as any;
  };
  it('publishes pure attachment comments, binds files and increments the counter in one transaction',()=>{
    reserve('upload-a');publish('command-a',['upload-a']);
    expect(value('SELECT count(*) FROM comments')).toBe(1);expect(value("SELECT comment_id FROM task_comment_uploads WHERE id='upload-a'")).toBe('command-a');
    expect(value("SELECT comment_count FROM tasks WHERE id='task-a'")).toBe(1);expect(value('SELECT count(*) FROM notifications')).toBe(1);
    expect(()=>publish('command-a',['upload-a'])).toThrow();expect(value('SELECT count(*) FROM comments')).toBe(1);expect(value('SELECT count(*) FROM notifications')).toBe(1);
  });
  it('rejects another owner, task and workspace without partially creating a comment',()=>{
    reserve('upload-a');
    expect(()=>publish('other-owner',['upload-a'],'other-a')).toThrow();
    expect(()=>publish('other-task',['upload-a'],'actor-a','task-other')).toThrow();
    expect(()=>publish('other-ws',['upload-a'],'actor-b','task-b','ws-b')).toThrow();
    expect(value('SELECT count(*) FROM comments')).toBe(0);expect(value('SELECT count(*) FROM notifications')).toBe(0);
    expect(value("SELECT comment_id FROM task_comment_uploads WHERE id='upload-a'")).toBeNull();
  });
  it('accounts for pending QA and existing storage using the same workspace aggregate',()=>{
    db.exec("UPDATE workspaces SET storage_used_bytes=500000 WHERE id='ws-a';INSERT INTO qa_upload_sessions VALUES('ws-a',400000,'uploading');");
    expect(()=>reserve('too-large',200000)).toThrow('storage_quota_exceeded');expect(value("SELECT storage_used_bytes FROM workspaces WHERE id='ws-a'")).toBe(500000);
    reserve('fits',100000);expect(value("SELECT storage_used_bytes FROM workspaces WHERE id='ws-a'")).toBe(600000);
    expect(()=>reserve('fits',100000)).toThrow();expect(value("SELECT storage_used_bytes FROM workspaces WHERE id='ws-a'")).toBe(600000);
  });
  it('keeps the only storage cleanup handle after comment and task deletion',()=>{
    reserve('upload-a');publish('command-a',['upload-a']);db.exec("DELETE FROM tasks WHERE id='task-a';");
    expect(value('SELECT count(*) FROM comments')).toBe(0);expect(value('SELECT count(*) FROM task_comment_uploads')).toBe(1);
    expect(value("SELECT comment_id FROM task_comment_uploads WHERE id='upload-a'")).toBeNull();expect(value("SELECT storage_key FROM task_comment_uploads WHERE id='upload-a'")).toBe('task-comment/ws-a/task-a/upload-a');
  });
  it('rejects expired and cleanup-owned files and preserves draft bytes for reconciliation',()=>{
    reserve('expired');reserve('cleaning');db.exec("UPDATE task_comment_uploads SET expires_at='2000-01-01' WHERE id='expired';UPDATE task_comment_uploads SET state='cleaning' WHERE id='cleaning';");
    expect(()=>publish('expired-command',['expired'])).toThrow();expect(()=>publish('cleaning-command',['cleaning'])).toThrow();
    expect(value('SELECT count(*) FROM task_comment_uploads')).toBe(2);expect(value('SELECT count(*) FROM comments')).toBe(0);
  });
  it('retries multipart abort after an initial failure and credits only after the storage acknowledgement',async()=>{
    reserve('10000000-0000-4000-8000-000000000011');db.exec("UPDATE task_comment_uploads SET state='uploading',multipart_id='synthetic-multipart',expires_at='2000-01-01' WHERE id='10000000-0000-4000-8000-000000000011';");
    const abort=vi.fn().mockRejectedValueOnce(new Error('temporarily unavailable')).mockResolvedValue(undefined),remove=vi.fn().mockResolvedValue(undefined);
    const ctx=context({resumeMultipartUpload:()=>({abort}),delete:remove});
    await cleanupTaskCommentUploads(ctx);expect(value("SELECT storage_used_bytes FROM workspaces WHERE id='ws-a'")).toBe(8);expect(remove).not.toHaveBeenCalled();
    expect(value("SELECT state FROM task_comment_uploads WHERE id='10000000-0000-4000-8000-000000000011'")).toBe('cleaning');
    await cleanupTaskCommentUploads(ctx);expect(abort).toHaveBeenCalledTimes(2);expect(remove).toHaveBeenCalledTimes(1);expect(value("SELECT storage_used_bytes FROM workspaces WHERE id='ws-a'")).toBe(0);
    expect(value("SELECT quota_released FROM task_comment_uploads WHERE id='10000000-0000-4000-8000-000000000011'")).toBe(1);
    await cleanupTaskCommentUploads(ctx);expect(value("SELECT storage_used_bytes FROM workspaces WHERE id='ws-a'")).toBe(0);expect(remove).toHaveBeenCalledTimes(1);
  });
  it('retains and re-accounts a late completion when its deletion fails after an earlier cleanup ACK',async()=>{
    reserve('10000000-0000-4000-8000-000000000012');db.exec("UPDATE task_comment_uploads SET state='finalizing',multipart_id='synthetic-multipart',expires_at='2000-01-01' WHERE id='10000000-0000-4000-8000-000000000012';");
    const remove=vi.fn().mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('delete unavailable')).mockResolvedValue(undefined);
    const ctx=context({resumeMultipartUpload:()=>({abort:vi.fn().mockResolvedValue(undefined)}),delete:remove});
    await cleanupTaskCommentUploads(ctx);expect(value("SELECT storage_used_bytes FROM workspaces WHERE id='ws-a'")).toBe(0);
    const old={id:'10000000-0000-4000-8000-000000000012',storage_key:'task-comment/ws-a/task-a/10000000-0000-4000-8000-000000000012'};
    await expect(cleanupLateTaskCommentObject(ctx,old)).rejects.toThrow('delete unavailable');
    expect(value("SELECT state FROM task_comment_uploads WHERE id='10000000-0000-4000-8000-000000000012'")).toBe('cleaning');expect(value("SELECT storage_used_bytes FROM workspaces WHERE id='ws-a'")).toBe(8);
    await cleanupTaskCommentUploads(ctx);expect(value("SELECT state FROM task_comment_uploads WHERE id='10000000-0000-4000-8000-000000000012'")).toBe('aborted');expect(value("SELECT storage_used_bytes FROM workspaces WHERE id='ws-a'")).toBe(0);
    expect(remove).toHaveBeenCalledTimes(3);
  });
  it('blocks the real clear/import guard before deleting private comment records, while zero coverage keeps the old flow',()=>{
    db.exec("INSERT INTO task_planning_import_guard VALUES('ws-a');DELETE FROM task_planning_import_guard WHERE workspace_id='ws-a';");
    reserve('private-import');publish('private-comment',['private-import']);
    expect(()=>db.exec("BEGIN;INSERT INTO task_planning_import_guard VALUES('ws-a');DELETE FROM comments WHERE workspace_id='ws-a';DELETE FROM tasks WHERE workspace_id='ws-a';COMMIT;")).toThrow('task_comment_private_media_requires_full_restore');
    db.exec('ROLLBACK');expect(value('SELECT count(*) FROM comments')).toBe(1);expect(value("SELECT comment_count FROM tasks WHERE id='task-a'")).toBe(1);
    db.exec("INSERT INTO task_planning_import_guard VALUES('ws-b');");expect(value("SELECT count(*) FROM task_planning_import_guard WHERE workspace_id='ws-b'")).toBe(1);
  });
  const coverage=async(role:string,workspace='ws-a',database?:unknown)=>{
    const ctx=context({});ctx.get=()=>({member:{workspaceId:workspace,id:'actor-a',role}});
    if(database)ctx.env.DB=database;
    ctx.req={query:()=>undefined,raw:new Request('https://example.com/api/functions/task-comments',{method:'POST',body:JSON.stringify({action:'coverage',workspaceId:'ws-b'})})};
    ctx.header=()=>{};
    ctx.json=(body:unknown,status=200)=>new Response(JSON.stringify(body),{status});
    return handleTaskComments(ctx);
  };
  it('limits backup coverage to super admins and the current authenticated workspace',async()=>{
    reserve('private-a');reserve('private-b',8,'actor-b','task-b','ws-b');
    expect((await coverage('member')).status).toBe(403);expect((await coverage('admin')).status).toBe(403);
    const response=await coverage('super_admin');expect(response.status).toBe(200);expect(await response.json()).toMatchObject({retainedMetadata:1,coveredByJsonBackup:false,commandReceiptsExcluded:true});
  });
  it('fails backup coverage closed when the database count is unknown',async()=>{
    const missing={prepare:()=>({bind:()=>({first:async()=>null})})};expect((await coverage('super_admin','ws-a',missing)).status).toBe(503);
  });
  it('counts ordinary, historical and bound private files without exposing pending files or another workspace',async()=>{
    reserve('bound-file');publish('bound-comment',['bound-file']);reserve('pending-file',20);
    db.exec("INSERT INTO task_attachments VALUES('ws-a','ordinary','task-a',7),('ws-b','foreign','task-b',9);INSERT INTO comments(workspace_id,id,task_id,user_id,content,attachment_url,attachment_size)VALUES('ws-a','legacy','task-a','actor-a','','https://example.com/image.png',5);");
    const result=await taskAttachmentSummary(context({}),['task-a','task-b','not-found']);
    expect(result.counts).toEqual({'task-a':3});expect(result.commentCounts).toEqual({'task-a':2});
    expect(Object.keys(result)).not.toContain('attachments');expect(result.storageUsedBytes).toBe(28);
  });
  it('uses the quota counter once and adds only QA inflight reservations',async()=>{
    reserve('pending-file',20);db.exec("INSERT INTO qa_upload_sessions VALUES('ws-a',11,'uploading'),('ws-a',100,'bound'),('ws-b',500,'uploading');");
    expect((await taskAttachmentSummary(context({}),[])).storageUsedBytes).toBe(31);
  });
  it('uses a single JSON bind for more than the D1 parameter limit of task IDs',async()=>{
    const result=await taskAttachmentSummary(context({}),Array.from({length:1000},(_,n)=>n===0?'task-a':'task-'+n));
    expect(result.counts).toEqual({'task-a':0});
  });

  it('readback returns current complete attachment and comment counts after a lost publish response',async()=>{
    const command='20000000-0000-4000-8000-000000000001';reserve('receipt-file');publish(command,['receipt-file']);db.exec("UPDATE tasks SET comment_count=999 WHERE id='task-a';");
    const ctx=context({});ctx.req={query:()=>undefined,raw:new Request('https://example.com/api/functions/task-comments',{method:'POST',body:JSON.stringify({action:'readback',commandId:command})})};ctx.header=()=>{};ctx.json=(body:unknown,status=200)=>new Response(JSON.stringify(body),{status});
    const result=await handleTaskComments(ctx);expect(result.status).toBe(200);expect(await result.json()).toMatchObject({comment:{id:command},commentCount:1,attachmentCount:1});
  });

  it('refuses an absent tenant quota row rather than substituting an incomplete usage total',async()=>{
    db.exec("DELETE FROM workspaces WHERE id='ws-a';");
    await expect(taskAttachmentSummary(context({}),[])).rejects.toThrow('summary_unavailable');
  });

});
