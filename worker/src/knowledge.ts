/** Knowledge writes check their ACL inside the mutation statement. */
import type { AuthCtx, Ctx, Env } from './env';
import { DEFAULT_WORKSPACE } from './env';
import type { QueryRequest, QueryResponse } from './protocol';
import { rowToWire } from './meta';
import { TABLES } from './tables';
import { notifyChanges } from './notify';
import { knowledgeIsAdmin, parseKnowledgePolicy, knowledgeRuleMatches } from './knowledgeAccess';
import { knowledgePermissionSql } from './knowledgeSql';
import { liveMember, liveMemberSql } from './liveMember';

const pageColumns = new Set(['title','body','parent_id','project_id','sort_order','admin_only','is_archived','category','access_policy']);
const fail = (message: string): QueryResponse => ({ data: null, error: { message, code: '42501' } });
export const knowledgeAdmin = knowledgeIsAdmin;
const literal = (s: string) => `'${s.replace(/'/g, "''")}'`;

export async function knowledgeLockAllowed(env: Env, auth: AuthCtx, lockKey: string): Promise<boolean> {
  if (!lockKey.startsWith('kb:')) return true;
  const edit = knowledgePermissionSql('kb_pages.id','edit',auth);
  const view = knowledgePermissionSql('kb_pages.id','view',auth);
  const ws=auth.member.workspaceId || DEFAULT_WORKSPACE;
  return !!await env.DB.prepare(`SELECT id FROM kb_pages WHERE workspace_id=? AND id=? AND (${edit.sql} OR (EXISTS (SELECT 1 FROM members WHERE workspace_id=? AND id=? AND is_active=1 AND role IN ('admin','super_admin')) AND ${view.sql}))`)
    .bind(ws,lockKey.slice(3),...edit.params,ws,auth.member.id,...view.params).first();
}

export async function writeKnowledge(env: Env, ctx: Ctx, auth: AuthCtx, req: QueryRequest): Promise<QueryResponse> {
  const ws=auth.member.workspaceId || DEFAULT_WORKSPACE, member=auth.member.id;
  const liveActor=await liveMember(env,auth);
  if (!liveActor?.is_active) return fail('kb_forbidden');
  const admin=knowledgeAdmin(liveActor.role);
  const adminSql="EXISTS (SELECT 1 FROM members WHERE workspace_id=? AND id=? AND is_active=1 AND role IN ('admin','super_admin'))";
  if (!member || req.op==='upsert' || req.table==='kb_revisions') return fail('kb_forbidden');
  // The web client (cfClient) always sends inserts as an array; knowledge writes are one
  // row at a time, so unwrap a single row and refuse a batch.
  if (Array.isArray(req.values) && req.values.length!==1) return fail('kb_invalid_request');
  const row=Array.isArray(req.values) ? req.values[0] : req.values;
  const values=row && typeof row==='object' && !Array.isArray(row) ? row as Record<string,unknown> : {};
  // A new page may carry its client-generated id: the Docker backend cannot return the
  // inserted row through RLS (the view check looks the page up by id), so the web app
  // names the page itself and reads it back. Ids are globally unique keys; a clash fails.
  const clientId=req.op==='insert' && req.table==='kb_pages' && typeof values.id==='string' && /^[A-Za-z0-9-]{8,64}$/.test(values.id) ? values.id : null;
  const id=req.op==='insert' ? clientId ?? crypto.randomUUID() : req.filters?.find(f=>f.col==='id' && f.op==='eq')?.val;
  if (typeof id!=='string' || req.filters?.some(f=>f.op!=='eq' || !['id','version','created_by'].includes(f.col))) return fail('kb_invalid_request');
  const stamp=new Date().toISOString();
  const edit=knowledgePermissionSql('kb_pages.id','edit',auth), view=knowledgePermissionSql('kb_pages.id','view',auth);
  const lock=`NOT EXISTS (SELECT 1 FROM field_locks WHERE workspace_id=? AND lock_key='kb:'||kb_pages.id AND locked_by!=? AND expires_at>?)`;
  const lockParams=[ws,member,stamp];
  const editable=`${edit.sql} AND ${lock}`;
  const editableParams=[...edit.params,...lockParams];
  let statement:D1PreparedStatement;
  if (req.table==='kb_pages') {
    if (Object.keys(values).some(k=>!new Set([...pageColumns,'created_by','updated_by',...(clientId?['id']:[])]).has(k))) return fail('kb_forbidden');
    if (!admin && (values.admin_only!==undefined || values.is_archived!==undefined || (values.access_policy!==undefined && parseKnowledgePolicy(values.access_policy)?.mode!=='inherit'))) return fail('kb_forbidden');
    if (values.title!==undefined && (typeof values.title!=='string' || !values.title.trim() || values.title.length>200)) return fail('kb_invalid_title');
    if (values.body!==undefined && (typeof values.body!=='string' || values.body.length>1000000)) return fail('kb_invalid_body');
    for (const key of ['admin_only','is_archived']) if (values[key]!==undefined && typeof values[key]!=='boolean') return fail('kb_invalid_request');
    if (values.sort_order!==undefined && !Number.isSafeInteger(values.sort_order)) return fail('kb_invalid_request');
    if (values.category!==undefined && !['general','meeting'].includes(String(values.category))) return fail('kb_invalid_category');
    for (const key of ['parent_id','project_id']) if (values[key]!==undefined && values[key]!==null && typeof values[key]!=='string') return fail('kb_invalid_request');
    const policy=values.access_policy===undefined ? {mode:'inherit' as const} : parseKnowledgePolicy(values.access_policy);
    if (!policy) return fail('kb_invalid_policy');
    if (values.access_policy!==undefined && policy.mode==='custom') {
      if (!knowledgeRuleMatches(policy.view,liveActor)) return fail('kb_self_lockout');
    }
    const encoded=(key:string) => key==='access_policy' ? JSON.stringify(policy) : typeof values[key]==='boolean' ? Number(values[key]) : values[key];
    if (req.op==='insert') {
      if (typeof values.title!=='string') return fail('kb_invalid_title');
      const parent=typeof values.parent_id==='string' ? knowledgePermissionSql(literal(values.parent_id),'edit',auth) : null;
      const needsAdmin=policy.mode==='custom' || values.admin_only!==undefined || values.is_archived!==undefined;
      statement=env.DB.prepare(`INSERT INTO kb_pages(id,workspace_id,title,body,project_id,parent_id,sort_order,admin_only,is_archived,category,access_policy,created_by,updated_by,created_at,updated_at)
        SELECT ?,?,?,?,?,?,?,?,?,?,?,?,?,?,? WHERE EXISTS (SELECT 1 FROM members m WHERE ${liveMemberSql(auth,'m').sql})
        ${parent ? `AND ${parent.sql}` : ''} ${needsAdmin ? `AND ${adminSql}` : ''} RETURNING *`)
        .bind(id,ws,values.title.trim(),values.body??'',values.project_id??null,values.parent_id??null,values.sort_order??0,values.admin_only?1:0,values.is_archived?1:0,values.category??'general',JSON.stringify(policy),member,member,stamp,stamp,...liveMemberSql(auth,'m').params,...(parent?.params??[]),...(needsAdmin?[ws,member]:[]));
    } else if (req.op==='update') {
      const version=req.filters?.find(f=>f.col==='version')?.val;
      if (!Number.isSafeInteger(version)) return fail('kb_conflict');
      const cols=Object.keys(values).filter(k=>pageColumns.has(k));
      if (!cols.length) return fail('kb_invalid_request');
      // Reparenting changes inherited rights; an editor may not escape a private parent.
      if (!admin && (cols.includes('access_policy') || cols.includes('parent_id'))) return fail('kb_forbidden');
      const managementOnly=admin && cols.every(k=>k==='access_policy' || (k==='is_archived' && values[k]===false));
      const permission=managementOnly ? view : edit;
      const needsAdmin=cols.some(k=>['access_policy','parent_id','admin_only','is_archived'].includes(k));
      const parent=typeof values.parent_id==='string' ? knowledgePermissionSql(literal(values.parent_id),'edit',auth) : null;
      let legacyGuard='';
      if (cols.includes('access_policy') || cols.includes('parent_id')) {
        // Public objects cannot become private by merely hiding their metadata.
        const legacy=await env.DB.prepare(`WITH RECURSIVE children(id,d) AS (SELECT id,1 FROM kb_pages WHERE workspace_id=? AND id=? UNION ALL SELECT p.id,c.d+1 FROM kb_pages p JOIN children c ON p.parent_id=c.id WHERE p.workspace_id=? AND c.d<3)
          SELECT 1 FROM kb_attachments WHERE workspace_id=? AND page_id IN (SELECT id FROM children) AND storage_bucket!='kb-files' LIMIT 1`).bind(ws,id,ws,ws).first();
        if (legacy) return fail('kb_legacy_public_attachments');
        legacyGuard=`AND NOT EXISTS (WITH RECURSIVE children(id,d) AS (SELECT kb_pages.id,1 UNION ALL SELECT p.id,c.d+1 FROM kb_pages p JOIN children c ON p.parent_id=c.id WHERE p.workspace_id=kb_pages.workspace_id AND c.d<3)
          SELECT 1 FROM kb_attachments WHERE workspace_id=kb_pages.workspace_id AND page_id IN (SELECT id FROM children) AND storage_bucket!='kb-files')`;
      }
      statement=env.DB.prepare(`UPDATE kb_pages SET ${cols.map(k=>`${k}=?`).join(',')},updated_by=?,updated_at=?,version=version+1
        WHERE workspace_id=? AND id=? AND version=? AND ${permission.sql} AND ${lock}
        AND EXISTS (SELECT 1 FROM field_locks WHERE workspace_id=? AND lock_key='kb:'||kb_pages.id AND locked_by=? AND expires_at>?)
        ${parent ? `AND ${parent.sql}` : ''} ${legacyGuard} ${needsAdmin ? `AND ${adminSql}` : ''} RETURNING *`)
        .bind(...cols.map(encoded),member,stamp,ws,id,version,...permission.params,...lockParams,ws,member,stamp,...(parent?.params??[]),...(needsAdmin?[ws,member]:[]));
    } else if (req.op==='delete') {
      statement=env.DB.prepare(`DELETE FROM kb_pages WHERE workspace_id=? AND id=? AND (${adminSql} OR created_by=?) AND ${editable} RETURNING *`)
        .bind(ws,id,ws,member,member,...editableParams);
    } else return fail('kb_invalid_request');
  } else if (req.table==='kb_attachments') {
    if (req.op==='insert') {
      const pageId=String(values.page_id??''), path=String(values.storage_path??'');
      const prefix=`${ws===DEFAULT_WORKSPACE?'':`ws/${ws}/`}kb/${pageId}/`;
      if (!pageId || !path.startsWith(prefix) || path.includes('..') || !values.file_name || !Number.isSafeInteger(values.file_size) || Number(values.file_size)<0 || Number(values.file_size)>2097152 || (values.storage_bucket!==undefined && values.storage_bucket!=='kb-files')) return fail('kb_invalid_attachment');
      statement=env.DB.prepare(`INSERT INTO kb_attachments(id,workspace_id,page_id,file_name,file_size,file_type,storage_path,storage_bucket,uploaded_by,created_at)
        SELECT ?,?,id,?,?,?,?,?,?,? FROM kb_pages WHERE workspace_id=? AND id=? AND ${editable} RETURNING *`)
        .bind(id,ws,values.file_name,values.file_size,values.file_type??'',path,'kb-files',member,stamp,ws,pageId,...editableParams);
    } else if (req.op==='delete') {
      statement=env.DB.prepare(`DELETE FROM kb_attachments WHERE workspace_id=? AND id=? AND page_id IN (SELECT id FROM kb_pages WHERE workspace_id=? AND ${editable}) RETURNING *`)
        .bind(ws,id,ws,...editableParams);
    } else return fail('kb_forbidden');
  } else if (req.table==='kb_comments') {
    if (Object.keys(values).some(k=>!['body','page_id','created_by'].includes(k))) return fail('kb_forbidden');
    if (req.op!=='delete' && (typeof values.body!=='string' || !values.body.trim() || values.body.length>10000)) return fail('kb_invalid_comment');
    if (req.op==='insert') {
      const comment=knowledgePermissionSql('kb_pages.id','comment',auth);
      statement=env.DB.prepare(`INSERT INTO kb_comments(id,workspace_id,page_id,body,created_by,created_at,updated_at)
        SELECT ?,?,id,?,?,?,? FROM kb_pages WHERE workspace_id=? AND id=? AND ${comment.sql} RETURNING *`)
        .bind(id,ws,values.body,member,stamp,stamp,ws,String(values.page_id??''),...comment.params);
    } else {
      if (values.page_id!==undefined || values.created_by!==undefined) return fail('kb_forbidden');
      const comment=knowledgePermissionSql('kb_comments.page_id','comment',auth), canEdit=knowledgePermissionSql('kb_comments.page_id','edit',auth);
      statement=req.op==='update' ? env.DB.prepare(`UPDATE kb_comments SET body=?,updated_at=? WHERE workspace_id=? AND id=? AND created_by=? AND ${comment.sql} RETURNING *`)
        .bind(values.body,stamp,ws,id,member,...comment.params)
        : env.DB.prepare(`DELETE FROM kb_comments WHERE workspace_id=? AND id=? AND ((created_by=? AND ${comment.sql}) OR ${canEdit.sql}) RETURNING *`)
          .bind(ws,id,member,...comment.params,...canEdit.params);
    }
  } else return fail('kb_forbidden');
  const result=await statement.all<Record<string,unknown>>();
  const rows=result.results.map(r=>rowToWire(r,TABLES[req.table]!));
  if (!rows.length) return fail('kb_conflict');
  notifyChanges(env,ctx,[{table:req.table,eventType:req.op==='delete'?'DELETE':req.op==='insert'?'INSERT':'UPDATE',new:{},old:null}],ws);
  return {data:req.single || req.maybeSingle ? rows[0] : rows,error:null};
}

/** Private and legacy KB paths use live ACLs, never a public cache. */
export async function knowledgeStorageAllowed(env: Env, auth: AuthCtx | undefined, path: string, action:'view'|'edit'='edit'): Promise<boolean> {
  const ws=auth?.member.workspaceId || DEFAULT_WORKSPACE;
  if (path.startsWith('ws/') && (ws===DEFAULT_WORKSPACE || !path.startsWith(`ws/${ws}/`))) return false;
  const local=ws===DEFAULT_WORKSPACE ? path : path.startsWith(`ws/${ws}/`) ? path.slice(`ws/${ws}/`.length) : path;
  if (!local.startsWith('kb/')) return true;
  const pageId=local.split('/')[1];
  if (!auth || !pageId || local.includes('..')) return false;
  const permission=knowledgePermissionSql('kb_pages.id',action,auth);
  const lock=action==='edit' ? `AND NOT EXISTS (SELECT 1 FROM field_locks WHERE workspace_id=? AND lock_key='kb:'||kb_pages.id AND locked_by!=? AND expires_at>?)` : '';
  return !!await env.DB.prepare(`SELECT id FROM kb_pages WHERE workspace_id=? AND id=? AND ${permission.sql} ${lock}`)
    .bind(ws,pageId,...permission.params,...(action==='edit'?[ws,auth.member.id,new Date().toISOString()]:[])).first();
}
