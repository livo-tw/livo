import type { Env, AuthCtx, Ctx } from '../env';
import { DEFAULT_WORKSPACE, isDemoMember } from '../env';
import { knowledgePermissionSql } from '../knowledgeSql';
import { createKnowledgeImport, defaultImportPolicy, ImportError, sha256, type ImportRepository, type ImportJob, type ImportPage, type ImportPolicy, type ImportStoredSource, type ImportConfig } from '../knowledgeImport';
import type { KnowledgeActor } from '../knowledgeAccess';
import { notifyChanges } from '../notify';
import { accountExistingKnowledgeImportObject, deleteKnowledgeImportObject, putKnowledgeImportObject } from '../knowledgeImportStorage';
import { hydrateKnowledgeImportJob, saveKnowledgeImportJob } from '../knowledgeImportJobStorage';

type ImportEnv = Env & { KNOWLEDGE_PROCESSOR_URL?: string; KNOWLEDGE_PROCESSOR_TOKEN?: string; KNOWLEDGE_IMPORT_SECRET?: string };
export async function handleKnowledgeImport(env: ImportEnv, ctx: Ctx, auth: AuthCtx, body: unknown): Promise<unknown> {
  const ws=auth.member.workspaceId||DEFAULT_WORKSPACE, actorId=auth.member.id;
  const action=body&&typeof body==='object'?(body as {action?:string}).action:undefined;
  if(isDemoMember(env,auth)){if(action==='capability')return {allowed:false,can_manage:false,notion_available:false,processor_configured:false};if(action!=='sources'&&action!=='download_source')throw new ImportError('demo_import_disabled',403);}
  const capSql=`EXISTS(SELECT 1 FROM members m LEFT JOIN knowledge_import_policy ip ON ip.workspace_id=m.workspace_id WHERE m.workspace_id=? AND m.id=? AND m.auth_id=? AND m.is_active=1 AND (
    (ip.workspace_id IS NULL AND m.role='super_admin') OR EXISTS(SELECT 1 FROM json_each(ip.data,'$.subjects.roles') WHERE value=m.role) OR EXISTS(SELECT 1 FROM json_each(ip.data,'$.subjects.positions') WHERE value=m.job_title) OR EXISTS(SELECT 1 FROM json_each(ip.data,'$.subjects.member_ids') WHERE value=m.id)))`;
  const fileKey=(key:string)=>`kb-imports/${ws}/${key}`;
  const pending:Promise<unknown>[]=[];
  const repo:ImportRepository={
    actor:()=>env.DB.prepare('SELECT id,role,job_title,is_active FROM members WHERE workspace_id=? AND id=? AND auth_id=?').bind(ws,actorId,auth.userId).first<KnowledgeActor>(),
    async pages(){const p=knowledgePermissionSql('kb_pages.id','view',auth);return(await env.DB.prepare(`SELECT * FROM kb_pages WHERE workspace_id=? AND ${p.sql}`).bind(ws,...p.params).all<ImportPage>()).results.map(row=>({...row,access_policy:typeof row.access_policy==='string'?JSON.parse(row.access_policy):row.access_policy}));},
    async policy(){const row=await env.DB.prepare('SELECT data FROM knowledge_import_policy WHERE workspace_id=?').bind(ws).first<{data:string}>();return row?JSON.parse(row.data) as ImportPolicy:defaultImportPolicy();},
    async savePolicy(policy,expected){const result=await env.DB.prepare(`INSERT INTO knowledge_import_policy(workspace_id,version,data,updated_by,updated_at) SELECT ?,?,?,?,? WHERE EXISTS(SELECT 1 FROM members WHERE workspace_id=? AND id=? AND auth_id=? AND role='super_admin' AND is_active=1) AND coalesce((SELECT version FROM knowledge_import_policy WHERE workspace_id=?),0)=? ON CONFLICT(workspace_id) DO UPDATE SET version=excluded.version,data=excluded.data,updated_by=excluded.updated_by,updated_at=excluded.updated_at RETURNING workspace_id`).bind(ws,policy.version,JSON.stringify(policy),actorId,new Date().toISOString(),ws,actorId,auth.userId,ws,expected).first();if(!result)throw new ImportError('policy_changed',409);},
    async getJob(id){const row=await env.DB.prepare(`SELECT data FROM knowledge_import_jobs WHERE workspace_id=? AND id=? AND actor_id=? AND ${capSql}`).bind(ws,id,actorId,ws,actorId,auth.userId).first<{data:string}>();return row?hydrateKnowledgeImportJob(env,ws,JSON.parse(row.data)):null;},
    async listJobs(){return(await env.DB.prepare(`SELECT data FROM knowledge_import_jobs WHERE workspace_id=? AND actor_id=? AND expires_at>? AND ${capSql} ORDER BY created_at DESC LIMIT 30`).bind(ws,actorId,new Date().toISOString(),ws,actorId,auth.userId).all<{data:string}>()).results.map(x=>JSON.parse(x.data));},
    async saveJob(job,expected){return saveKnowledgeImportJob(env,ws,actorId,job,expected,{sql:capSql,params:[ws,actorId,auth.userId]});},
    async putFile(key,data,type){await putKnowledgeImportObject(env,ws,fileKey(key),data,type);},
    async getFile(key){const object=await env.ATTACHMENTS.get(fileKey(key));if(!object)return null;const bytes=new Uint8Array(await object.arrayBuffer());await accountExistingKnowledgeImportObject(env,ws,fileKey(key),bytes.length);return bytes;},
    async deleteFile(key){await deleteKnowledgeImportObject(env,ws,fileKey(key));},
    async results(jobId){return(await env.DB.prepare('SELECT item_id,page_id,snapshot_id,original,assets FROM knowledge_import_sources WHERE workspace_id=? AND job_id=? AND created_by=?').bind(ws,jobId,actorId).all<{item_id:string;page_id:string;snapshot_id:string;original:string;assets:string}>()).results.map(row=>({item_id:row.item_id,page_id:row.page_id,snapshot_id:row.snapshot_id,file_keys:[JSON.parse(row.original).key,...JSON.parse(row.assets).map((a:{key:string})=>a.key)]}));},
    async expiredJobs(){return(await env.DB.prepare('SELECT data FROM knowledge_import_jobs WHERE workspace_id=? AND actor_id=? AND expires_at<=? LIMIT 30').bind(ws,actorId,new Date().toISOString()).all<{data:string}>()).results.map(r=>JSON.parse(r.data));},
    async deleteExpiredJob(jobId){await env.DB.prepare('DELETE FROM knowledge_import_jobs WHERE workspace_id=? AND actor_id=? AND id=? AND expires_at<=?').bind(ws,actorId,jobId,new Date().toISOString()).run();},
    async sources(pageId){const p=knowledgePermissionSql('s.page_id','view',auth);const rows=await env.DB.prepare(`SELECT s.*,ss.body FROM knowledge_import_sources s JOIN kb_source_snapshots ss ON ss.workspace_id=s.workspace_id AND ss.id=s.snapshot_id WHERE s.workspace_id=? AND s.page_id=? AND ${p.sql} ORDER BY s.version DESC`).bind(ws,pageId,...p.params).all<ImportStoredSource&{original:string;assets:string}>();return rows.results.map(r=>({...r,original:JSON.parse(r.original),assets:JSON.parse(r.assets)}));},
    async findSources(keys,parent,project){const acl=knowledgePermissionSql('p.id','view',auth);return(await env.DB.prepare(`SELECT s.* FROM knowledge_import_sources s JOIN kb_pages p ON p.workspace_id=s.workspace_id AND p.id=s.page_id WHERE s.workspace_id=? AND s.created_by=? AND s.source_key IN (SELECT value FROM json_each(?)) AND p.parent_id IS ? AND p.project_id IS ? AND ${acl.sql} ORDER BY s.version DESC LIMIT 30`).bind(ws,actorId,JSON.stringify(keys),parent,project,...acl.params).all<ImportStoredSource>()).results;},
    async commit(job,item,mapping,source){
      const existing=await env.DB.prepare('SELECT page_id,snapshot_id FROM knowledge_import_sources WHERE workspace_id=? AND job_id=? AND item_id=?').bind(ws,job.id,item.id).first<{page_id:string;snapshot_id:string}>();
      if(existing){const p=knowledgePermissionSql('kb_pages.id','view',auth);if(!await env.DB.prepare(`SELECT id FROM kb_pages WHERE workspace_id=? AND id=? AND ${p.sql}`).bind(ws,existing.page_id,...p.params).first())throw new ImportError('import_forbidden',403);return existing;}
      const d=mapping.destination,stamp=new Date().toISOString();const params:unknown[]=[ws,job.id,actorId,job.version,stamp,ws,job.policy_version,ws,actorId,auth.userId];
      let guard=`EXISTS(SELECT 1 FROM knowledge_import_jobs WHERE workspace_id=? AND id=? AND actor_id=? AND version=? AND expires_at>? AND json_extract(data,'$.status')='committing') AND coalesce((SELECT version FROM knowledge_import_policy WHERE workspace_id=?),0)=? AND ${capSql}`;
      if(job.source==='notion'){guard+=` AND EXISTS(SELECT 1 FROM members m JOIN knowledge_import_policy ip ON ip.workspace_id=m.workspace_id WHERE m.workspace_id=? AND m.id=? AND m.is_active=1 AND json_extract(ip.data,'$.notion_secret') IS NOT NULL AND EXISTS(SELECT 1 FROM json_each(ip.data,'$.notion_pages') WHERE value=?) AND (EXISTS(SELECT 1 FROM json_each(ip.data,'$.notion_subjects.roles') WHERE value=m.role) OR EXISTS(SELECT 1 FROM json_each(ip.data,'$.notion_subjects.positions') WHERE value=m.job_title) OR EXISTS(SELECT 1 FROM json_each(ip.data,'$.notion_subjects.member_ids') WHERE value=m.id)))`;params.push(ws,actorId,item.source_key.replace('notion:',''));}
      if(d.parent_id){const acl=knowledgePermissionSql('p.id','edit',auth);guard+=` AND EXISTS(SELECT 1 FROM kb_pages p WHERE p.workspace_id=? AND p.id=? AND p.project_id IS ? AND ${acl.sql})`;params.push(ws,d.parent_id,d.project_id,...acl.params);}
      if(d.mode==='update'){const acl=knowledgePermissionSql('p.id','edit',auth);guard+=` AND EXISTS(SELECT 1 FROM kb_pages p WHERE p.workspace_id=? AND p.id=? AND p.version=? AND ${acl.sql})`;params.push(ws,d.target_id,d.expected_version,...acl.params);}
      if(d.policy.mode==='custom'&&d.mode!=='update'){guard+=` AND EXISTS(SELECT 1 FROM members m WHERE m.workspace_id=? AND m.id=? AND m.is_active=1 AND m.role IN ('admin','super_admin') AND (EXISTS(SELECT 1 FROM json_each(?,'$.view.roles') WHERE value=m.role) OR EXISTS(SELECT 1 FROM json_each(?,'$.view.positions') WHERE value=m.job_title) OR EXISTS(SELECT 1 FROM json_each(?,'$.view.member_ids') WHERE value=m.id)))`;const p=JSON.stringify(d.policy);params.push(ws,actorId,p,p,p);}
      if(d.mode==='create'){const view=knowledgePermissionSql('p.id','view',auth);guard+=` AND NOT EXISTS(SELECT 1 FROM knowledge_import_sources s JOIN kb_pages p ON p.id=s.page_id AND p.workspace_id=s.workspace_id WHERE s.workspace_id=? AND s.created_by=? AND s.source_key=? AND p.parent_id IS ? AND p.project_id IS ? AND ${view.sql})`;params.push(ws,actorId,item.source_key,d.parent_id,d.project_id,...view.params);}
      const sourceFiles=[item.original.key,...item.assets.map(asset=>asset.key)].map(fileKey);
      for(const key of sourceFiles){if(!await env.DB.prepare('SELECT file_key FROM knowledge_import_files WHERE workspace_id=? AND file_key=?').bind(ws,key).first()){const object=await env.ATTACHMENTS.head(key);if(!object)throw new ImportError('source_missing');await accountExistingKnowledgeImportObject(env,ws,key,object.size);}}
      guard+=` AND NOT EXISTS(SELECT 1 FROM json_each(?) source_file WHERE NOT EXISTS(SELECT 1 FROM knowledge_import_files f WHERE f.workspace_id=? AND f.file_key=source_file.value AND f.state='stored'))`;
      params.push(JSON.stringify(sourceFiles),ws);
      const body=item.parsed!.body,bodyBytes=new TextEncoder().encode(body);
      const provenance=JSON.stringify({pages:item.parsed!.pages.map(({page,state,confidence})=>({page,state,confidence})),warnings:item.parsed!.warnings,parser_version:item.parsed!.parser_version,incomplete:item.parsed!.incomplete,historical:true});
      // D1 limits strings AND the complete row to 2 MB. Revalidate legacy previews
      // too, leaving room for IDs and metadata before starting any transaction.
      if(bodyBytes.length>900000||bodyBytes.length+new TextEncoder().encode(provenance).length>1900000)throw new ImportError('parsed_document_too_large',413);
      const hash=await sha256(bodyBytes);const statements:D1PreparedStatement[]=[];
      if(d.mode!=='update')statements.push(env.DB.prepare(`INSERT INTO kb_pages(id,workspace_id,title,body,project_id,parent_id,category,access_policy,created_by,updated_by,created_at,updated_at) SELECT ?,?,?,?,?,?,?,?,?,?,?,? WHERE ${guard}`).bind(source.page_id,ws,item.title,body,d.project_id,d.parent_id,d.category,JSON.stringify(d.policy),actorId,actorId,stamp,stamp,...params));
      const sourceVersion=`coalesce((SELECT max(version) FROM knowledge_import_sources WHERE workspace_id=? AND page_id=? AND source_key=?),0)+1`;
      statements.push(env.DB.prepare(`INSERT INTO kb_source_snapshots(id,workspace_id,page_id,source_kind,source_title,source_url,source_key,source_version,body,body_hash,page_version,provenance,created_by,created_at) SELECT ?,?,?,?,?,?,?,${sourceVersion},?,?,p.version,?,?,? FROM kb_pages p WHERE p.workspace_id=? AND p.id=? AND ${guard} ON CONFLICT DO NOTHING`).bind(source.snapshot_id,ws,source.page_id,job.source,item.title,item.source_url||null,item.source_key,ws,source.page_id,item.source_key,body,hash,provenance,actorId,stamp,ws,source.page_id,...params));
      statements.push(env.DB.prepare(`INSERT INTO knowledge_import_sources(id,workspace_id,page_id,snapshot_id,job_id,item_id,source_key,source_hash,version,original,assets,created_by,created_at) SELECT ?,?,?,ss.id,?,?,?,?,${sourceVersion},?,?,?,? FROM kb_source_snapshots ss WHERE ss.workspace_id=? AND ss.page_id=? AND ss.body_hash=? AND ss.source_kind=? AND ss.source_key=? AND ${guard} LIMIT 1`).bind(source.id,ws,source.page_id,job.id,item.id,item.source_key,item.source_hash,ws,source.page_id,item.source_key,JSON.stringify(item.original),JSON.stringify(item.assets),actorId,stamp,ws,source.page_id,hash,job.source,item.source_key,...params));
      await env.DB.batch(statements);
      const result=await env.DB.prepare('SELECT page_id,snapshot_id FROM knowledge_import_sources WHERE workspace_id=? AND job_id=? AND item_id=?').bind(ws,job.id,item.id).first<{page_id:string;snapshot_id:string}>();if(!result)throw new ImportError('destination_changed',409);
      notifyChanges(env,ctx,[{table:'kb_pages',eventType:'UPDATE',new:{},old:null}],ws);return result;
    },
    background(promise){pending.push(promise);},
  };
  const config:ImportConfig={processorUrl:env.KNOWLEDGE_PROCESSOR_URL,processorToken:env.KNOWLEDGE_PROCESSOR_TOKEN,encryptionSecret:env.KNOWLEDGE_IMPORT_SECRET};
  const handle=createKnowledgeImport(repo,config);
  const result=await handle(body);
  // Native parsing can exceed Workers' 30-second post-response waitUntil lifetime.
  // Keep this request alive; persisted jobs can be resumed from history after a disconnect.
  await Promise.all(pending);
  if((action==='start'||action==='retry')&&result&&typeof result==='object'&&'id' in result)return handle({action:'get',job_id:result.id});
  return result;
}
