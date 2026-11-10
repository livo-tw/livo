import { createClient } from '@supabase/supabase-js';
import { supabase } from '@/integrations/supabase/client';
import { fnUrl } from '@/lib/apiBase';
import { SUPABASE_URL } from '@/lib/gatewayUrl';
import { randomUUID } from '@/lib/generateId';
import { observeApiFetch } from '@/lib/apiReachability';
import { COMMENT_PART_BYTES, CommentAttachmentError, commentFileError, type CommentMedia } from './taskCommentAttachmentCore';

export type TaskCommentCoverage = {kind:'task_comment_private_media';coveredByJsonBackup:false;requiresDatabaseAndPrivateStorageBackup:true;retainedMetadata:number;commandReceiptsExcluded:true};
export type TaskCommentUpload = { id: string; provider: 'r2' | 'supabase'; partSize?: number; bucket?: string; path?: string; token?: string };
export type TaskCommentResume = { id?: string; taskId?: string; file?: File; upload?: TaskCommentUpload; parts?: { partNumber: number; etag: string }[]; attachment?: CommentMedia };
export type TaskCommentReceipt = { comment: { id: string; task_id: string; user_id: string; content: string; created_at: string }; commentCount: number; attachmentCount?: number };
export type TaskAttachmentSummary={workspaceId:string;actorId:string;counts:Record<string,number>;commentCounts:Record<string,number>;storageUsedBytes:number;storageUsageSource:'workspace_quota'|'task_attachment_accounting'};
async function headers() {
  const { data: { session } } = await supabase.auth.getSession();
  if (!session?.access_token) throw new CommentAttachmentError('unauthorized',401);
  return { Authorization: `Bearer ${session.access_token}`, ...(import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY ? {apikey:String(import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY)} : {}) };
}
async function checked(response: Response) {
  if (!response.ok) { const error = await response.json().catch(() => ({})); throw new CommentAttachmentError(error.error?.code || `http_${response.status}`,response.status); }
  return response;
}
const abort = (signal?: AbortSignal) => { if (signal?.aborted) throw signal.reason || new DOMException('Aborted','AbortError'); };
export async function taskCommentRequest<T>(action: string, input: Record<string,unknown>, signal?: AbortSignal): Promise<T> {
  abort(signal);
  const url=fnUrl('task-comments'),authHeaders=await headers();
  return (await checked(await observeApiFetch(()=>fetch(url,{method:'POST',cache:'no-store',headers:{...authHeaders,'Content-Type':'application/json'},body:JSON.stringify({action,...input}),signal}),new URL(url,document.baseURI).origin,signal))).json();
}
export async function uploadTaskCommentFile(taskId: string, file: File, resume: TaskCommentResume, progress: (value: number) => void, signal?: AbortSignal): Promise<CommentMedia> {
  abort(signal); const error=commentFileError(file); if(error)throw new CommentAttachmentError(error);
  if((resume.file&&resume.file!==file)||(resume.taskId&&resume.taskId!==taskId))throw new CommentAttachmentError('upload_context_changed');
  resume.taskId=taskId;resume.file=file;resume.id ??= randomUUID();
  if(resume.attachment){progress(100);return resume.attachment;}
  const complete = async () => {
    const result=await taskCommentRequest<CommentMedia>('upload_complete',{uploadId:resume.id},signal);
    resume.attachment=result;progress(100);return result;
  };
  // A lost init, upload or complete response never allocates another reservation blindly.
  try { return await complete(); }
  catch(error) {
    abort(signal); const code=(error as CommentAttachmentError).code;
    if(['upload_expired'].includes(code)){resume.id=randomUUID();resume.upload=undefined;resume.parts=[];}
    else if(!['upload_unavailable','upload_incomplete','upload_conflict','upload_initializing','command_not_found','http_404'].includes(code))throw error;
  }
  resume.upload ??= await taskCommentRequest<TaskCommentUpload>('upload_init',{taskId,uploadId:resume.id,fileName:file.name,mimeType:file.type,size:file.size},signal);
  const upload=resume.upload;
  if(upload.provider==='supabase'){
    if(!upload.bucket||!upload.path||!upload.token)throw new CommentAttachmentError('invalid_upload');
    const client=createClient(SUPABASE_URL,String(import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY||''),{auth:{persistSession:false,autoRefreshToken:false,detectSessionInUrl:false},global:{headers:await headers(),fetch:(url,init)=>fetch(url,{...init,signal})}});
    const { error }=await client.storage.from(upload.bucket).uploadToSignedUrl(upload.path,upload.token,file,{contentType:file.type});
    abort(signal);
    if(error){
      // Storage may have accepted the immutable object while its response was lost.
      try{return await complete();}catch{throw new CommentAttachmentError('upload_failed');}
    }
    progress(95);
  }else{
    const size=upload.partSize||COMMENT_PART_BYTES,parts=resume.parts ??= [];
    for(let offset=0,number=1;offset<file.size;offset+=size,number++){
      abort(signal);if(parts.some(part=>part.partNumber===number))continue;
      const url=`${fnUrl('task-comments')}?action=upload_part&uploadId=${encodeURIComponent(upload.id)}&partNumber=${number}`;
      const response=await checked(await fetch(url,{method:'POST',signal,headers:{...await headers(),'Content-Type':'application/octet-stream'},body:file.slice(offset,offset+size)}));
      const result=await response.json();if(typeof result.etag!=='string')throw new CommentAttachmentError('invalid_upload');
      parts.push({partNumber:number,etag:result.etag});progress(Math.round(Math.min(file.size,offset+size)/file.size*95));
    }
  }
  return complete();
}
export const taskCommentClient = {
  async summary(taskIds:string[],signal?:AbortSignal):Promise<TaskAttachmentSummary>{
    const ids=[...new Set(taskIds)],batches:string[][]=[];let batch:string[]=[];
    for(const id of ids){const next=[...batch,id];if(batch.length&&(next.length>1000||JSON.stringify(next).length>48000)){batches.push(batch);batch=[];}batch.push(id);}if(batch.length||!ids.length)batches.push(batch);
    let result:TaskAttachmentSummary|undefined;
    for(const taskIds of batches){
      const page=await taskCommentRequest<TaskAttachmentSummary>('summary',{taskIds},signal);
      if(!page||typeof page.workspaceId!=='string'||typeof page.actorId!=='string'||!page.counts||!page.commentCounts||!Number.isSafeInteger(page.storageUsedBytes)||page.storageUsedBytes<0)throw new CommentAttachmentError('summary_unavailable',503);
      for(const values of [page.counts,page.commentCounts])for(const[id,count]of Object.entries(values))if(!taskIds.includes(id)||!Number.isSafeInteger(count)||count<0)throw new CommentAttachmentError('summary_unavailable',503);
      if(result&&(result.workspaceId!==page.workspaceId||result.actorId!==page.actorId))throw new CommentAttachmentError('summary_scope_changed',409);
      result={...page,counts:{...result?.counts,...page.counts},commentCounts:{...result?.commentCounts,...page.commentCounts}};
    }
    if(!result)throw new CommentAttachmentError('summary_unavailable',503);return result;
  },
  coverage:(signal?:AbortSignal)=>taskCommentRequest<TaskCommentCoverage>('coverage',{},signal),
  async list(taskId:string,signal?:AbortSignal):Promise<{attachments:CommentMedia[]}>{
    const attachments:CommentMedia[]=[];
    for(let offset=0;offset<=100000;offset+=100){const page=await taskCommentRequest<{attachments:CommentMedia[];hasMore?:boolean}>('list',{taskId,offset},signal);attachments.push(...page.attachments);if(!page.hasMore)return{attachments};}
    throw new CommentAttachmentError('attachment_list_incomplete');
  },
  publish: (input: {taskId:string;commandId:string;body:string;uploadIds:string[];mentionIds:string[]}, signal?:AbortSignal) => taskCommentRequest<TaskCommentReceipt>('publish',input,signal),
  readback: (commandId:string,signal?:AbortSignal) => taskCommentRequest<TaskCommentReceipt>('readback',{commandId},signal),
  async download(attachmentId:string,signal?:AbortSignal):Promise<Blob>{
    return (await checked(await fetch(fnUrl('task-comments'),{method:'POST',signal,headers:{...await headers(),'Content-Type':'application/json'},body:JSON.stringify({action:'download',attachmentId})}))).blob();
  },
};
