import type { Env } from '../env';
import { QA_UPLOAD_CLEANUP_LIMIT, QA_UPLOAD_SETTLE_MS, QA_UPLOAD_TOMBSTONE_MS, runQaUploadCleanup,
  type QaCleanupUpload, type QaUploadCleanupRepository } from '../qaUploadCleanup';

type CleanupEnv = Pick<Env, 'DB' | 'ATTACHMENTS'>;
interface UploadRow { id: string; issue_id: string; storage_key: string; multipart_id: string | null; }
const stamp = () => new Date().toISOString();
const unreferenced = `NOT EXISTS(SELECT 1 FROM qa_attachments a WHERE a.workspace_id=qa_upload_sessions.workspace_id
  AND (a.id=qa_upload_sessions.id OR a.storage_key=qa_upload_sessions.storage_key))`;

export function qaUploadCleanupRepository(env: CleanupEnv, workspaceId: string): QaUploadCleanupRepository {
  const where = `workspace_id=? AND id=? AND cleanup_token=? AND cleanup_lease_until>?
    AND state IN ('aborting','aborted') AND ${unreferenced}`;
  const bound = (upload: QaCleanupUpload) => [workspaceId, upload.id, upload.token, stamp()];
  const valid = (upload: QaCleanupUpload) => upload.workspaceId === workspaceId &&
    [workspaceId, upload.issueId, upload.id].every(value => /^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/.test(value)) &&
    upload.storageKey === `qa/${workspaceId}/${upload.issueId}/${upload.id}`;
  return {
    async claim(limit) {
      const now = stamp(), expiredBefore = new Date(Date.now() - QA_UPLOAD_SETTLE_MS).toISOString();
      const retryBefore = new Date(Date.now() - 60 * 60 * 1000).toISOString();
      const rows = await env.DB.prepare(`SELECT id,issue_id,storage_key,multipart_id FROM qa_upload_sessions
        WHERE workspace_id=? AND state IN ('initializing','uploading','finalizing','aborting','aborted')
          AND expires_at<=? AND coalesce(cleanup_lease_until,'')<=?
          AND (cleanup_last_attempt_at IS NULL OR cleanup_last_attempt_at<=?) AND ${unreferenced}
        ORDER BY coalesce(cleanup_last_attempt_at,''),expires_at,id LIMIT ?`)
        .bind(workspaceId, expiredBefore, now, retryBefore, limit).all<UploadRow>();
      const uploads: QaCleanupUpload[] = [];
      for (const row of rows.results) {
        const token = crypto.randomUUID(), lease = new Date(Date.now() + QA_UPLOAD_SETTLE_MS).toISOString();
        const claimed = await env.DB.prepare(`UPDATE qa_upload_sessions SET
          state=CASE WHEN state='aborted' THEN 'aborted' ELSE 'aborting' END,
          cleanup_token=?,cleanup_lease_until=?,cleanup_last_attempt_at=?
          WHERE workspace_id=? AND id=? AND state IN ('initializing','uploading','finalizing','aborting','aborted')
            AND expires_at<=? AND coalesce(cleanup_lease_until,'')<=? AND ${unreferenced} RETURNING id`)
          .bind(token, lease, now, workspaceId, row.id, expiredBefore, now).first();
        if (claimed) uploads.push({ id: row.id, workspaceId, issueId: row.issue_id,
          storageKey: row.storage_key, multipartId: row.multipart_id, token });
      }
      return uploads;
    },
    async owns(upload) {
      return valid(upload) && !!await env.DB.prepare(`SELECT id FROM qa_upload_sessions WHERE ${where}`)
        .bind(...bound(upload)).first();
    },
    async referenced(upload) {
      return !!await env.DB.prepare('SELECT id FROM qa_attachments WHERE workspace_id=? AND (id=? OR storage_key=?) LIMIT 1')
        .bind(workspaceId, upload.id, upload.storageKey).first();
    },
    async abortMultipart(upload) {
      if (!upload.multipartId) return;
      try { await env.ATTACHMENTS.resumeMultipartUpload(upload.storageKey, upload.multipartId).abort(); }
      catch (error) {
        if (!/NoSuchUpload|does not exist|not found|already.*(?:abort|complet)/i.test(String(error))) throw error;
      }
    },
    async remove(upload) { await env.ATTACHMENTS.delete(upload.storageKey); },
    async finish(upload) {
      // Retain a fenced tombstone for a day and sweep it again. A slow, already
      // accepted object-store request cannot leave bytes behind after the first sweep.
      const settledBefore = new Date(Date.now() - QA_UPLOAD_TOMBSTONE_MS).toISOString();
      const retired = await env.DB.batch([
        env.DB.prepare(`DELETE FROM qa_upload_parts WHERE workspace_id=? AND upload_id=?
          AND EXISTS(SELECT 1 FROM qa_upload_sessions WHERE ${where} AND cleanup_completed_at<=?)`)
          .bind(workspaceId, upload.id, ...bound(upload), settledBefore),
        env.DB.prepare(`DELETE FROM qa_upload_sessions WHERE ${where} AND cleanup_completed_at<=? RETURNING id`)
          .bind(...bound(upload), settledBefore),
      ]);
      if (retired[1].results.length) return true;
      return !!await env.DB.prepare(`UPDATE qa_upload_sessions SET state='aborted',
        cleanup_completed_at=coalesce(cleanup_completed_at,?),cleanup_lease_until=NULL WHERE ${where} RETURNING id`)
        .bind(stamp(), ...bound(upload)).first();
    },
  };
}

export async function cleanupExpiredQaUploads(env: CleanupEnv, workspaceId: string, limit = QA_UPLOAD_CLEANUP_LIMIT) {
  return runQaUploadCleanup(qaUploadCleanupRepository(env, workspaceId), limit);
}

/** Follow the scheduled workspace inventory, then read each workspace's own reservations. */
export async function runScheduledQaUploadCleanup(env: CleanupEnv) {
  const cursor = await env.DB.prepare("SELECT cursor FROM qa_upload_maintenance_state WHERE id='workspace-scan'")
    .first<{ cursor: string }>();
  const workspaces = await env.DB.prepare(`SELECT id FROM (SELECT id FROM workspaces UNION SELECT 'default' AS id)
    WHERE id>? ORDER BY id LIMIT 25`).bind(cursor?.cursor ?? '').all<{ id: string }>();
  const summary = { workspaces: 0, claimed: 0, removed: 0, retained: 0, failed: 0 };
  let lastWorkspace = '';
  let remaining = QA_UPLOAD_CLEANUP_LIMIT;
  for (const workspace of workspaces.results) {
    if (remaining === 0) break;
    try {
      const result = await cleanupExpiredQaUploads(env, workspace.id, remaining);
      for (const key of ['claimed', 'removed', 'retained', 'failed'] as const) summary[key] += result[key];
      remaining -= result.claimed;
    } catch {
      summary.failed++;
      // A database failure can follow a partially committed claim batch. Spend
      // the unknown remainder conservatively and resume after this workspace.
      remaining = 0;
    }
    summary.workspaces++;
    lastWorkspace = workspace.id;
  }
  // Continue after the last workspace actually visited, including when an
  // earlier workspace consumes the tick's shared object-operation budget.
  const next = summary.workspaces < workspaces.results.length || workspaces.results.length === 25 ? lastWorkspace : '';
  await env.DB.prepare(`INSERT INTO qa_upload_maintenance_state(id,cursor) VALUES('workspace-scan',?)
    ON CONFLICT(id) DO UPDATE SET cursor=excluded.cursor`).bind(next).run();
  console.info('qa_upload_maintenance', JSON.stringify(summary));
  return summary;
}
