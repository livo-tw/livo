import type { Env } from '../env';
import { importJobPrefix, IMPORT_CLEANUP_FILE_LIMIT, runImportCleanup, type ImportCleanupClaim, type ImportCleanupRepository } from '../knowledgeImportCleanup';
import { deleteKnowledgeImportObject, reconcileKnowledgeImportUsage } from '../knowledgeImportStorage';

type JobRow = { id: string; workspace_id: string; actor_id: string };

export function createImportCleanupRepository(env: Pick<Env, 'DB' | 'ATTACHMENTS'>): ImportCleanupRepository {
  const objectPrefix = (job: ImportCleanupClaim) => `kb-imports/${job.workspace_id}/${importJobPrefix(job)}`;
  const claimWhere = `workspace_id=? AND id=? AND expires_at<=? AND json_extract(data,'$.cleanup_token')=? AND json_extract(data,'$.cleanup_lease_until')>?`;
  return {
    async claim(now, leaseUntil, token, limit) {
      // This scheduled-only enumeration intentionally discovers every tenant's overdue
      // work, including disabled/deleted actors. It returns identifiers, never content.
      // Every claim, source lookup, delete and quota mutation below is workspace scoped.
      const candidates = await env.DB.prepare(`SELECT id,workspace_id,actor_id FROM knowledge_import_jobs
        WHERE workspace_id IS NOT NULL AND expires_at<=?
          AND coalesce(json_extract(data,'$.cleanup_lease_until'),'')<=?
          AND coalesce(json_extract(data,'$.cleanup_after'),'')<=?
        ORDER BY coalesce(json_extract(data,'$.cleanup_last_attempt'),''),expires_at,workspace_id,id LIMIT ?`).bind(now, now, now, limit).all<JobRow>();
      const claims: ImportCleanupClaim[] = [];
      for (const job of candidates.results) {
        const row = await env.DB.prepare(`UPDATE knowledge_import_jobs SET version=version+1,
          data=json_set(data,'$.version',version+1,'$.cleanup_token',?,'$.cleanup_lease_until',?,'$.cleanup_last_attempt',?)
          WHERE workspace_id=? AND id=? AND expires_at<=?
            AND coalesce(json_extract(data,'$.cleanup_lease_until'),'')<=?
            AND coalesce(json_extract(data,'$.cleanup_after'),'')<=? RETURNING id,workspace_id,actor_id`)
          .bind(token, leaseUntil, now, job.workspace_id, job.id, now, now, now).first<JobRow>();
        if (row) claims.push({ ...row, lease_token: token });
      }
      return claims;
    },
    async files(job) {
      const prefix = objectPrefix(job), keys = new Set<string>();
      let cursor: string | undefined;
      do {
        const result = await env.ATTACHMENTS.list({ prefix, limit: IMPORT_CLEANUP_FILE_LIMIT, ...(cursor ? { cursor } : {}) });
        for (const object of result.objects) keys.add(object.key);
        if (keys.size > IMPORT_CLEANUP_FILE_LIMIT) throw new Error('cleanup_object_limit');
        cursor = result.truncated ? result.cursor : undefined;
      } while (cursor);
      // Failed/interrupted uploads can reserve quota before R2 has an object.
      const ledger = await env.DB.prepare(`SELECT file_key FROM knowledge_import_files
        WHERE workspace_id=? AND job_id=? LIMIT ?`).bind(job.workspace_id, job.id, IMPORT_CLEANUP_FILE_LIMIT + 1).all<{ file_key: string }>();
      for (const row of ledger.results) keys.add(row.file_key);
      if (keys.size > IMPORT_CLEANUP_FILE_LIMIT || [...keys].some(key => !key.startsWith(prefix))) throw new Error('cleanup_object_limit');
      return [...keys].map(key => key.slice(`kb-imports/${job.workspace_id}/`.length));
    },
    async retained(job, keys) {
      if (!keys.length) return [];
      const references = await env.DB.prepare(`SELECT original,assets FROM knowledge_import_sources
        WHERE workspace_id=? AND (
          json_extract(original,'$.key') IN (SELECT value FROM json_each(?)) OR
          EXISTS(SELECT 1 FROM json_each(assets) a WHERE json_extract(a.value,'$.key') IN (SELECT value FROM json_each(?))))`)
        .bind(job.workspace_id, JSON.stringify(keys), JSON.stringify(keys)).all<{ original: string; assets: string }>();
      return references.results.flatMap(row => [JSON.parse(row.original).key, ...JSON.parse(row.assets).map((asset: { key: string }) => asset.key)]);
    },
    async owns(job, now) {
      return !!await env.DB.prepare(`SELECT id FROM knowledge_import_jobs WHERE ${claimWhere}`)
        .bind(job.workspace_id, job.id, now, job.lease_token, now).first();
    },
    async remove(job, keys) {
      let removed = 0;
      for (const key of keys) if (await deleteKnowledgeImportObject(env, job.workspace_id, `kb-imports/${job.workspace_id}/${key}`)) removed++;
      return removed;
    },
    async finish(job, now, settledBefore, nextSweep) {
      const removed = await env.DB.prepare(`DELETE FROM knowledge_import_jobs WHERE ${claimWhere}
        AND json_extract(data,'$.cleanup_completed_at') IS NOT NULL
        AND json_extract(data,'$.cleanup_completed_at')<=? RETURNING id`)
        .bind(job.workspace_id, job.id, now, job.lease_token, now, settledBefore).first();
      if (removed) return true;
      const compacted = await env.DB.prepare(`UPDATE knowledge_import_jobs SET version=version+1,
        data=json_object('id',id,'actor_id',actor_id,'source',json_extract(data,'$.source'),
          'status','cancelled','version',version+1,'policy_version',0,'created_at',created_at,
          'expires_at',expires_at,'initial_parent',NULL,'items',json('[]'),'staged_keys',json('[]'),
          'cleanup_completed_at',?,'cleanup_after',?,'cleanup_last_attempt',?) WHERE ${claimWhere} RETURNING id`)
        .bind(now, nextSweep, now, job.workspace_id, job.id, now, job.lease_token, now).first();
      return !!compacted;
    },
  };
}

/** Hourly Worker cron entry point. No member JWT, license or workspace feature gate. */
export async function runKnowledgeImportCleanup(env: Env) {
  let reconciliationFailed = false;
  let reconciliation: { visited: number; adopted: number; done: boolean } | undefined;
  try {
    const state = await env.DB.prepare("SELECT version,data FROM knowledge_import_maintenance_state WHERE id='usage-reconciliation'").first<{ version: number; data: string }>();
    const cursor = state ? JSON.parse(state.data).cursor : undefined;
    const result = await reconcileKnowledgeImportUsage(env, { ...(cursor ? { cursor } : {}), limit: 100, orphanCleanup: true });
    reconciliation = { visited: result.visited, adopted: result.adopted, done: result.done };
    await env.DB.prepare(`INSERT INTO knowledge_import_maintenance_state(id,version,data)
      VALUES('usage-reconciliation',?,?) ON CONFLICT(id) DO UPDATE SET version=excluded.version,data=excluded.data
      WHERE knowledge_import_maintenance_state.version=?`)
      .bind((state?.version ?? 0) + 1, JSON.stringify({ cursor: result.cursor || null }), state?.version ?? 0).run();
  } catch { reconciliationFailed = true; }
  const summary = await runImportCleanup(createImportCleanupRepository(env));
  // Counts only: no actors, titles, tokens, storage paths or document content.
  console.info('knowledge_import_maintenance', JSON.stringify({ ...summary, reconciliation_failed: reconciliationFailed }));
  return { ...summary, reconciliation_failed: reconciliationFailed, reconciliation };
}
