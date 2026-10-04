import type { Context } from 'hono';
import type { AppContext, AuthCtx, Ctx, Env } from './env';
import { notifyChanges } from './notify';
import { rowToWire } from './meta';
import { TABLES } from './tables';
import { isDemoMember } from './env';
import { knowledgePermissionSql } from './knowledgeSql';
import { commandAuthId, liveMemberSql } from './liveMember';
import { createQaIssue, QaError, type QaCreateInput } from './qa/domain';
import { parseDeploymentEnvironments } from './qa/environments';
import { parseQaFieldConfiguration } from './qa/fields';
import { KnowledgeWorkflowError, canonicalWorkflow, workflowDescription, workflowDue, workflowFail, workflowHash,
  workflowId, workflowRecord, workflowRelation, workflowTarget, workflowText, workflowVersion } from './knowledgeWorkflow/domain';

type Row = Record<string, any>;
type Params = (string | number | null)[];
const freshActor = (auth: AuthCtx) => { const live = liveMemberSql(auth, 'km'); return { sql: `EXISTS(SELECT 1 FROM members km WHERE ${live.sql})`, params: live.params }; };
const qaEnabled = "EXISTS(SELECT 1 FROM system_settings kf WHERE kf.workspace_id=? AND kf.key='feature_toggles' AND json_valid(kf.value) AND json_extract(kf.value,'$.qa')=1)";
const optionalId = (value: unknown) => value == null || value === '' ? null : workflowId(value);
const fields = (alias: string) => `${alias}.id,${alias}.page_id AS pageId,${alias}.anchor_id AS anchorId,${alias}.text,${alias}.is_done AS isDone,${alias}.version,${alias}.updated_by AS updatedBy,${alias}.updated_at AS updatedAt,${alias}.completed_by AS completedBy,${alias}.completed_at AS completedAt`;

/** Every query, including reverse-link counts, joins the live page and actor ACL. */
export async function executeKnowledgeWorkflow(env: Env, auth: AuthCtx, raw: unknown, ctx?: Ctx): Promise<unknown> {
  const body = workflowRecord(raw), action = String(body.action || ''), ws = auth.member.workspaceId, memberId = auth.member.id;
  const live = freshActor(auth), db = env.DB;
  const all = async (sql: string, params: Params = []) => (await db.prepare(sql).bind(...params).all<Row>()).results;
  const first = async (sql: string, params: Params = []) => db.prepare(sql).bind(...params).first<Row>();
  if (!await first(`SELECT 1 AS ok WHERE ${live.sql}`, live.params)) workflowFail('kb_workflow_forbidden', 403);
  const targetExists = (kind: string, expression: string) => kind === 'task'
    ? `EXISTS(SELECT 1 FROM tasks kt JOIN projects kp ON kp.id=kt.project_id AND kp.workspace_id=kt.workspace_id WHERE kt.workspace_id=? AND kt.id=${expression})`
    : `(${qaEnabled} AND EXISTS(SELECT 1 FROM qa_issues kq JOIN projects kp ON kp.id=kq.project_id AND kp.workspace_id=kq.workspace_id WHERE kq.workspace_id=? AND kq.id=${expression}))`;
  const targetParams = (kind: string) => kind === 'task' ? [ws] : [ws, ws];
  if (action === 'backlinks') {
    const kind = workflowTarget(body.targetKind), target = workflowId(body.targetId), permission = knowledgePermissionSql('l.page_id', 'view', auth);
    return { items: await all(`SELECT l.id AS linkId,p.id AS pageId,p.title,p.category,l.anchor_id AS anchorId,l.relation FROM kb_work_links l
      JOIN kb_pages p ON p.id=l.page_id AND p.workspace_id=l.workspace_id WHERE l.workspace_id=? AND l.target_kind=? AND l.target_id=?
      AND ${permission.sql} AND ${live.sql} AND ${targetExists(kind, 'l.target_id')} ORDER BY p.title,l.id LIMIT 200`,
      [ws, kind, target, ...permission.params, ...live.params, ...targetParams(kind)]) };
  }
  const pageId = workflowId(body.pageId), perm = knowledgePermissionSql('p.id', 'view', auth);
  const page = await first(`SELECT p.* FROM kb_pages p WHERE p.workspace_id=? AND p.id=? AND ${perm.sql} AND ${live.sql}`, [ws, pageId, ...perm.params, ...live.params]);
  if (!page) workflowFail('kb_workflow_unavailable', 404);
  const readPredicate = (expression: string) => knowledgePermissionSql(expression, 'view', auth);
  if (action === 'list') {
    const check = readPredicate('c.page_id'), link = readPredicate('l.page_id'), snapshot = readPredicate('s.page_id');
    const [checklist, links, snapshots] = await Promise.all([
      all(`SELECT ${fields('c')},(SELECT l.id FROM kb_work_links l WHERE l.workspace_id=c.workspace_id AND l.checklist_id=c.id) AS linkedWorkId
        FROM kb_checklist_items c WHERE c.workspace_id=? AND c.page_id=? AND ${check.sql} AND ${live.sql} ORDER BY c.created_at,c.id LIMIT 500`, [ws, pageId, ...check.params, ...live.params]),
      all(`SELECT l.id,l.page_id AS pageId,l.anchor_id AS anchorId,l.checklist_id AS checklistId,l.snapshot_id AS snapshotId,l.target_kind AS targetKind,l.target_id AS targetId,l.relation,
        CASE WHEN l.target_kind='task' THEN t.title ELSE q.title END AS title,CASE WHEN l.target_kind='task' THEN t.task_key ELSE q.id END AS key,
        CASE WHEN l.target_kind='task' THEN s.name ELSE q.state END AS status,CASE WHEN l.target_kind='task' THEN t.assignee_id ELSE q.assignee_id END AS assigneeId,
        CASE WHEN l.target_kind='task' THEN t.due_date ELSE json_extract(q.data,'$.dueDate') END AS dueDate,
        CASE WHEN l.target_kind='task' THEN t.id IS NULL ELSE q.id IS NULL END AS unavailable
        FROM kb_work_links l LEFT JOIN tasks t ON l.target_kind='task' AND t.id=l.target_id AND t.workspace_id=l.workspace_id
        LEFT JOIN statuses s ON s.id=t.status_id AND s.workspace_id=t.workspace_id
        LEFT JOIN qa_issues q ON l.target_kind='qa' AND q.id=l.target_id AND q.workspace_id=l.workspace_id AND ${qaEnabled}
        WHERE l.workspace_id=? AND l.page_id=? AND ${link.sql} AND ${live.sql} ORDER BY l.created_at,l.id LIMIT 500`, [ws, ws, pageId, ...link.params, ...live.params]),
      all(`SELECT s.id,s.page_id AS pageId,s.source_kind AS sourceKind,s.source_title AS sourceTitle,s.source_url AS sourceUrl,s.body_hash AS bodyHash,
        s.page_version AS pageVersion,s.created_at AS createdAt FROM kb_source_snapshots s WHERE s.workspace_id=? AND s.page_id=? AND ${snapshot.sql} AND ${live.sql} ORDER BY s.created_at DESC,s.id LIMIT 200`, [ws, pageId, ...snapshot.params, ...live.params]),
    ]);
    return { pageVersion: page.version, checklist: checklist.map(c => ({ ...c, isDone: !!c.isDone })), links: links.map(l => ({ ...l, title: l.title || '', key: l.key || '', status: l.status || '', unavailable: !!l.unavailable })), snapshots };
  }
  if (action === 'snapshot') {
    const permission = readPredicate('s.page_id');
    const snapshot = await first(`SELECT s.id,s.page_id AS pageId,s.source_kind AS sourceKind,s.source_title AS sourceTitle,s.source_url AS sourceUrl,s.body_hash AS bodyHash,
      s.page_version AS pageVersion,s.created_at AS createdAt,s.body,s.provenance FROM kb_source_snapshots s WHERE s.workspace_id=? AND s.page_id=? AND s.id=? AND ${permission.sql} AND ${live.sql}`,
      [ws, pageId, workflowId(body.snapshotId), ...permission.params, ...live.params]);
    if (!snapshot) workflowFail('kb_workflow_unavailable', 404);
    return { ...snapshot, provenance: JSON.parse(snapshot.provenance) };
  }
  const edit = knowledgePermissionSql('p.id', 'edit', auth);
  if (!await first(`SELECT 1 AS ok FROM kb_pages p WHERE p.workspace_id=? AND p.id=? AND ${edit.sql} AND ${live.sql}`, [ws, pageId, ...edit.params, ...live.params])) workflowFail('kb_workflow_forbidden', 403);
  if (action === 'search_targets') {
    const kind = workflowTarget(body.targetKind), query = workflowText(body.query ?? '', 200, false);
    if (kind === 'qa' && !await first(`SELECT 1 AS ok WHERE ${qaEnabled}`, [ws])) return { items: [] };
    const permission = knowledgePermissionSql('p.id', 'edit', auth), table = kind === 'task' ? 'tasks' : 'qa_issues';
    return { items: await all(`SELECT t.id,t.title,${kind === 'task' ? 't.task_key' : 't.id'} AS key,t.project_id AS projectId FROM ${table} t JOIN projects project ON project.id=t.project_id AND project.workspace_id=t.workspace_id
      WHERE t.workspace_id=? AND instr(lower(t.title||' '||${kind === 'task' ? 't.task_key' : 't.id'}),lower(?))>0 AND ${live.sql}
      AND EXISTS(SELECT 1 FROM kb_pages p WHERE p.workspace_id=? AND p.id=? AND ${permission.sql}) ${kind==='qa'?`AND ${qaEnabled}`:''} ORDER BY t.title,t.id LIMIT 50`, [ws, query, ...live.params, ws, pageId, ...permission.params,...(kind==='qa'?[ws]:[])]) };
  }
  if (isDemoMember(env, auth)) workflowFail('kb_workflow_forbidden', 403);
  const allowed = ['checklist_add', 'checklist_set', 'checklist_delete', 'link', 'unlink', 'create_task', 'create_qa', 'capture_snapshot'];
  if (!allowed.includes(action)) workflowFail('kb_workflow_invalid');
  const commandId = workflowId(body.commandId), hash = await workflowHash(canonicalWorkflow(body));
  const getReceipt = async () => {
    const receipt = await first(`SELECT actor_id,page_id,request_hash,result_json FROM kb_workflow_commands WHERE workspace_id=? AND id=? AND ${live.sql}
      AND EXISTS(SELECT 1 FROM kb_pages p WHERE p.workspace_id=? AND p.id=? AND ${edit.sql})`, [ws, commandId,...live.params,ws,pageId,...edit.params]);
    if (!receipt) return undefined;
    if (receipt.actor_id !== memberId || receipt.page_id !== pageId || receipt.request_hash !== hash) workflowFail('kb_workflow_idempotency_conflict', 409);
    // The live edit check above is intentional: replay never reveals a revoked source.
    return JSON.parse(receipt.result_json);
  };
  const previous = await getReceipt(); if (previous) return previous;
  const now = new Date().toISOString(), id = crypto.randomUUID();
  let anchor = optionalId(body.anchorId) || crypto.randomUUID();
  const statements: D1PreparedStatement[] = [], guard: string[] = [`EXISTS(SELECT 1 FROM kb_pages p WHERE p.workspace_id=? AND p.id=? AND ${edit.sql})`, live.sql];
  const guardParams: Params = [ws, pageId, ...edit.params, ...live.params];
  const addGuard = (sql: string, params: Params = []) => { guard.push(sql); guardParams.push(...params); };
  const add = (sql: string, params: Params) => statements.push(db.prepare(sql).bind(...params));
  let result: Row = { id }, checklistId = optionalId(body.checklistId), snapshotId = optionalId(body.snapshotId);
  if (body.expectedPageVersion !== undefined) addGuard('EXISTS(SELECT 1 FROM kb_pages WHERE workspace_id=? AND id=? AND version=?)', [ws, pageId, workflowVersion(body.expectedPageVersion)]);
  if (checklistId) {
    addGuard('EXISTS(SELECT 1 FROM kb_checklist_items c WHERE c.workspace_id=? AND c.page_id=? AND c.id=? AND c.version=? AND NOT EXISTS(SELECT 1 FROM kb_work_links l WHERE l.workspace_id=c.workspace_id AND l.checklist_id=c.id))', [ws, pageId, checklistId, workflowVersion(body.expectedVersion)]);
    const source = await first('SELECT anchor_id FROM kb_checklist_items WHERE workspace_id=? AND page_id=? AND id=?', [ws, pageId, checklistId]);
    if (!source) workflowFail('kb_workflow_unavailable',404);
    anchor = source.anchor_id;
  }
  if (snapshotId) addGuard('EXISTS(SELECT 1 FROM kb_source_snapshots WHERE workspace_id=? AND page_id=? AND id=?)', [ws, pageId, snapshotId]);
  if (action === 'checklist_add') {
    add('INSERT INTO kb_checklist_items(workspace_id,id,page_id,anchor_id,text,created_by,created_at,updated_by,updated_at) VALUES(?,?,?,?,?,?,?,?,?)', [ws, id, pageId, anchor, workflowText(body.text), memberId, now, memberId, now]);
  } else if (action === 'checklist_set' || action === 'checklist_delete') {
    if (!checklistId) workflowFail('kb_workflow_invalid');
    result = { id: checklistId };
    if (action === 'checklist_delete') add('DELETE FROM kb_checklist_items WHERE workspace_id=? AND page_id=? AND id=?', [ws, pageId, checklistId]);
    else {
      if (typeof body.isDone !== 'boolean') workflowFail('kb_workflow_invalid');
      add('UPDATE kb_checklist_items SET is_done=?,version=version+1,updated_by=?,updated_at=?,completed_by=?,completed_at=? WHERE workspace_id=? AND page_id=? AND id=?', [body.isDone ? 1 : 0, memberId, now, body.isDone ? memberId : null, body.isDone ? now : null, ws, pageId, checklistId]);
    }
  } else if (action === 'unlink') {
    const linkId = workflowId(body.linkId);
    addGuard('EXISTS(SELECT 1 FROM kb_work_links WHERE workspace_id=? AND page_id=? AND id=?)', [ws, pageId, linkId]);
    add('DELETE FROM kb_work_links WHERE workspace_id=? AND page_id=? AND id=?', [ws, pageId, linkId]); result = { id: linkId };
  } else if (action === 'capture_snapshot') {
    workflowVersion(body.expectedPageVersion);
    const bodyHash = await workflowHash(page.body), existing = await first("SELECT id FROM kb_source_snapshots WHERE workspace_id=? AND page_id=? AND body_hash=? AND source_kind='page' AND source_key=?", [ws, pageId, bodyHash, pageId]);
    result = { id: existing?.id || id };
    if (!existing) add('INSERT INTO kb_source_snapshots(workspace_id,id,page_id,source_kind,source_title,source_key,body,body_hash,page_version,created_by,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)', [ws, id, pageId, 'page', page.title, pageId, page.body, bodyHash, page.version, memberId, now]);
  } else {
    let kind = action === 'create_task' ? 'task' : action === 'create_qa' ? 'qa' : workflowTarget(body.targetKind), targetId = action === 'link' ? workflowId(body.targetId) : crypto.randomUUID();
    if ((action === 'create_task' || action === 'create_qa') && !snapshotId) {
      const bodyHash = await workflowHash(page.body);
      const existing = await first("SELECT id FROM kb_source_snapshots WHERE workspace_id=? AND page_id=? AND body_hash=? AND source_kind='page' AND source_key=?", [ws,pageId,bodyHash,pageId]);
      snapshotId=existing?.id || crypto.randomUUID();
      if(!existing)add('INSERT INTO kb_source_snapshots(workspace_id,id,page_id,source_kind,source_title,source_key,body,body_hash,page_version,created_by,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)',[ws,snapshotId,pageId,'page',page.title,pageId,page.body,bodyHash,page.version,memberId,now]);
    }
    if (action === 'create_task') {
      workflowVersion(body.expectedPageVersion);
      const input = workflowRecord(body.input), projectId = workflowId(input.projectId), statusId = workflowId(input.statusId), title = workflowText(input.title, 200);
      const assignee = optionalId(input.assigneeId), due = workflowDue(input.dueDate), description = workflowDescription(input.description);
      addGuard('EXISTS(SELECT 1 FROM projects WHERE workspace_id=? AND id=? AND is_archived=0)', [ws, projectId]);
      addGuard('EXISTS(SELECT 1 FROM statuses WHERE workspace_id=? AND id=? AND is_done=0)', [ws, statusId]);
      if (assignee) addGuard('EXISTS(SELECT 1 FROM members WHERE workspace_id=? AND id=? AND is_active=1)', [ws, assignee]);
      const required = await first("SELECT value FROM system_settings WHERE workspace_id=? AND key='required_fields'", [ws]);
      const requirements = required ? JSON.parse(required.value) : {};
      addGuard("COALESCE((SELECT value FROM system_settings WHERE workspace_id=? AND key='required_fields'),'{}')=?", [ws, required?.value || '{}']);
      for (const [field, needed] of Object.entries(requirements)) if (needed === true && !['title','project','status','priority'].includes(field) && !({assignee, dueDate: due, requirement: description} as Row)[field]) workflowFail('kb_workflow_required_fields');
      add(`INSERT INTO tasks(workspace_id,id,task_key,project_id,title,status_id,priority,creator_id,assignee_id,due_date,created_at)
        SELECT ?,?,p.key||'-'||(COALESCE((SELECT MAX(CAST(substr(t.task_key,length(p.key)+2) AS INTEGER)) FROM tasks t WHERE t.workspace_id=p.workspace_id AND substr(t.task_key,1,length(p.key)+1)=p.key||'-'),0)+1),?,?,?,'medium',?,?,?,?
        FROM projects p WHERE p.workspace_id=? AND p.id=?`, [ws, targetId, projectId, title, statusId, memberId, assignee, due, now, ws, projectId]);
      add('INSERT INTO task_specs(workspace_id,id,task_id,background,requirement,notes) VALUES(?,?,?,?,?,?)', [ws, crypto.randomUUID(), targetId, '', description, '']);
      add("INSERT INTO activity_logs(workspace_id,id,user_id,action,target_type,task_id,detail,created_at) VALUES(?,?,?,'create','task',?,'Task created',?)", [ws, crypto.randomUUID(), memberId, targetId, now]);
    } else if (action === 'create_qa') {
      workflowVersion(body.expectedPageVersion);
      const input = workflowRecord(body.input), projectId = workflowId(input.projectId);
      const actor = await first('SELECT id,role FROM members WHERE workspace_id=? AND id=? AND is_active=1', [ws, memberId]);
      const environment = await first("SELECT value FROM system_settings WHERE workspace_id=? AND key='deployment_environments'", [ws]);
      // The team's QA custom fields, as the QA page validates them; the guard below
      // refuses the batch if they change before it commits.
      const fieldRow = await first("SELECT value FROM system_settings WHERE workspace_id=? AND key='qa_custom_fields'", [ws]);
      const environments = parseDeploymentEnvironments(environment ? JSON.parse(environment.value) : undefined);
      if (!actor || !environments) workflowFail('kb_workflow_invalid');
      // The QA command trigger re-checks the actor's login; a key records its member's login.
      const authId = await commandAuthId(env, auth);
      if (!authId) workflowFail('kb_workflow_forbidden', 403);
      const issue = createQaIssue(input as unknown as QaCreateInput, targetId, {actor:{id:memberId,role:actor.role},fieldConfiguration:parseQaFieldConfiguration(fieldRow?.value),workspaceId:ws,now,newId:()=>crypto.randomUUID(),memberIds:new Set([memberId]),projectIds:new Set([projectId]),taskIds:new Set(),environmentValues:environments.values});
      addGuard(qaEnabled, [ws]);
      addGuard("(SELECT value FROM system_settings WHERE workspace_id=? AND key='qa_custom_fields') IS ?", [ws, fieldRow?.value ?? null]);
      const data = JSON.stringify(issue);
      add('INSERT INTO qa_commands(workspace_id,id,issue_id,actor_id,actor_role,actor_auth_id,expected_version,operation,request_hash,issue_data,result_json,created_at) VALUES(?,?,?,?,?,?,-1,?,?,?,?,?)', [ws, `kb_${commandId}`, targetId, memberId, actor.role, authId, 'create', hash, data, data, now]);
      add('INSERT INTO qa_issues(workspace_id,id,project_id,state,reporter_id,title,version,updated_at,data) VALUES(?,?,?,?,?,?,1,?,?)', [ws, targetId, projectId, 'new', memberId, issue.title, now, data]);
      add('INSERT INTO qa_events(workspace_id,id,issue_id,actor_id,type,detail,version,created_at) VALUES(?,?,?,?,?,?,1,?)', [ws, crypto.randomUUID(), targetId, memberId, 'create', 'create', now]);
    } else addGuard(targetExists(kind, '?'), [...targetParams(kind), targetId]);
    const relation = workflowRelation(body.relation || 'reference');
    add('INSERT INTO kb_work_links(workspace_id,id,page_id,anchor_id,checklist_id,snapshot_id,target_kind,target_id,relation,created_by,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)', [ws, id, pageId, anchor, checklistId, snapshotId, kind, targetId, relation, memberId, now]);
    result = { id, targetKind: kind, targetId };
  }
  const receipt = db.prepare(`INSERT INTO kb_workflow_commands(workspace_id,id,actor_id,page_id,request_hash,result_json,allowed,created_at) VALUES(?,?,?,?,?,?,CASE WHEN ${guard.join(' AND ')} THEN 1 ELSE 0 END,?)`).bind(ws, commandId, memberId, pageId, hash, JSON.stringify(result), ...guardParams, now);
  try { await db.batch([receipt, ...statements]); }
  catch (error) {
    const replay = await getReceipt(); if (replay) return replay;
    const code = error instanceof Error ? error.message.match(/(?:kb_workflow|qa)_[a-z_]+/)?.[0] : undefined;
    workflowFail(code || 'kb_workflow_conflict', 409);
  }
  // Only the winning transaction reaches this point. Replays return above, and
  // notifications contain the published work item, never its private KB source.
  if (ctx && (action === 'create_task' || action === 'create_qa')) {
    try {
      const table = action === 'create_task' ? 'tasks' : 'qa_issues';
      const columns = table === 'tasks' ? '*' : 'id,workspace_id,project_id,version';
      const created = await first(`SELECT ${columns} FROM ${table} WHERE workspace_id=? AND id=?`, [ws, result.targetId]);
      if (created) notifyChanges(env, ctx, [{ table, eventType: 'INSERT', new: rowToWire(created, TABLES[table]), old: null }], ws);
    } catch { /* A transport failure must not make a committed command appear to fail. */ }
  }
  return result;
}

export async function handleKnowledgeWorkflow(c: Context<AppContext>): Promise<Response> {
  try {
    const raw = await c.req.text(); if (raw.length > 262144) workflowFail('kb_workflow_too_large', 413);
    return c.json(await executeKnowledgeWorkflow(c.env, c.get('auth'), JSON.parse(raw), c.executionCtx));
  } catch (error) {
    const e = error instanceof KnowledgeWorkflowError || error instanceof QaError ? error : new KnowledgeWorkflowError('kb_workflow_invalid', 400);
    return c.json({error:{code:e.code,message:e.code}}, e.status as 400);
  }
}
