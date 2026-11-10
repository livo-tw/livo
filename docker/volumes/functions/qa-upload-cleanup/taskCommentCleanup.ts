/** Runs inside the existing service-only janitor; no new scheduler or credential. */
type Result={data:any;error:unknown};
type Client={rpc(name:string,input:Record<string,unknown>):PromiseLike<Result>;storage:{from(bucket:string):{remove(paths:string[]):PromiseLike<Result>}}};
export async function runTaskCommentUploadCleanup(client:Client,limit=4){
  if(!Number.isInteger(limit)||limit<1||limit>25)throw new Error('task_cleanup_limit');
  const token=crypto.randomUUID(),claim=await client.rpc('livo_task_comment_cleanup_claim',{p_token:token,p_limit:limit});
  if(claim.error||!Array.isArray(claim.data)||claim.data.length>limit)throw new Error('task_cleanup_claim_failed');
  const summary={claimed:claim.data.length,removed:0,retained:0,failed:0};
  for(const row of claim.data){
    try{
      if(row.workspace_id!=='default'||row.cleanup_token!==token||typeof row.task_id!=='string'||!/^\w[\w:-]{0,179}$/.test(row.task_id)||typeof row.id!=='string'||!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(row.id)||row.storage_key!==`default/${row.task_id}/${row.id}`)throw new Error('task_cleanup_identity');
      const identity={p_id:row.id,p_token:token},owned=await client.rpc('livo_task_comment_cleanup_owns',identity);
      if(owned.error)throw new Error('task_cleanup_owner_failed');
      if(owned.data!==true){summary.retained++;continue;}
      const deleted=await client.storage.from('task-comment-media').remove([row.storage_key]);
      if(deleted.error)throw new Error('task_cleanup_delete_failed');
      const ack=await client.rpc('livo_task_comment_cleanup_ack',identity);
      if(ack.error)throw new Error('task_cleanup_ack_failed');
      if(ack.data===true)summary.removed++;else summary.retained++;
    }catch{summary.failed++;summary.retained++;}
  }
  return summary;
}
