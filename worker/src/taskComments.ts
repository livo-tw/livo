import type { Context } from 'hono';
import type { AppContext, Env } from './env';
import { isDemoMember } from './env';
import { ensureKnowledgeImportUsageReconciled } from './knowledgeImportStorage';
import { notifyChanges } from './notify';
import { sendNotificationEmails } from './functions/emailNotify';
import { dispatchWebhooks } from './functions/webhooks';
import { COMMENT_PART_BYTES, CommentAttachmentError, commentNeed as need, commentId, commentUUID, commentFileError, commentSignature, commentPublishInput } from './taskCommentAttachmentCore';

type C = Context<AppContext>;
type Row = Record<string, any>;
const now = () => new Date().toISOString();
const hash = async (value: string | Uint8Array) => [...new Uint8Array(await crypto.subtle.digest('SHA-256', typeof value === 'string' ? new TextEncoder().encode(value) : value))].map(x => x.toString(16).padStart(2,'0')).join('');
const wire = (r: Row) => ({ id:r.id, taskId:r.task_id, commentId:r.comment_id || undefined, fileName:r.file_name, mimeType:r.mime_type, size:r.expected_size });
async function task(c: C, id: string) {
  const row = await c.env.DB.prepare('SELECT * FROM tasks WHERE workspace_id=? AND id=?').bind(c.get('auth').member.workspaceId,id).first<Row>();
  need(row,'task_unavailable',404); return row;
}
async function upload(c: C, id: string) {
  const actor=c.get('auth').member;
  const row=await c.env.DB.prepare('SELECT * FROM task_comment_uploads WHERE workspace_id=? AND id=? AND actor_id=?').bind(actor.workspaceId,id,actor.id).first<Row>();
  need(row,'upload_unavailable',404); await task(c,row.task_id);
  need(!['cleaning','aborted'].includes(row.state) && (row.comment_id || row.expires_at>now()),'upload_expired',410); return row;
}
async function readBytes(c: C, maximum: number) {
  const reader=c.req.raw.body?.getReader(); need(reader,'empty_upload');
  const chunks: Uint8Array[]=[]; let total=0;
  try { for (;;) { const r=await reader.read(); if(r.done)break; total+=r.value.length; need(total<=maximum,'file_size',413); chunks.push(r.value); } }
  finally { await reader.cancel().catch(()=>undefined); reader.releaseLock(); }
  const bytes=new Uint8Array(total); let offset=0; for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length;} return bytes;
}
/** Re-account a cleanup tombstone before retrying uncertain storage work. */
type CleanupEnv=Pick<Env,'DB'|'ATTACHMENTS'>;
async function rechargeCleanup(env:CleanupEnv,ws:string,row:Row){
  await env.DB.batch([
    env.DB.prepare("UPDATE workspaces SET storage_used_bytes=storage_used_bytes+? WHERE id=? AND EXISTS(SELECT 1 FROM task_comment_uploads WHERE workspace_id=? AND id=? AND comment_id IS NULL AND state IN ('cleaning','aborted') AND quota_released=1)").bind(row.expected_size,ws,ws,row.id),
    env.DB.prepare("UPDATE task_comment_uploads SET state='cleaning',quota_released=0 WHERE workspace_id=? AND id=? AND comment_id IS NULL AND state IN ('cleaning','aborted')").bind(ws,row.id),
  ]);
}
/** Retain tombstones: an uncertain late R2 completion is repaired, never forgotten. */
export async function cleanupLateTaskCommentObject(c:C,row:Row){
  const ws=c.get('auth').member.workspaceId;
  const owned=await c.env.DB.prepare("SELECT * FROM task_comment_uploads WHERE workspace_id=? AND id=? AND comment_id IS NULL AND state IN ('cleaning','aborted')").bind(ws,row.id).first<Row>();
  if(!owned)return;
  commentUUID(owned.id);commentId(owned.task_id);need(owned.storage_key===`task-comment/${ws}/${owned.task_id}/${owned.id}`&&owned.storage_key===row.storage_key,'cleanup_identity');
  try{await c.env.ATTACHMENTS.delete(row.storage_key);}
  catch(error){await rechargeCleanup(c.env,ws,owned);await c.env.DB.prepare("UPDATE task_comment_uploads SET cleanup_token=NULL WHERE workspace_id=? AND id=? AND comment_id IS NULL AND state='cleaning'").bind(ws,row.id).run();throw error;}
}
/** Only this workspace's unreferenced, expired reservations are eligible. */
export async function cleanupExpiredTaskCommentUploads(env:CleanupEnv,ws:string,limit=4) {
  need(Number.isInteger(limit)&&limit>0&&limit<=25,'cleanup_limit');
  const summary={claimed:0,removed:0,retained:0,failed:0};
  const stamp=now(),leaseBefore=new Date(Date.now()-120000).toISOString(),retryBefore=new Date(Date.now()-300000).toISOString();
  const rows=await env.DB.prepare("SELECT * FROM task_comment_uploads WHERE workspace_id=? AND comment_id IS NULL AND expires_at<=? AND (state<>'aborted' OR cleanup_last_attempt_at IS NULL OR cleanup_last_attempt_at<=?) AND (cleanup_token IS NULL OR cleanup_last_attempt_at<=?) ORDER BY coalesce(cleanup_last_attempt_at,''),expires_at LIMIT ?").bind(ws,stamp,retryBefore,leaseBefore,limit).all<Row>();
  for(const row of rows.results){
    const token=crypto.randomUUID();
    const claimed=await env.DB.prepare("UPDATE task_comment_uploads SET state='cleaning',cleanup_token=?,cleanup_last_attempt_at=? WHERE workspace_id=? AND id=? AND comment_id IS NULL AND expires_at<=? AND (cleanup_token IS NULL OR cleanup_last_attempt_at<=?) RETURNING id").bind(token,stamp,ws,row.id,stamp,leaseBefore).first();
    if(!claimed)continue;summary.claimed++;
    // Credit was previously released only after a storage ACK. Recharging makes
    // a failed repair conservative even if a completion arrived after that ACK.
    await rechargeCleanup(env,ws,row);
    try{
      commentUUID(row.id);commentId(row.task_id);need(row.storage_key===`task-comment/${ws}/${row.task_id}/${row.id}`,'cleanup_identity');
      if(row.multipart_id){
        try{await env.ATTACHMENTS.resumeMultipartUpload(row.storage_key,row.multipart_id).abort();}
        catch(error){if(!/NoSuchUpload|not found|does not exist|404/i.test(String(error)))throw error;}
      }
      await env.ATTACHMENTS.delete(row.storage_key);
      const acknowledged=await env.DB.batch([
        env.DB.prepare("UPDATE workspaces SET storage_used_bytes=MAX(0,storage_used_bytes-?) WHERE id=? AND EXISTS(SELECT 1 FROM task_comment_uploads WHERE workspace_id=? AND id=? AND state='cleaning' AND cleanup_token=? AND comment_id IS NULL AND quota_released=0)").bind(row.expected_size,ws,ws,row.id,token),
        env.DB.prepare("UPDATE task_comment_uploads SET state='aborted',quota_released=1 WHERE workspace_id=? AND id=? AND state='cleaning' AND cleanup_token=? AND comment_id IS NULL").bind(ws,row.id,token),
      ]);
      if(acknowledged[1].meta.changes)summary.removed++;else summary.retained++;
    }catch{summary.failed++;summary.retained++;await env.DB.prepare("UPDATE task_comment_uploads SET cleanup_token=NULL WHERE workspace_id=? AND id=? AND cleanup_token=? AND comment_id IS NULL AND state='cleaning'").bind(ws,row.id,token).run();}
  }
  return summary;
}
export async function cleanupTaskCommentUploads(c:C){return cleanupExpiredTaskCommentUploads(c.env,c.get('auth').member.workspaceId);}
async function initialize(c: C, body: Row) {
  const actor=c.get('auth').member, taskId=commentId(body.taskId), id=commentUUID(body.uploadId);
  await task(c,taskId); const error=commentFileError({name:body.fileName,type:body.mimeType,size:body.size}); need(!error,error || 'invalid_file');
  const prior=await c.env.DB.prepare('SELECT * FROM task_comment_uploads WHERE workspace_id=? AND id=?').bind(actor.workspaceId,id).first<Row>();
  if(prior){ need(prior.actor_id===actor.id && prior.task_id===taskId && prior.file_name===body.fileName && prior.mime_type===body.mimeType && prior.expected_size===body.size,'upload_id_reused',409); await upload(c,id); need(prior.multipart_id,'upload_initializing',409); return c.json({id,provider:'r2',partSize:COMMENT_PART_BYTES}); }
  await cleanupTaskCommentUploads(c); await ensureKnowledgeImportUsageReconciled(c.env,actor.workspaceId);
  const key=`task-comment/${actor.workspaceId}/${taskId}/${id}`, created=now(), expires=new Date(Date.now()+86400000).toISOString();
  try{
    await c.env.DB.prepare('INSERT INTO task_comment_uploads(workspace_id,id,task_id,actor_id,file_name,mime_type,expected_size,storage_key,created_at,expires_at) VALUES(?,?,?,?,?,?,?,?,?,?)').bind(actor.workspaceId,id,taskId,actor.id,body.fileName,body.mimeType,body.size,key,created,expires).run();
  }catch(error){
    // The atomic insert trigger charges once; an unknown acknowledgement never releases it.
    throw error;
  }
  try{
    const remote=await c.env.ATTACHMENTS.createMultipartUpload(key,{httpMetadata:{contentType:body.mimeType},customMetadata:{workspace:actor.workspaceId,task:taskId,upload:id}});
    await c.env.DB.prepare("UPDATE task_comment_uploads SET multipart_id=?,state='uploading' WHERE workspace_id=? AND id=? AND state='initializing'").bind(remote.uploadId,actor.workspaceId,id).run();
  }catch(error){await c.env.DB.prepare('UPDATE task_comment_uploads SET expires_at=? WHERE workspace_id=? AND id=?').bind(now(),actor.workspaceId,id).run();throw error;}
  return c.json({id,provider:'r2',partSize:COMMENT_PART_BYTES});
}
async function part(c: C) {
  const row=await upload(c,commentUUID(c.req.query('uploadId'))), number=Number(c.req.query('partNumber'));
  need(row.state==='uploading' && row.multipart_id,'upload_conflict',409);
  const count=Math.ceil(row.expected_size/COMMENT_PART_BYTES); need(Number.isSafeInteger(number)&&number>=1&&number<=count,'invalid_part');
  const bytes=await readBytes(c,COMMENT_PART_BYTES); need(bytes.length===(number===count?row.expected_size-(number-1)*COMMENT_PART_BYTES:COMMENT_PART_BYTES),'invalid_part_size');
  if(number===1)commentSignature(row.mime_type,bytes); const digest=await hash(bytes),ws=c.get('auth').member.workspaceId;
  const prior=await c.env.DB.prepare('SELECT * FROM task_comment_upload_parts WHERE workspace_id=? AND upload_id=? AND part_number=?').bind(ws,row.id,number).first<Row>();
  if(prior){need(prior.digest===digest,'part_conflict',409);if(prior.etag)return c.json({partNumber:number,etag:prior.etag});}
  await c.env.DB.prepare('INSERT OR IGNORE INTO task_comment_upload_parts(workspace_id,upload_id,part_number,digest,size) VALUES(?,?,?,?,?)').bind(ws,row.id,number,digest,bytes.length).run();
  const locked=await c.env.DB.prepare('SELECT digest FROM task_comment_upload_parts WHERE workspace_id=? AND upload_id=? AND part_number=?').bind(ws,row.id,number).first<Row>(); need(locked?.digest===digest,'part_conflict',409);
  const result=await c.env.ATTACHMENTS.resumeMultipartUpload(row.storage_key,row.multipart_id).uploadPart(number,bytes);
  await c.env.DB.prepare('UPDATE task_comment_upload_parts SET etag=? WHERE workspace_id=? AND upload_id=? AND part_number=? AND digest=?').bind(result.etag,ws,row.id,number,digest).run();
  return c.json({partNumber:number,etag:result.etag});
}
async function complete(c: C, body: Row) {
  const row=await upload(c,commentUUID(body.uploadId)),ws=c.get('auth').member.workspaceId;
  if(['complete','bound'].includes(row.state))return c.json(wire(row));
  need(['uploading','finalizing'].includes(row.state),'upload_conflict',409);
  const rows=await c.env.DB.prepare('SELECT * FROM task_comment_upload_parts WHERE workspace_id=? AND upload_id=? ORDER BY part_number').bind(ws,row.id).all<Row>();
  need(rows.results.length===Math.ceil(row.expected_size/COMMENT_PART_BYTES)&&rows.results.every((r,i)=>r.part_number===i+1&&r.etag)&&rows.results.reduce((sum,r)=>sum+r.size,0)===row.expected_size,'upload_incomplete',409);
  const claim=await c.env.DB.prepare("UPDATE task_comment_uploads SET state='finalizing' WHERE workspace_id=? AND id=? AND state IN ('uploading','finalizing') AND expires_at>? RETURNING id").bind(ws,row.id,now()).first(); need(claim,'upload_expired',410);
  let object=await c.env.ATTACHMENTS.head(row.storage_key);
  if(!object){try{await c.env.ATTACHMENTS.resumeMultipartUpload(row.storage_key,row.multipart_id).complete(rows.results.map(r=>({partNumber:r.part_number,etag:r.etag})));}catch(error){if(!await c.env.ATTACHMENTS.head(row.storage_key))throw error;} object=await c.env.ATTACHMENTS.head(row.storage_key);}
  need(object&&object.size===row.expected_size&&object.customMetadata?.workspace===ws&&object.customMetadata?.upload===row.id,'upload_identity');
  const saved=await c.env.DB.prepare("UPDATE task_comment_uploads SET state='complete' WHERE workspace_id=? AND id=? AND state='finalizing' AND expires_at>? RETURNING id").bind(ws,row.id,now()).first(); if(!saved){
    await cleanupLateTaskCommentObject(c,row);
    throw new CommentAttachmentError('upload_expired',410);
  }
  return c.json(wire(row));
}
export async function taskAttachmentSummary(c:C,ids:string[]){
  const actor=c.get('auth').member,ws=actor.workspaceId;
  const rows=ids.length?await c.env.DB.prepare(`WITH allowed AS(SELECT id FROM tasks WHERE workspace_id=? AND id IN(SELECT value FROM json_each(?))),
    normal AS(SELECT task_id,count(*) n FROM task_attachments WHERE workspace_id=? AND task_id IN(SELECT id FROM allowed) GROUP BY task_id),
    legacy AS(SELECT task_id,count(*) total,sum(CASE WHEN attachment_url IS NOT NULL AND attachment_url<>'' THEN 1 ELSE 0 END) n FROM comments WHERE workspace_id=? AND task_id IN(SELECT id FROM allowed) GROUP BY task_id),
    private AS(SELECT task_id,count(*) n FROM task_comment_uploads WHERE workspace_id=? AND task_id IN(SELECT id FROM allowed) AND state='bound' AND comment_id IS NOT NULL GROUP BY task_id)
    SELECT a.id,coalesce(n.n,0)+coalesce(l.n,0)+coalesce(p.n,0) AS count,coalesce(l.total,0) AS comments FROM allowed a LEFT JOIN normal n ON n.task_id=a.id LEFT JOIN legacy l ON l.task_id=a.id LEFT JOIN private p ON p.task_id=a.id`)
    .bind(ws,JSON.stringify(ids),ws,ws,ws).all<Row>():{results:[] as Row[]};
  const quota=ws==='default'?null:await c.env.DB.prepare(`SELECT storage_used_bytes+coalesce((SELECT sum(expected_size) FROM qa_upload_sessions WHERE workspace_id=? AND state IN ('initializing','uploading','finalizing','aborting')),0) AS used FROM workspaces WHERE id=?`).bind(ws,ws).first<Row>();
  const accounting=ws!=='default'?quota:await c.env.DB.prepare(`SELECT coalesce((SELECT sum(file_size) FROM task_attachments WHERE workspace_id=?),0)+coalesce((SELECT sum(attachment_size) FROM comments WHERE workspace_id=?),0)+coalesce((SELECT sum(expected_size) FROM task_comment_uploads WHERE workspace_id=? AND quota_released=0 AND state<>'aborted'),0) AS used`).bind(ws,ws,ws).first<Row>();
  need(accounting&&Number.isSafeInteger(Number(accounting.used))&&Number(accounting.used)>=0,'summary_unavailable',503);
  return{workspaceId:ws,actorId:actor.id,counts:Object.fromEntries(rows.results.map(row=>[row.id,Number(row.count)])),commentCounts:Object.fromEntries(rows.results.map(row=>[row.id,Number(row.comments)])),storageUsedBytes:Number(accounting.used),storageUsageSource:quota?'workspace_quota':'task_attachment_accounting'};
}
async function receipt(c: C, commandId: string) {
  const actor=c.get('auth').member;
  const row=await c.env.DB.prepare('SELECT * FROM task_comment_commands WHERE workspace_id=? AND id=? AND actor_id=?').bind(actor.workspaceId,commandId,actor.id).first<Row>(); need(row,'command_not_found',404); await task(c,row.task_id);
  const comment=await c.env.DB.prepare('SELECT * FROM comments WHERE workspace_id=? AND id=?').bind(actor.workspaceId,commandId).first<Row>(); need(comment,'comment_unavailable',404);
  const summary=await taskAttachmentSummary(c,[row.task_id]);
  return {comment,commentCount:summary.commentCounts[row.task_id],attachmentCount:summary.counts[row.task_id]};
}
async function publish(c: C, body: Row) {
  const input=commentPublishInput(body),actor=c.get('auth').member,ws=actor.workspaceId,t=await task(c,input.taskId);
  const digest=await hash(JSON.stringify(input));
  const previous=await c.env.DB.prepare('SELECT payload_hash FROM task_comment_commands WHERE workspace_id=? AND id=? AND actor_id=?').bind(ws,input.commandId,actor.id).first<Row>();
  if(previous){need(previous.payload_hash===digest,'command_id_reused',409);return c.json(await receipt(c,input.commandId));}
  const people=[...new Set([...input.mentionIds,t.assignee_id,t.reviewer_id].filter((id):id is string=>typeof id==='string'&&id!==actor.id))];
  const plain=input.body.replace(/<[^>]*>/g,'').trim().slice(0,100);
  const notifications=people.map(id=>({id,type:input.mentionIds.includes(id)?'mention':'comment',content:plain}));
  let inserted=true;
  try{
    await c.env.DB.prepare('INSERT INTO task_comment_commands(workspace_id,id,task_id,actor_id,payload_hash,body,upload_ids,notifications,created_at) VALUES(?,?,?,?,?,?,?,?,?)').bind(ws,input.commandId,input.taskId,actor.id,digest,input.body,JSON.stringify(input.uploadIds),JSON.stringify(notifications),now()).run();
  }catch(error){const won=await c.env.DB.prepare('SELECT payload_hash FROM task_comment_commands WHERE workspace_id=? AND id=? AND actor_id=?').bind(ws,input.commandId,actor.id).first<Row>();if(!won)throw error;need(won.payload_hash===digest,'command_id_reused',409);inserted=false;}
  const result=await receipt(c,input.commandId);
  notifyChanges(c.env,c.executionCtx,[{table:'comments',eventType:'INSERT',new:result.comment,old:null}],ws);
  if(inserted){
    const saved=await c.env.DB.prepare('SELECT * FROM notifications WHERE workspace_id=? AND sender_id=? AND id LIKE ?').bind(ws,actor.id,input.commandId+':%').all<Row>();
    notifyChanges(c.env,c.executionCtx,saved.results.map(row=>({table:'notifications',eventType:'INSERT' as const,new:row,old:null})),ws);
    c.executionCtx.waitUntil(sendNotificationEmails(c.env,saved.results));
    c.executionCtx.waitUntil(dispatchWebhooks(c.env,'comment_added',[result.comment]));
  }
  return c.json(result);
}
export async function handleTaskComments(c: C): Promise<Response> {
  try{
    c.header('Cache-Control','no-store');
    const queryAction=c.req.query('action');
    const body:Row=queryAction==='upload_part'?{}:JSON.parse(new TextDecoder().decode(await readBytes(c,65536)));
    const action=queryAction || body.action;
    need(typeof action==='string','invalid_action');
    if(!['list','download','readback','coverage','summary'].includes(action))need(!isDemoMember(c.env,c.get('auth')),'demo_write_forbidden',403);
    if(action==='upload_part')return await part(c);
    if(action==='summary'){
      need(Array.isArray(body.taskIds)&&body.taskIds.length<=1000,'invalid_task_summary');
      const ids=[...new Set((body.taskIds as unknown[]).map(commentId))];return c.json(await taskAttachmentSummary(c,ids));
    }
    if(action==='coverage'){
      const actor=c.get('auth').member;need(actor.role==='super_admin','forbidden',403);
      const counted=await c.env.DB.prepare("SELECT count(*) AS count FROM task_comment_uploads WHERE workspace_id=? AND state<>'aborted'").bind(actor.workspaceId).first<Row>();
      need(counted&&Number.isSafeInteger(Number(counted.count))&&Number(counted.count)>=0,'coverage_unknown',503);
      return c.json({kind:'task_comment_private_media',coveredByJsonBackup:false,requiresDatabaseAndPrivateStorageBackup:true,retainedMetadata:Number(counted.count),commandReceiptsExcluded:true});
    }
    if(action==='upload_init')return await initialize(c,body);
    if(action==='upload_complete')return await complete(c,body);
    if(action==='publish')return await publish(c,body);
    if(action==='readback')return c.json(await receipt(c,commentUUID(body.commandId)));
    if(action==='list'){
      const id=commentId(body.taskId),offset=Number(body.offset||0);need(Number.isSafeInteger(offset)&&offset>=0&&offset<=100000,'invalid_offset');await task(c,id);
      const rows=await c.env.DB.prepare('SELECT * FROM task_comment_uploads WHERE workspace_id=? AND task_id=? AND comment_id IS NOT NULL AND state=\'bound\' ORDER BY created_at,id LIMIT 101 OFFSET ?').bind(c.get('auth').member.workspaceId,id,offset).all<Row>();return c.json({attachments:rows.results.slice(0,100).map(wire),hasMore:rows.results.length>100});
    }
    if(action==='download'){
      const actor=c.get('auth').member,row=await c.env.DB.prepare('SELECT * FROM task_comment_uploads WHERE workspace_id=? AND id=? AND state IN (\'complete\',\'bound\')').bind(actor.workspaceId,commentUUID(body.attachmentId)).first<Row>(); need(row&&(row.comment_id||row.actor_id===actor.id),'attachment_unavailable',404); await task(c,row.task_id);
      const object=await c.env.ATTACHMENTS.get(row.storage_key);need(object,'attachment_missing',404);
      return new Response(object.body,{headers:{'Content-Type':row.mime_type,'Content-Length':String(object.size),'Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff','Content-Disposition':`attachment; filename*=UTF-8''${encodeURIComponent(row.file_name)}`,'Content-Security-Policy':"sandbox; default-src 'none'"}});
    }
    throw new CommentAttachmentError('invalid_action');
  }catch(error){const message=String(error);const e=error instanceof CommentAttachmentError?error:error instanceof SyntaxError?new CommentAttachmentError('invalid_json'):message.includes('storage_quota_exceeded')?new CommentAttachmentError('storage_quota_exceeded',413):message.includes('task_comment_invalid_upload')?new CommentAttachmentError('invalid_upload',409):message.includes('task_comment_forbidden')?new CommentAttachmentError('forbidden',403):new CommentAttachmentError('task_comment_failed',500);return c.json({error:{code:e.code,message:e.code}},e.status as 400);}
}
