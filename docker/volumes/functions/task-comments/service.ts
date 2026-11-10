import { commentNeed as need, CommentAttachmentError, commentId, commentUUID, commentFileError, commentSignature, commentPublishInput } from './core.ts';
type Row=Record<string,any>;
type Environment={get(name:string):string|undefined};
const wire=(row:Row)=>({id:row.id,taskId:row.task_id,commentId:row.comment_id||undefined,fileName:row.file_name,mimeType:row.mime_type,size:Number(row.expected_size)});
const digest=async(text:string)=>[...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(text)))].map(x=>x.toString(16).padStart(2,'0')).join('');
export function createTaskCommentService(env:Environment,token:string){
  const base=env.get('SUPABASE_URL')||'',anon=env.get('SUPABASE_ANON_KEY')||'',service=env.get('SUPABASE_SERVICE_ROLE_KEY')||'';
  async function request(path:string,body?:unknown,privileged=false,method=body===undefined?'GET':'POST',extra:Record<string,string>={}){
    const response=await fetch(base+path,{method,headers:{apikey:privileged?service:anon,Authorization:`Bearer ${privileged?service:token}`,'Content-Type':'application/json',...extra},body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(20000)});
    if(!response.ok){const error=await response.json().catch(()=>({}));throw new CommentAttachmentError(error.message||error.code||'task_comment_failed',response.status);}
    return response;
  }
  async function rpc(name:string,body:Row,privileged=false){return(await request('/rest/v1/rpc/'+name,body,privileged)).json();}
  async function rows(table:string,query:Row,privileged=false){return(await request('/rest/v1/'+table+'?'+new URLSearchParams(query).toString(),undefined,privileged)).json();}
  async function authenticate(){
    need(token&&token!==service&&token!==anon,'unauthorized',401);
    const user=await(await request('/auth/v1/user')).json();
    const found=await rows('members',{select:'id,auth_id,is_active,role',auth_id:'eq.'+user.id,limit:'2'},true);
    need(found.length===1&&found[0].is_active===true,'forbidden',403);return found[0];
  }
  async function task(id:string){const found=await rows('tasks',{select:'id',id:'eq.'+id,limit:'1'});need(found.length===1,'task_unavailable',404);}
  async function session(id:string,actor:string){
    const found=await rows('task_comment_uploads',{workspace_id:'eq.default',id:'eq.'+id,actor_id:'eq.'+actor,limit:'1'},true);
    need(found.length===1,'upload_unavailable',404);await task(found[0].task_id);return found[0];
  }
  async function summary(ids:string[],actor:Row){
    const readable:string[]=[];
    // Bound both IDs and URL bytes; the caller's JWT, never the service key, reads task RLS.
    const chunks:string[][]=[];let chunk:string[]=[];
    for(const id of ids){const next=[...chunk,id];if(chunk.length&&(next.length>100||new URLSearchParams({id:'in.('+next.join(',')+')'}).toString().length>5000)){chunks.push(chunk);chunk=[];}chunk.push(id);}if(chunk.length)chunks.push(chunk);
    for(const group of chunks){
      let offset=0;
      for(;;){
        const query=new URLSearchParams({select:'id',id:'in.('+group.join(',')+')',order:'id'});
        const response=await request('/rest/v1/tasks?'+query,undefined,false,'GET',{Prefer:'count=exact',Range:`${offset}-${offset+99}`});
        const rows=await response.json(),total=Number(response.headers.get('content-range')?.split('/')[1]);
        need(Array.isArray(rows),'summary_unavailable',503);for(const row of rows)readable.push(commentId(row.id));
        if(!rows.length||(Number.isFinite(total)&&offset+rows.length>=total)||rows.length>=group.length)break;
        offset+=rows.length;need(offset<=group.length,'summary_unavailable',503);
      }
    }
    return rpc('livo_task_comment_attachment_summary',{p_actor:actor.id,p_auth:actor.auth_id,p_tasks:[...new Set(readable)]},true);
  }
  async function cleanup(){
    const marker=crypto.randomUUID(),pending=await rpc('livo_task_comment_cleanup_claim',{p_token:marker},true);
    for(const row of pending){try{
      await request('/storage/v1/object/task-comment-media',{prefixes:[row.storage_key]},true,'DELETE');
      await rpc('livo_task_comment_cleanup_ack',{p_id:row.id,p_token:marker},true);
    }catch{/* The exact unreferenced handle remains available for a later TTL cleanup. */}}
  }
  return {async handle(body:Row):Promise<unknown>{
    const actor=await authenticate(),action=body.action;
    if(action==='summary'){
      need(Array.isArray(body.taskIds)&&body.taskIds.length<=1000,'invalid_task_summary');return summary([...new Set((body.taskIds as unknown[]).map(commentId))],actor);
    }
    if(action==='coverage'){
      need(actor.role==='super_admin','forbidden',403);
      // PostgREST count is exact even when the response row cap is smaller.
      const response=await request('/rest/v1/task_comment_uploads?select=id&workspace_id=eq.default&state=neq.aborted',undefined,true,'GET',{Prefer:'count=exact',Range:'0-0'});
      const total=response.headers.get('content-range')?.split('/')[1];need(total!==undefined&&/^\d+$/.test(total),'coverage_unknown',503);
      return {kind:'task_comment_private_media',coveredByJsonBackup:false,requiresDatabaseAndPrivateStorageBackup:true,retainedMetadata:Number(total),commandReceiptsExcluded:true};
    }
    if(action==='upload_init'){
      const id=commentUUID(body.uploadId),taskId=commentId(body.taskId),error=commentFileError({name:body.fileName,type:body.mimeType,size:body.size});need(!error,error||'invalid_file');
      await task(taskId);await cleanup();
      const row=await rpc('livo_task_comment_upload_init',{p_task:taskId,p_id:id,p_name:body.fileName,p_mime:body.mimeType,p_size:body.size});
      const signed=await(await request('/storage/v1/object/upload/sign/task-comment-media/'+row.storage_key,{},true)).json();
      const signedToken=signed.token||new URL(signed.url||signed.signedURL,base).searchParams.get('token');need(signedToken,'storage_sign_failed',500);
      return {id,provider:'supabase',bucket:'task-comment-media',path:row.storage_key,token:signedToken};
    }
    if(action==='upload_complete'){
      const row=await session(commentUUID(body.uploadId),actor.id);
      if(!['complete','bound'].includes(row.state)){
        need(row.state==='uploading'&&Date.parse(row.expires_at)>Date.now(),'upload_expired',410);
        // Read only the bounded prefix before the service-only complete RPC. Generic JWTs cannot skip this check.
        let response:Response;
        try{response=await request('/storage/v1/object/task-comment-media/'+row.storage_key,undefined,true,'GET',{Range:'bytes=0-8191'});}
        catch(error){if((error as CommentAttachmentError).status===404)throw new CommentAttachmentError('upload_incomplete',409);throw error;}
        const reader=response.body?.getReader();need(reader,'upload_incomplete',409);let length=0;const chunks:Uint8Array[]=[];
        try{while(length<8192){const r=await reader.read();if(r.done)break;const part=r.value.slice(0,8192-length);chunks.push(part);length+=part.length;}}finally{await reader.cancel();}
        const prefix=new Uint8Array(length);let offset=0;for(const part of chunks){prefix.set(part,offset);offset+=part.length;}commentSignature(row.mime_type,prefix);
      }
      return wire(await rpc('livo_task_comment_upload_complete',{p_id:row.id,p_actor:actor.id},true));
    }
    if(action==='publish'){
      const input=commentPublishInput(body);await task(input.taskId);
      const result=await rpc('livo_task_comment_publish',{p_task:input.taskId,p_id:input.commandId,p_body:input.body,p_uploads:input.uploadIds,p_mentions:input.mentionIds,p_hash:await digest(JSON.stringify(input))});
      const current=await summary([input.taskId],actor);return{...result,commentCount:current.commentCounts[input.taskId],attachmentCount:current.counts[input.taskId]};
    }
    if(action==='readback'){
      const found=await rows('task_comment_commands',{workspace_id:'eq.default',id:'eq.'+commentUUID(body.commandId),actor_id:'eq.'+actor.id,limit:'1'},true);need(found.length===1,'command_not_found',404);await task(found[0].task_id);
      const comments=await rows('comments',{select:'id',id:'eq.'+body.commandId,limit:'1'});need(comments.length===1,'comment_unavailable',404);const current=await summary([found[0].task_id],actor);return{...found[0].result,commentCount:current.commentCounts[found[0].task_id],attachmentCount:current.counts[found[0].task_id]};
    }
    if(action==='list'){
      const id=commentId(body.taskId),offset=Number(body.offset||0);need(Number.isSafeInteger(offset)&&offset>=0&&offset<=100000,'invalid_offset');await task(id);
      const found=await rows('task_comment_uploads',{workspace_id:'eq.default',task_id:'eq.'+id,state:'eq.bound',comment_id:'not.is.null',order:'created_at,id',limit:'101',offset:String(offset)},true);
      return {attachments:found.slice(0,100).map(wire),hasMore:found.length>100};
    }
    if(action==='download'){
      const found=await rows('task_comment_uploads',{workspace_id:'eq.default',id:'eq.'+commentUUID(body.attachmentId),state:'in.(complete,bound)',limit:'1'},true),row=found[0];need(row&&(row.comment_id||row.actor_id===actor.id),'attachment_unavailable',404);await task(row.task_id);
      const response=await request('/storage/v1/object/task-comment-media/'+row.storage_key,undefined,true);
      return new Response(response.body,{headers:{'Content-Type':row.mime_type,'Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff','Content-Disposition':`attachment; filename*=UTF-8''${encodeURIComponent(row.file_name)}`,'Content-Security-Policy':"sandbox; default-src 'none'"}});
    }
    throw new CommentAttachmentError('invalid_action');
  }};
}
