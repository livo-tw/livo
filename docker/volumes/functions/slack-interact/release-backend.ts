import type {Row} from './core.ts';
import type {MemberDatabase} from './workspace-backend.ts';
import {parseDeploymentEnvironments} from '../qa/environments.ts';
import {parseReleaseRequest,validReleaseResponse,ReleaseError,RELEASE_ERROR_STATUS,type ReleaseRequest} from './release-core.ts';
export interface ReleaseData { request(actor:Row,input:ReleaseRequest):Promise<any>; environments(actor:Row):Promise<string[]>; tasks(actor:Row,projectId:string,query:string):Promise<Row[]>; qaOptions(actor:Row,kind:string,query:string,context:Row):Promise<Row[]>; }
export function createReleaseData(env:{get(name:string):string|undefined},factory:(actor:Row)=>MemberDatabase,fetcher:typeof fetch=fetch):ReleaseData {
 return {
  async request(actor,input){if(!actor.jwt)throw new ReleaseError('release_forbidden',403);const body=JSON.stringify(parseReleaseRequest(input));
   for(let attempt=0;attempt<2;attempt++)try{
    const response=await fetcher(`${env.get('SUPABASE_URL')?.replace(/\/$/,'')}/functions/v1/release-workspace`,{method:'POST',headers:{apikey:env.get('SUPABASE_ANON_KEY')||'',Authorization:`Bearer ${actor.jwt}`,'Content-Type':'application/json'},body,signal:AbortSignal.timeout(22000)});
    const data=await response.json().catch(():null=>null);if(!response.ok||data?.error){const code=typeof data?.error==='string'&&Object.prototype.hasOwnProperty.call(RELEASE_ERROR_STATUS,data.error)?data.error:'release_unavailable';if(RELEASE_ERROR_STATUS[code]<500)throw new ReleaseError(code,RELEASE_ERROR_STATUS[code]);throw new Error('transport');}
    if(!validReleaseResponse(input,data))throw new Error('invalid_response');return data;
   }catch(error){if(error instanceof ReleaseError)throw error;if(attempt===1)throw new ReleaseError('release_transport_error',503);}
  },
  async environments(actor){if(!actor.jwt)throw new ReleaseError('release_forbidden',403);const rows=await factory(actor).rows('system_settings',{select:'value',key:'eq.deployment_environments',limit:'1'}),settings=parseDeploymentEnvironments(rows[0]?.value);if(!settings)throw new ReleaseError('release_invalid_environment');return settings.values;},
  async tasks(actor,projectId,query){if(!actor.jwt||!/^[\w-]{1,128}$/.test(projectId))throw new ReleaseError('release_forbidden',403);
   const q=query.replace(/[^\p{L}\p{N} _-]/gu,'').slice(0,80);return (await factory(actor).rows('tasks',{select:'id,task_key,title',project_id:`eq.${projectId}`,or:`(task_key.ilike.*${q}*,title.ilike.*${q}*)`,order:'task_key,id',limit:'30'})).map(row=>({text:{type:'plain_text',text:`${row.task_key} · ${row.title}`.slice(0,75)},value:row.id}));},
  async qaOptions(actor,kind,query,c){if(!actor.jwt||!/^[\w-]{1,128}$/.test(c.projectId||''))throw new ReleaseError('release_forbidden',403);
   const option=(value:string,label:string)=>({text:{type:'plain_text',text:label.slice(0,75)||value},value});
   const db=factory(actor),q=query.replace(/[^\p{L}\p{N} _-]/gu,'').slice(0,80);
   if(kind==='issue')return (await db.rows('qa_issues',{select:'data',project_id:`eq.${c.projectId}`,...(q?{'data->>title':`ilike.*${q}*`}:{}),order:'updated_at.desc,id',limit:'30'})).map(r=>option(JSON.stringify({id:r.data.id,version:r.data.version}),`${r.data.id} · ${r.data.title} · v${r.data.version}`));
   if(!/^[\w-]{1,128}$/.test(c.issue?.id||''))return [];
   const issue=(await db.rows('qa_issues',{select:'data',id:`eq.${c.issue.id}`,project_id:`eq.${c.projectId}`,limit:'1'}))[0]?.data;
   if(!issue||issue.version!==c.issue.version)return [];
   const targets=(issue.targets||[]).filter((t:Row)=>t.environment===c.environment&&t.component===c.component&&t.build===c.build);
   if(kind==='target')return targets.map((t:Row)=>option(t.id,`${t.environment} · ${t.component} · ${t.build}`));
   const target=targets.find((t:Row)=>t.id===c.targetId);if(!target)return [];
   return (issue.runs||[]).filter((r:Row)=>r.targetId===target.id&&r.fixCycle===issue.fixCycle&&r.build===target.build).slice(-30).reverse().map((r:Row)=>option(r.id,`${r.result} · ${r.build} · ${r.createdAt||r.id}`));
  },
 };
}
