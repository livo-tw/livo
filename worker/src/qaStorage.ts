import type { Context } from 'hono';
import type { AppContext, Env } from './env';
import { QaError, QA_MAX_FILE_BYTES, QA_PART_BYTES, type QaAttachment } from './qa/domain';
import { getQaIssue, qaHash, qaId, qaReadBody, requireQaEnabled } from './qa';

type C=Context<AppContext>;
interface Session {
  workspace_id:string;id:string;issue_id:string;actor_id:string;file_name:string;mime_type:string;
  expected_size:number;storage_key:string;multipart_id:string|null;state:string;expires_at:string;
}
const TYPES:Record<string,string[]>={
  'image/png':['png'],'image/jpeg':['jpg','jpeg'],'image/webp':['webp'],'image/gif':['gif'],
  'video/mp4':['mp4'],'application/pdf':['pdf'],'text/plain':['txt','log'],
  'text/csv':['csv'],'application/json':['json'],
};
export function qaFileInput(name:unknown,mime:unknown,size:unknown) {
  if(typeof name!=='string'||!name.trim()||name.length>180||/[\x00-\x1f\\/]/.test(name))throw new QaError('qa_invalid_file_name');
  if(typeof mime!=='string'||!TYPES[mime]||!TYPES[mime].includes(name.split('.').pop()!.toLowerCase()))throw new QaError('qa_invalid_file_type');
  if(!Number.isSafeInteger(size)||Number(size)<=0||Number(size)>QA_MAX_FILE_BYTES)throw new QaError('qa_file_too_large',413);
  return {fileName:name.trim(),mimeType:mime,size:Number(size)};
}
export function qaCheckSignature(mime:string,bytes:Uint8Array):void {
  const ascii=(a:number,b:number)=>new TextDecoder().decode(bytes.slice(a,b));
  let valid=false;
  if(mime==='image/png')valid=bytes.length>=8&&[137,80,78,71,13,10,26,10].every((v,i)=>bytes[i]===v);
  else if(mime==='image/jpeg')valid=bytes[0]===255&&bytes[1]===216&&bytes[2]===255;
  else if(mime==='image/gif')valid=['GIF87a','GIF89a'].includes(ascii(0,6));
  else if(mime==='image/webp')valid=ascii(0,4)==='RIFF'&&ascii(8,12)==='WEBP';
  else if(mime==='video/mp4')valid=bytes.length>=12&&ascii(4,8)==='ftyp';
  else if(mime==='application/pdf')valid=ascii(0,5)==='%PDF-';
  else if(mime.startsWith('text/')||mime==='application/json'){
    // Text is always downloaded as an attachment; HTML/SVG/script uploads are rejected.
    try{const text=new TextDecoder('utf-8',{fatal:true,ignoreBOM:false}).decode(bytes.slice(0,Math.min(bytes.length,8192)),{stream:true});valid=!text.includes('\0')&&!/<\s*(?:!doctype\s+html|html|svg|script)\b/i.test(text);}catch{valid=false;}
  }
  if(!valid)throw new QaError('qa_file_signature_mismatch');
}
export function qaAttachmentWire(row:Record<string,unknown>):QaAttachment {
  return {id:String(row.id),issueId:String(row.issue_id),fileName:String(row.file_name),mimeType:String(row.mime_type),size:Number(row.size),uploadedBy:String(row.uploaded_by),createdAt:String(row.created_at)};
}
async function session(c:C,id:string):Promise<Session>{
  const auth=c.get('auth'),ws=auth.member.workspaceId;
  const row=await c.env.DB.prepare('SELECT * FROM qa_upload_sessions WHERE workspace_id=? AND id=? AND actor_id=?').bind(ws,id,auth.member.id).first<Session>();
  if(!row)throw new QaError('qa_upload_not_found',404);
  await getQaIssue(c.env,ws,row.issue_id);
  if(row.state!=='complete'&&row.expires_at<=new Date().toISOString())throw new QaError('qa_upload_expired',410);
  return row;
}
/** Cleanup remains tenant-scoped and only releases reservation after R2 cleanup succeeds. */
export async function cleanupQaExpiredUploads(env:Env,ws:string):Promise<void>{
  const now=new Date().toISOString();
  const expired=await env.DB.prepare("SELECT * FROM qa_upload_sessions WHERE workspace_id=? AND state IN ('initializing','uploading','finalizing','aborting') AND expires_at<=? LIMIT 30").bind(ws,now).all<Session>();
  for(const item of expired.results){
    const claimed=await env.DB.prepare("UPDATE qa_upload_sessions SET state='aborting' WHERE workspace_id=? AND id=? AND state IN ('initializing','uploading','finalizing','aborting') AND expires_at<=? RETURNING id").bind(ws,item.id,now).first();
    if(!claimed)continue;
    try{
      if(item.multipart_id){try{await env.ATTACHMENTS.resumeMultipartUpload(item.storage_key,item.multipart_id).abort();}catch(error){
        if(!/NoSuchUpload|does not exist|not found|already.*(?:abort|complet)/i.test(String(error)))throw error;
      }}
      await env.ATTACHMENTS.delete(item.storage_key);
      await env.DB.prepare("UPDATE qa_upload_sessions SET state='aborted' WHERE workspace_id=? AND id=? AND state='aborting'").bind(ws,item.id).run();
    }catch{/* Keep reservation and retry cleanup; never free quota before cleanup. */}
  }
}
async function init(c:C,body:Record<string,unknown>):Promise<Response>{
  const auth=c.get('auth'),ws=auth.member.workspaceId,id=qaId(body.id);
  const issue=await getQaIssue(c.env,ws,id),file=qaFileInput(body.fileName,body.mimeType,body.size);
  await cleanupQaExpiredUploads(c.env,ws);
  const uploadId=crypto.randomUUID(),storageKey=`qa/${ws}/${id}/${uploadId}`,now=new Date().toISOString(),expiry=new Date(Date.now()+24*60*60*1000).toISOString();
  await c.env.DB.prepare('INSERT INTO qa_upload_sessions(workspace_id,id,issue_id,actor_id,file_name,mime_type,expected_size,storage_key,created_at,expires_at) VALUES(?,?,?,?,?,?,?,?,?,?)').bind(ws,uploadId,issue.id,auth.member.id,file.fileName,file.mimeType,file.size,storageKey,now,expiry).run();
  try{
    const upload=await c.env.ATTACHMENTS.createMultipartUpload(storageKey,{httpMetadata:{contentType:file.mimeType,contentDisposition:`attachment; filename*=UTF-8''${encodeURIComponent(file.fileName)}`},customMetadata:{workspace:ws,issue:id,upload:uploadId}});
    await c.env.DB.prepare("UPDATE qa_upload_sessions SET multipart_id=?,state='uploading' WHERE workspace_id=? AND id=? AND state='initializing'").bind(upload.uploadId,ws,uploadId).run();
  }catch(error){
    await c.env.DB.prepare("UPDATE qa_upload_sessions SET expires_at=? WHERE workspace_id=? AND id=?").bind(now,ws,uploadId).run();
    // If R2 creation's response was lost, bucket multipart lifecycle rules are a secondary safeguard.
    throw error;
  }
  return c.json({id:uploadId,provider:'r2',partSize:QA_PART_BYTES});
}
async function uploadPart(c:C):Promise<Response>{
  const ws=c.get('auth').member.workspaceId,id=qaId(c.req.query('uploadId'));
  const number=Number(c.req.query('partNumber')),row=await session(c,id);
  if(row.state!=='uploading'||!row.multipart_id)throw new QaError('qa_upload_conflict',409);
  const count=Math.ceil(row.expected_size/QA_PART_BYTES);
  if(!Number.isSafeInteger(number)||number<1||number>count)throw new QaError('qa_invalid_part');
  const bytes=await qaReadBody(c,QA_PART_BYTES),expected=number===count?row.expected_size-(number-1)*QA_PART_BYTES:QA_PART_BYTES;
  if(bytes.byteLength!==expected)throw new QaError('qa_invalid_part_size');
  if(number===1)qaCheckSignature(row.mime_type,bytes);
  const digest=await qaHash(bytes);
  const prior=await c.env.DB.prepare('SELECT etag,digest,lease_token,claimed_at FROM qa_upload_parts WHERE workspace_id=? AND upload_id=? AND part_number=?').bind(ws,id,number).first<{etag:string|null;digest:string;lease_token:string;claimed_at:number}>();
  if(prior){if(prior.digest!==digest)throw new QaError('qa_part_conflict',409);if(prior.etag)return c.json({partNumber:number,etag:prior.etag});if(prior.claimed_at>Date.now()-120000)throw new QaError('qa_part_in_progress',409);}
  const lease=crypto.randomUUID(),stamp=Date.now();
  const claimed=prior
    ? await c.env.DB.prepare("UPDATE qa_upload_parts SET lease_token=?,claimed_at=? WHERE workspace_id=? AND upload_id=? AND part_number=? AND lease_token=? AND etag IS NULL AND EXISTS(SELECT 1 FROM qa_upload_sessions WHERE workspace_id=? AND id=? AND state='uploading' AND expires_at>?) RETURNING part_number").bind(lease,stamp,ws,id,number,prior.lease_token,ws,id,new Date().toISOString()).first()
    : await c.env.DB.prepare("INSERT INTO qa_upload_parts(workspace_id,upload_id,part_number,size,digest,lease_token,claimed_at) SELECT ?,?,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM qa_upload_sessions WHERE workspace_id=? AND id=? AND state='uploading' AND expires_at>?) RETURNING part_number").bind(ws,id,number,bytes.byteLength,digest,lease,stamp,ws,id,new Date().toISOString()).first();
  if(!claimed)throw new QaError('qa_upload_conflict',409);
  try{
    const part=await c.env.ATTACHMENTS.resumeMultipartUpload(row.storage_key,row.multipart_id).uploadPart(number,bytes);
    const saved=await c.env.DB.prepare("UPDATE qa_upload_parts SET etag=? WHERE workspace_id=? AND upload_id=? AND part_number=? AND digest=? AND lease_token=? AND EXISTS(SELECT 1 FROM qa_upload_sessions WHERE workspace_id=? AND id=? AND state='uploading') RETURNING part_number").bind(part.etag,ws,id,number,digest,lease,ws,id).first();
    if(!saved)throw new QaError('qa_upload_conflict',409);
    return c.json({partNumber:part.partNumber,etag:part.etag});
  }catch(err){
    await c.env.DB.prepare('DELETE FROM qa_upload_parts WHERE workspace_id=? AND upload_id=? AND part_number=? AND etag IS NULL AND digest=? AND lease_token=?').bind(ws,id,number,digest,lease).run();throw err;
  }
}
async function complete(c:C,body:Record<string,unknown>):Promise<Response>{
  const auth=c.get('auth'),ws=auth.member.workspaceId,id=qaId(body.uploadId),row=await session(c,id);
  const previous=await c.env.DB.prepare('SELECT * FROM qa_attachments WHERE workspace_id=? AND id=?').bind(ws,id).first();
  if(previous)return c.json(qaAttachmentWire(previous));
  if(!['uploading','finalizing'].includes(row.state)||!row.multipart_id)throw new QaError('qa_upload_conflict',409);
  const parts=await c.env.DB.prepare('SELECT part_number,size,etag FROM qa_upload_parts WHERE workspace_id=? AND upload_id=? ORDER BY part_number').bind(ws,id).all<{part_number:number;size:number;etag:string|null}>();
  const count=Math.ceil(row.expected_size/QA_PART_BYTES);
  if(parts.results.length!==count||parts.results.some((p,i)=>p.part_number!==i+1||!p.etag)||parts.results.reduce((n,p)=>n+p.size,0)!==row.expected_size)throw new QaError('qa_upload_incomplete',409);
  const claim=await c.env.DB.prepare("UPDATE qa_upload_sessions SET state='finalizing' WHERE workspace_id=? AND id=? AND state IN ('uploading','finalizing') AND expires_at>? RETURNING id").bind(ws,id,new Date().toISOString()).first();
  if(!claim)throw new QaError('qa_upload_conflict',409);
  let object=await c.env.ATTACHMENTS.head(row.storage_key);
  if(!object){
    try{await c.env.ATTACHMENTS.resumeMultipartUpload(row.storage_key,row.multipart_id).complete(parts.results.map(p=>({partNumber:p.part_number,etag:p.etag!})));}
    catch(err){object=await c.env.ATTACHMENTS.head(row.storage_key);if(!object)throw err;}
    object=object??await c.env.ATTACHMENTS.head(row.storage_key);
  }
  if(!object||object.size!==row.expected_size||object.customMetadata?.workspace!==ws||object.customMetadata?.upload!==id)throw new QaError('qa_upload_size_mismatch');
  await requireQaEnabled(c.env,ws);
  const now=new Date().toISOString();
  try{
    // Finalize trigger rechecks quota/state and transfers reserved→used exactly once.
    await c.env.DB.batch([
      c.env.DB.prepare('INSERT INTO qa_attachments(workspace_id,id,issue_id,uploaded_by,file_name,mime_type,size,storage_key,created_at) VALUES(?,?,?,?,?,?,?,?,?)').bind(ws,id,row.issue_id,auth.member.id,row.file_name,row.mime_type,object.size,row.storage_key,now),
      c.env.DB.prepare("INSERT INTO qa_events(workspace_id,id,issue_id,actor_id,type,detail,version,created_at) SELECT ?,?,?,?,'attachment_added',?,version,? FROM qa_issues WHERE workspace_id=? AND id=?").bind(ws,crypto.randomUUID(),row.issue_id,auth.member.id,JSON.stringify({attachmentId:id,fileName:row.file_name}),now,ws,row.issue_id),
    ]);
  }catch(err){const won=await c.env.DB.prepare('SELECT * FROM qa_attachments WHERE workspace_id=? AND id=?').bind(ws,id).first();if(won)return c.json(qaAttachmentWire(won));throw err;}
  return c.json({id,issueId:row.issue_id,fileName:row.file_name,mimeType:row.mime_type,size:object.size,uploadedBy:auth.member.id,createdAt:now});
}
export function qaRange(header:string|null,size:number):{offset:number;length:number}|undefined{
  if(!header)return undefined;const match=/^bytes=(\d*)-(\d*)$/.exec(header);
  if(!match||(!match[1]&&!match[2]))throw new QaError('qa_invalid_range',416);
  let start:number,end:number;
  if(!match[1]){const tail=Number(match[2]);if(!Number.isSafeInteger(tail)||tail<=0)throw new QaError('qa_invalid_range',416);start=Math.max(0,size-tail);end=size-1;}
  else{start=Number(match[1]);end=match[2]?Math.min(Number(match[2]),size-1):size-1;}
  if(!Number.isSafeInteger(start)||!Number.isSafeInteger(end)||start<0||start>=size||end<start)throw new QaError('qa_invalid_range',416);
  return {offset:start,length:end-start+1};
}
async function download(c:C,body:Record<string,unknown>):Promise<Response>{
  const ws=c.get('auth').member.workspaceId,id=qaId(body.attachmentId);
  const row=await c.env.DB.prepare('SELECT * FROM qa_attachments WHERE workspace_id=? AND id=?').bind(ws,id).first<Record<string,unknown>>();
  if(!row)throw new QaError('qa_attachment_not_found',404);await getQaIssue(c.env,ws,String(row.issue_id));
  const range=qaRange(c.req.raw.headers.get('range'),Number(row.size));
  const object=await c.env.ATTACHMENTS.get(String(row.storage_key),range?{range}:undefined);
  if(!object)throw new QaError('qa_attachment_missing',404);
  const mime=String(row.mime_type),inline=mime.startsWith('image/')||mime==='video/mp4';
  const headers=new Headers({'Content-Type':mime,'Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff','Content-Disposition':`${inline?'inline':'attachment'}; filename*=UTF-8''${encodeURIComponent(String(row.file_name))}`,'Accept-Ranges':'bytes','Content-Length':String(range?.length??object.size),'Content-Security-Policy':"sandbox; default-src 'none'"});
  if(range)headers.set('Content-Range',`bytes ${range.offset}-${range.offset+range.length-1}/${row.size}`);
  return new Response(object.body,{status:range?206:200,headers});
}
export async function handleQaStorage(c:C,action:string,body:Record<string,unknown>):Promise<Response>{
  if(action==='upload_init')return init(c,body);
  if(action==='upload_part')return uploadPart(c);
  if(action==='upload_complete')return complete(c,body);
  if(action==='download')return download(c,body);
  throw new QaError('qa_invalid_action');
}
