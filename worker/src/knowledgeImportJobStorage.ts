import type { Env } from './env';
import { ImportError, sha256, type ImportItem, type ImportJob } from './knowledgeImport';
import { deleteKnowledgeImportObject, putKnowledgeImportObject } from './knowledgeImportStorage';

type JobEnv=Pick<Env,'DB'|'ATTACHMENTS'>;
type StoredItem=Omit<ImportItem,'parsed'>&{parsed?:ImportItem['parsed'];_parsed_key?:string};
type StoredJob=Omit<ImportJob,'items'>&{items:StoredItem[]};
type Guard={sql:string;params:unknown[]};
const encode=(value:unknown)=>new TextEncoder().encode(JSON.stringify(value));
const keys=(job:StoredJob|null)=>job?.items.flatMap(item=>item._parsed_key?[item._parsed_key]:[])||[];
const fullKey=(workspace:string,key:string)=>`kb-imports/${workspace}/${key}`;
const MAX_METADATA_BYTES=256*1024;

/** Legacy inline jobs remain readable. Only an ACL-authorized adapter may call this. */
export async function hydrateKnowledgeImportJob(env:JobEnv,workspace:string,stored:StoredJob):Promise<ImportJob>{
  const items:ImportItem[]=[];
  for(const item of stored.items){
    const {_parsed_key,...plain}=item;
    if(_parsed_key){
      if(!_parsed_key.startsWith(`${stored.actor_id}/${stored.id}/payload/${item.id}/`))throw new ImportError('import_payload_missing',503);
      const object=await env.ATTACHMENTS.get(fullKey(workspace,_parsed_key));
      if(!object)throw new ImportError('import_payload_missing',503);
      const bytes=new Uint8Array(await object.arrayBuffer());
      if(!_parsed_key.endsWith(`/${await sha256(bytes)}.json`))throw new ImportError('import_payload_missing',503);
      plain.parsed=JSON.parse(new TextDecoder().decode(bytes));
    }
    items.push(plain);
  }
  return {...stored,items};
}

/** Keep only bounded workflow metadata in D1; each parsed result is immutable R2. */
export async function saveKnowledgeImportJob(env:JobEnv,workspace:string,actor:string,job:ImportJob,expected:number|null,guard:Guard):Promise<boolean>{
  const previousRow=await env.DB.prepare('SELECT data FROM knowledge_import_jobs WHERE workspace_id=? AND id=? AND actor_id=?').bind(workspace,job.id,actor).first<{data:string}>();
  const previous=previousRow?JSON.parse(previousRow.data) as StoredJob:null;
  const written:string[]=[];
  let stored:StoredJob={...job,items:[]};
  let failure:unknown;
  try{
    for(const item of job.items){
      const {parsed,...plain}=item;
      const metadata:StoredItem={...plain};
      if(parsed&&job.status!=='cancelled'){
        const bytes=encode(parsed),key=`${actor}/${job.id}/payload/${item.id}/${await sha256(bytes)}.json`;
        if(previous?.items.find(old=>old.id===item.id)?._parsed_key!==key){
          await putKnowledgeImportObject(env,workspace,fullKey(workspace,key),bytes,'application/json');
          written.push(key);
        }
        metadata._parsed_key=key;
      }
      stored.items.push(metadata);
    }
    if(encode(stored).length>MAX_METADATA_BYTES)throw new ImportError('import_metadata_too_large',413);
  }catch(error){
    failure=error;
    // A failed R2 persistence must not strand the already-durable job in parsing.
    // Preserve original/asset references so retry and cleanup remain possible.
    job.status='failed';
    job.items=job.items.map(item=>{if(item.status==='committed')return item;const {parsed:_,...rest}=item;return {...rest,status:'failed',error:error instanceof ImportError?error.code:'processing_failed'};});
    stored={...job,items:job.items.map(({parsed:_,...item})=>{
      const persisted=previous?.items.find(old=>old.id===item.id);
      // A partial import may already own committed sources. Preserve its parsed
      // payload so retrying other items does not invalidate committed mappings.
      return item.status==='committed'&&persisted?{...persisted,...item}:item;
    })};
  }
  const data=JSON.stringify(stored);
  if(new TextEncoder().encode(data).length>MAX_METADATA_BYTES)throw new ImportError('import_metadata_too_large',413);
  // Metadata cannot publish a pointer while cleanup owns/deletes that object.
  const pointerGuard="NOT EXISTS(SELECT 1 FROM json_each(?,'$.items') item WHERE json_extract(item.value,'$._parsed_key') IS NOT NULL AND NOT EXISTS(SELECT 1 FROM knowledge_import_files f WHERE f.workspace_id=? AND f.file_key='kb-imports/'||?||'/'||json_extract(item.value,'$._parsed_key') AND f.state='stored'))";
  let success=false;
  try{
    const statement=expected===null
      ?env.DB.prepare(`INSERT INTO knowledge_import_jobs(id,workspace_id,actor_id,version,data,expires_at,created_at) SELECT ?,?,?,?,?,?,? WHERE ${guard.sql} AND ${pointerGuard} ON CONFLICT DO NOTHING RETURNING id`).bind(job.id,workspace,actor,job.version,data,job.expires_at,job.created_at,...guard.params,data,workspace,workspace)
      :env.DB.prepare(`UPDATE knowledge_import_jobs SET data=?,version=? WHERE workspace_id=? AND id=? AND actor_id=? AND version=? AND expires_at>? AND ${guard.sql} AND ${pointerGuard} RETURNING id`).bind(data,job.version,workspace,job.id,actor,expected,new Date().toISOString(),...guard.params,data,workspace,workspace);
    success=!!await statement.first();
  }finally{
    const obsolete=success?keys(previous).filter(key=>!keys(stored).includes(key)):written;
    for(const key of new Set([...obsolete,...(failure?written:[])]))await deleteKnowledgeImportObject(env,workspace,fullKey(workspace,key)).catch(()=>undefined);
  }
  if(failure&&!success)throw failure;
  return success;
}
