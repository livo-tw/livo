// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import type { Env } from '../src/env';
import { cleanupExpiredQaUploads, qaUploadCleanupRepository, runScheduledQaUploadCleanup } from '../src/functions/qaUploadCleanup';
import { runQaUploadCleanup } from '../src/qaUploadCleanup';

describe('QA expired-upload retention with real SQLite fences', () => {
  let db: DatabaseSync;
  const deleteObject = vi.fn(), abortMultipart = vi.fn();
  const clock = new Date('2026-11-05T04:00:00.000Z');
  beforeEach(() => {
    vi.useFakeTimers(); vi.setSystemTime(clock);
    deleteObject.mockReset().mockResolvedValue(undefined);
    abortMultipart.mockReset().mockResolvedValue(undefined);
    db = new DatabaseSync(':memory:');
    db.exec(readFileSync(new URL('../schema.sql', import.meta.url), 'utf8'));
    db.exec(`INSERT INTO product_lines(workspace_id,id,name) VALUES('ws-a','line-a','A'),('ws-b','line-b','B');
      INSERT INTO projects(workspace_id,id,line_id,name,key) VALUES('ws-a','project-a','line-a','A','A'),('ws-b','project-b','line-b','B','B');
      INSERT INTO members(workspace_id,id,name,avatar,role,email) VALUES('ws-a','member-a','A','','super_admin','a@example.com'),('ws-b','member-b','B','','super_admin','b@example.com');
      INSERT INTO system_settings(workspace_id,key,value) VALUES('ws-a','feature_toggles','{"qa":true}'),('ws-b','feature_toggles','{"qa":true}');
      INSERT INTO qa_issues(workspace_id,id,project_id,state,reporter_id,title,version,updated_at,data)
        VALUES('ws-a','issue-a','project-a','new','member-a','A',1,'now','{}'),('ws-b','issue-b','project-b','new','member-b','B',1,'now','{}');
      INSERT INTO workspaces(id,name,storage_limit_mb) VALUES('ws-a','A',100),('ws-b','B',100);`);
  });
  afterEach(() => { db.close(); vi.useRealTimers(); });
  function environment(): Env {
    const statement = (sql: string, values: unknown[] = []) => ({
      bind: (...args: unknown[]) => statement(sql, args),
      first: async () => db.prepare(sql).get(...values as never[]) ?? null,
      all: async () => ({ results: db.prepare(sql).all(...values as never[]), success: true }),
      run: async () => ({ success: true, meta: { changes: Number(db.prepare(sql).run(...values as never[]).changes) } }),
      execute: () => ({ results: db.prepare(sql).all(...values as never[]), success: true }),
    });
    return { DB: {
      prepare: (sql: string) => statement(sql),
      batch: async (statements: Array<{ execute: () => unknown }>) => {
        db.exec('BEGIN');
        try { const result = statements.map(item => item.execute()); db.exec('COMMIT'); return result; }
        catch (error) { db.exec('ROLLBACK'); throw error; }
      },
    }, ATTACHMENTS: { delete: deleteObject, resumeMultipartUpload: () => ({ abort: abortMultipart }) } } as unknown as Env;
  }
  function reserve(id: string, options: { workspace?: string; expires?: string; state?: string } = {}) {
    const ws = options.workspace ?? 'ws-a', issue = ws === 'ws-a' ? 'issue-a' : 'issue-b', member = ws === 'ws-a' ? 'member-a' : 'member-b';
    db.prepare(`INSERT INTO qa_upload_sessions(workspace_id,id,issue_id,actor_id,file_name,mime_type,expected_size,storage_key,
      multipart_id,state,created_at,expires_at) VALUES(?,?,?,?,?,'text/plain',7,?,'multipart',?,'2026-11-03T00:00:00Z',?)`)
      .run(ws, id, issue, member, 'example.txt', `qa/${ws}/${issue}/${id}`, options.state ?? 'uploading', options.expires ?? '2026-11-04T00:00:00Z');
  }
  function attach(id: string, restored = false) {
    db.prepare(`INSERT INTO qa_attachments(workspace_id,id,issue_id,uploaded_by,file_name,mime_type,size,storage_key,created_at,restored_by)
      VALUES('ws-a',?,'issue-a','member-a','example.txt','text/plain',7,?,'now',?)`)
      .run(id, `qa/ws-a/issue-a/${id}`, restored ? 'member-a' : null);
  }
  it('cleans only expired unreferenced reservations in the requested workspace, with feature disabled', async () => {
    reserve('expired'); reserve('other', { workspace: 'ws-b' });
    reserve('active', { expires: '2026-11-06T00:00:00Z' });
    reserve('settling', { expires: '2026-11-05T03:58:00Z' });
    reserve('committed', { state: 'finalizing' }); attach('committed');
    db.exec("UPDATE system_settings SET value='{}' WHERE workspace_id='ws-a'");
    expect(await cleanupExpiredQaUploads(environment(), 'ws-a')).toEqual({ claimed: 1, removed: 1, retained: 0, failed: 0 });
    expect(deleteObject).toHaveBeenCalledExactlyOnceWith('qa/ws-a/issue-a/expired');
    expect(db.prepare("SELECT state FROM qa_upload_sessions WHERE id='expired'").get()?.state).toBe('aborted');
    expect(db.prepare("SELECT state FROM qa_upload_sessions WHERE id='other'").get()?.state).toBe('uploading');
    expect(db.prepare("SELECT storage_used_bytes FROM workspaces WHERE id='ws-a'").get()?.storage_used_bytes).toBe(7);
  });
  it('keeps the reservation charged on delete failure and retries after the lease', async () => {
    reserve('retry'); deleteObject.mockRejectedValueOnce(new Error('storage unavailable'));
    expect((await cleanupExpiredQaUploads(environment(), 'ws-a')).failed).toBe(1);
    expect(db.prepare("SELECT state FROM qa_upload_sessions WHERE id='retry'").get()?.state).toBe('aborting');
    expect((await cleanupExpiredQaUploads(environment(), 'ws-a')).claimed).toBe(0);
    vi.setSystemTime(new Date(clock.getTime() + 61 * 60 * 1000));
    expect((await cleanupExpiredQaUploads(environment(), 'ws-a')).removed).toBe(1);
  });
  it('blocks a concurrent finalization and restore after claim, then sweeps a late object before retiring the tombstone', async () => {
    reserve('fenced', { state: 'finalizing' });
    const env = environment(), repository = qaUploadCleanupRepository(env, 'ws-a');
    const [claim] = await repository.claim(25);
    expect(() => attach('fenced')).toThrow(/qa_upload_(conflict|cleanup_in_progress)/);
    expect(() => attach('fenced', true)).toThrow('qa_upload_cleanup_in_progress');
    // The second worker cannot steal the active claim.
    expect(await qaUploadCleanupRepository(env, 'ws-a').claim(25)).toEqual([]);
    await repository.remove(claim); expect(await repository.finish(claim)).toBe(true);
    vi.setSystemTime(new Date(clock.getTime() + 25 * 60 * 60 * 1000));
    expect((await cleanupExpiredQaUploads(env, 'ws-a')).removed).toBe(1);
    expect(deleteObject).toHaveBeenCalledTimes(2);
    expect(db.prepare("SELECT id FROM qa_upload_sessions WHERE id='fenced'").get()).toBeUndefined();
  });
  it('retains references and stale owners without deleting storage', async () => {
    reserve('referenced', { state: 'finalizing' });
    const repository = qaUploadCleanupRepository(environment(), 'ws-a'), [claim] = await repository.claim(25);
    // A stale worker loses its CAS token before any object-store operation.
    db.exec("UPDATE qa_upload_sessions SET cleanup_token='new-owner' WHERE id='referenced'");
    expect((await runQaUploadCleanup({ ...repository, claim: async () => [claim] })).retained).toBe(1);
    expect(deleteObject).not.toHaveBeenCalled();
  });
  it('shares one batch budget across workspaces and continues the next workspace on the following tick', async () => {
    for (let index = 0; index < 28; index++) reserve(`upload-${index}`);
    reserve('tenant-b', { workspace: 'ws-b' });
    const summary = await runScheduledQaUploadCleanup(environment());
    expect(summary.workspaces).toBe(2); expect(summary.claimed).toBe(25);
    expect(db.prepare("SELECT count(*) AS n FROM qa_upload_sessions WHERE workspace_id='ws-a' AND state='uploading'").get()?.n).toBe(3);
    expect(db.prepare("SELECT state FROM qa_upload_sessions WHERE workspace_id='ws-b' AND id='tenant-b'").get()?.state).toBe('uploading');
    expect(db.prepare("SELECT cursor FROM qa_upload_maintenance_state WHERE id='workspace-scan'").get()?.cursor).toBe('ws-a');
    const following = await runScheduledQaUploadCleanup(environment());
    expect(following.claimed).toBe(1); expect(following.workspaces).toBe(1);
    expect(db.prepare("SELECT state FROM qa_upload_sessions WHERE workspace_id='ws-b' AND id='tenant-b'").get()?.state).toBe('aborted');
  });
});
