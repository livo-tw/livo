import type { Env } from './env';
import { ImportError, sha256 } from './knowledgeImport';

type StorageEnv = Pick<Env,'DB'|'ATTACHMENTS'>;
type FileRow = { bytes:number; content_hash:string; state:string; operation_id:string };
const now = () => new Date().toISOString();
function relativeKey(workspace:string,key:string):string {
  const prefix=`kb-imports/${workspace}/`;
  if(!key.startsWith(prefix)||key.slice(prefix.length).split('/').some(part=>!part||part==='.'||part==='..'))throw new ImportError('invalid_storage_key');
  return key.slice(prefix.length);
}
async function liveJob(env:StorageEnv,workspace:string,relative:string):Promise<boolean>{
  const [actor,job]=relative.split('/');
  return !!await env.DB.prepare("SELECT id FROM knowledge_import_jobs WHERE workspace_id=? AND id=? AND actor_id=? AND expires_at>? AND json_extract(data,'$.status') NOT IN ('cancelled','succeeded') AND json_extract(data,'$.cleanup_started') IS NULL")
    .bind(workspace,job,actor,now()).first();
}
/** Stored sources survive job expiry; a live preview also owns its parsed payload. */
async function referenced(env:StorageEnv,workspace:string,relative:string):Promise<boolean>{
  if(await env.DB.prepare("SELECT id FROM knowledge_import_sources WHERE workspace_id=? AND (json_extract(original,'$.key')=? OR EXISTS(SELECT 1 FROM json_each(assets) WHERE json_extract(value,'$.key')=?)) LIMIT 1").bind(workspace,relative,relative).first())return true;
  return !!await env.DB.prepare("SELECT id FROM knowledge_import_jobs WHERE workspace_id=? AND expires_at>? AND json_extract(data,'$.status')!='cancelled' AND EXISTS(SELECT 1 FROM json_each(data,'$.items') WHERE json_extract(value,'$._parsed_key')=?) LIMIT 1").bind(workspace,now(),relative).first();
}

/** Idempotent service cleanup. Never decrement usage before the R2 delete succeeds. */
export async function deleteKnowledgeImportObject(env:StorageEnv,workspace:string,key:string):Promise<boolean>{
  const relative=relativeKey(workspace,key);
  if(await referenced(env,workspace,relative))return false;
  const operation=crypto.randomUUID();
  const row=await env.DB.prepare("UPDATE knowledge_import_files SET state='deleting',operation_id=?,updated_at=? WHERE workspace_id=? AND file_key=? RETURNING file_key")
    .bind(operation,now(),workspace,key).first();
  // Legacy objects have no ledger because earlier versions did not charge them.
  // Recheck after claiming so a just-published source cannot be removed.
  if(await referenced(env,workspace,relative)){
    if(row)await env.DB.prepare("UPDATE knowledge_import_files SET state='stored' WHERE workspace_id=? AND file_key=? AND operation_id=?").bind(workspace,key,operation).run();
    return false;
  }
  await env.ATTACHMENTS.delete(key);
  if(row)await env.DB.prepare("DELETE FROM knowledge_import_files WHERE workspace_id=? AND file_key=? AND operation_id=? AND state='deleting'").bind(workspace,key,operation).run();
  return true;
}

/** Adopt existing bytes even when already over quota; never hide historic usage. */
export async function accountExistingKnowledgeImportObject(env:StorageEnv,workspace:string,key:string,size:number):Promise<boolean>{
  const relative=relativeKey(workspace,key),stamp=now();
  const row=await env.DB.prepare("INSERT INTO knowledge_import_files(workspace_id,file_key,job_id,bytes,content_hash,state,operation_id,created_at,updated_at) VALUES(?,?,?,?,?,'stored',?,?,?) ON CONFLICT DO NOTHING RETURNING file_key")
    .bind(workspace,key,relative.split('/')[1],size,'legacy',crypto.randomUUID(),stamp,stamp).first();
  return !!row;
}

/** Bounded, restartable scan. The maintenance caller persists the returned cursor. */
export async function reconcileKnowledgeImportUsage(env:StorageEnv,options:{cursor?:string;limit?:number;orphanCleanup?:boolean}={}):Promise<{cursor?:string;done:boolean;visited:number;adopted:number}>{
  const result=await env.ATTACHMENTS.list({prefix:'kb-imports/',limit:Math.min(100,Math.max(1,options.limit||100)),...(options.cursor?{cursor:options.cursor}:{})});
  let adopted=0;
  for(const object of result.objects){
    const workspace=object.key.split('/')[1];
    if(workspace&&await accountExistingKnowledgeImportObject(env,workspace,object.key,object.size))adopted++;
    const uploaded=object.uploaded instanceof Date?object.uploaded.getTime():NaN;
    if(options.orphanCleanup&&workspace&&Number.isFinite(uploaded)&&uploaded<Date.now()-24*60*60*1000){
      const jobId=relativeKey(workspace,object.key).split('/')[1];
      if(!await env.DB.prepare('SELECT id FROM knowledge_import_jobs WHERE workspace_id=? AND id=?').bind(workspace,jobId).first()){
        // Old deployments could die before creating a job. Reference checks still
        // protect committed files; unknown dates and recent objects are retained.
        await deleteKnowledgeImportObject(env,workspace,object.key).catch(()=>undefined);
      }
    }
  }
  return {done:!result.truncated,...(result.truncated?{cursor:result.cursor}:{}),visited:result.objects.length,adopted};
}

/** First admission scans a bounded page; retry resumes the workspace cursor. */
export async function ensureKnowledgeImportUsageReconciled(env:StorageEnv,workspace:string):Promise<void>{
  if(workspace==='default')return;
  await env.DB.prepare('INSERT INTO knowledge_import_usage_reconciliations(workspace_id,updated_at) VALUES(?,?) ON CONFLICT DO NOTHING').bind(workspace,now()).run();
  const state=await env.DB.prepare('SELECT cursor,version,complete FROM knowledge_import_usage_reconciliations WHERE workspace_id=?').bind(workspace).first<{cursor:string|null;version:number;complete:number}>();
  if(state?.complete)return;
  if(!state)throw new ImportError('storage_reconciliation_pending',409);
  const listed=await env.ATTACHMENTS.list({prefix:`kb-imports/${workspace}/`,limit:100,...(state.cursor?{cursor:state.cursor}:{})});
  for(const object of listed.objects)await accountExistingKnowledgeImportObject(env,workspace,object.key,object.size);
  // Concurrent requests may scan the same page; unique ledger keys prevent double
  // charging and this CAS prevents an older scan from moving the cursor backward.
  await env.DB.prepare('UPDATE knowledge_import_usage_reconciliations SET cursor=?,complete=?,version=version+1,updated_at=? WHERE workspace_id=? AND version=?').bind(listed.truncated?listed.cursor:null,listed.truncated?0:1,now(),workspace,state.version).run();
  const current=await env.DB.prepare('SELECT complete FROM knowledge_import_usage_reconciliations WHERE workspace_id=?').bind(workspace).first<{complete:number}>();
  if(!current?.complete)throw new ImportError('storage_reconciliation_pending',409);
}

/** Reserve once, before R2 I/O. Keys are immutable and scoped to one import job. */
export async function putKnowledgeImportObject(env:StorageEnv,workspace:string,key:string,data:Uint8Array,type:string):Promise<void>{
  const relative=relativeKey(workspace,key),jobId=relative.split('/')[1];
  if(!await liveJob(env,workspace,relative))throw new ImportError('preview_expired',410);
  await ensureKnowledgeImportUsageReconciled(env,workspace);
  const hash=await sha256(data),operation=crypto.randomUUID();
  const previous=await env.DB.prepare('SELECT bytes,content_hash,state,operation_id FROM knowledge_import_files WHERE workspace_id=? AND file_key=?').bind(workspace,key).first<FileRow>();
  if(previous){
    if(previous.content_hash==='legacy'&&previous.state==='stored'){
      const object=await env.ATTACHMENTS.get(key);
      if(object){const actual=new Uint8Array(await object.arrayBuffer());if(actual.length===data.length&&await sha256(actual)===hash){
        await env.DB.prepare("UPDATE knowledge_import_files SET content_hash=?,updated_at=? WHERE workspace_id=? AND file_key=? AND content_hash='legacy' AND state='stored'").bind(hash,now(),workspace,key).run();
        return;
      }}
    }
    if(previous.bytes!==data.length||previous.content_hash!==hash)throw new ImportError('storage_key_conflict',409);
    if(previous.state==='stored')return;
    throw new ImportError('storage_busy',409);
  }
  try{
    const inserted=await env.DB.prepare("INSERT INTO knowledge_import_files(workspace_id,file_key,job_id,bytes,content_hash,state,operation_id,created_at,updated_at) SELECT ?,?,?,?,?,'writing',?,?,? WHERE EXISTS(SELECT 1 FROM knowledge_import_jobs WHERE workspace_id=? AND id=? AND expires_at>? AND json_extract(data,'$.status') NOT IN ('cancelled','succeeded')) ON CONFLICT DO NOTHING RETURNING file_key")
      .bind(workspace,key,jobId,data.length,hash,operation,now(),now(),workspace,jobId,now()).first();
    if(!inserted)throw new ImportError('storage_busy',409);
  }catch(error){if(String(error).includes('storage_quota_exceeded'))throw new ImportError('storage_quota_exceeded',413);throw error;}
  try{
    await env.ATTACHMENTS.put(key,data,{httpMetadata:{contentType:type},customMetadata:{importOperation:operation}});
    if(!await liveJob(env,workspace,relative))throw new ImportError('preview_expired',410);
    const stored=await env.DB.prepare("UPDATE knowledge_import_files SET state='stored',updated_at=? WHERE workspace_id=? AND file_key=? AND operation_id=? AND state='writing' RETURNING file_key").bind(now(),workspace,key,operation).first();
    if(!stored)throw new ImportError('storage_busy',409);
  }catch(error){
    // Also fences a late PUT finishing after expiry cleanup deleted its object.
    // A failed delete leaves the reservation intact for service cleanup to retry.
    await deleteKnowledgeImportObject(env,workspace,key).catch(()=>undefined);
    throw error;
  }
}
