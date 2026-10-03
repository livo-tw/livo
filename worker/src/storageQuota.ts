import type { Env } from './env';
import { ensureKnowledgeImportUsageReconciled } from './knowledgeImportStorage';

export class StorageQuotaError extends Error {constructor(){super('storage_quota_exceeded');}}
/** Used bytes includes import reservations; QA's in-flight reservations stay separate. */
export async function reserveStorageBytes(env:Pick<Env,'DB'|'ATTACHMENTS'>,workspace:string,bytes:number):Promise<void>{
  if(workspace==='default'){
    if(bytes>0)await env.DB.prepare('UPDATE workspaces SET storage_used_bytes=storage_used_bytes+? WHERE id=?').bind(bytes,workspace).run();
    return;
  }
  await ensureKnowledgeImportUsageReconciled(env,workspace);
  if(bytes<=0)return;
  const row=await env.DB.prepare("UPDATE workspaces SET storage_used_bytes=storage_used_bytes+? WHERE id=? AND storage_used_bytes+?+COALESCE((SELECT SUM(expected_size) FROM qa_upload_sessions WHERE workspace_id=? AND state IN ('initializing','uploading','finalizing','aborting')),0)<=storage_limit_mb*1048576 RETURNING id")
    .bind(bytes,workspace,bytes,workspace).first();
  if(!row&&await env.DB.prepare('SELECT id FROM workspaces WHERE id=?').bind(workspace).first())throw new StorageQuotaError();
}
export async function releaseStorageBytes(env:Pick<Env,'DB'>,workspace:string,bytes:number):Promise<void>{
  if(bytes>0)await env.DB.prepare('UPDATE workspaces SET storage_used_bytes=MAX(0,storage_used_bytes-?) WHERE id=?').bind(bytes,workspace).run();
}
