import { parseDeploymentEnvironments } from './environments.ts';
import { applyQaCommand, createQaIssue, qaEventDetail, qaNotificationRecipients, QaError, QA_MAX_FILE_BYTES, QA_STATES,
  type QaAttachment, type QaCommand, type QaContext, type QaCreateInput, type QaIssue,
  type QaListInput, type QaListResult } from './domain.ts';
import { validateQaBackup } from './restore.ts';
import { syncQaSlackIssue } from './slackSync.ts';
import { parseQaWorkflow, validateQaWorkflow } from './workflow.ts';
import { canManageQaConfiguration, parseQaFieldConfiguration, validateQaFieldConfiguration } from './fields.ts';
import { qaVersionSuggestions } from './versions.ts';

export interface QaEnvironment { get(name: string): string | undefined }
type Row = Record<string, any>;
const WORKSPACE = 'default';
const BUCKET = 'qa-evidence';
export const QA_BACKUP_TABLES = ['qa_issues', 'qa_commands', 'qa_events', 'qa_comments', 'qa_uploads', 'qa_attachments', 'qa_slack_links','qa_project_coordination','qa_coordination_commands'] as const;
const MIMES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'video/mp4', 'video/webm', 'application/pdf', 'text/plain']);
const fail = (code: string, status = 400): never => { throw new QaError(code, status); };
const object = (v: unknown): Row => v && typeof v === 'object' && !Array.isArray(v) ? v as Row : fail('qa_invalid_request');
const id = (v: unknown): string => typeof v === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,99}$/.test(v) ? v : fail('qa_invalid_id');
const commandId = (v: unknown): string => typeof v === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_:-]{7,199}$/.test(v) ? v : fail('qa_invalid_command_id');
const text = (v: unknown, max: number): string => typeof v === 'string' && v.trim() && v.length <= max && !v.includes('\0') ? v.trim() : fail('qa_invalid_text');
const now = () => new Date().toISOString();
const storagePath = (path: string) => path.split('/').map(encodeURIComponent).join('/');
const canonical = (v: unknown): string => Array.isArray(v) ? `[${v.map(canonical).join(',')}]`
  : v && typeof v === 'object' ? `{${Object.keys(v).sort().map(k => `${JSON.stringify(k)}:${canonical((v as Row)[k])}`).join(',')}}`
    : JSON.stringify(v);
export async function qaPayloadHash(value: unknown): Promise<string> {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonical(value)));
  return Array.from(new Uint8Array(bytes), b => b.toString(16).padStart(2, '0')).join('');
}
function databaseError(body: Row, status: number): never {
  const message = String(body.message || '');
  const fieldCode = message.match(/qa_(?:invalid_(?:field_configuration|custom_fields|custom_field_value)|custom_field_(?:required|unavailable)|field_identity_immutable|forbidden)/)?.[0];
  if (fieldCode) return fail(fieldCode, body.code === '42501' ? 403 : 400);
  const known = ['qa_disabled', 'qa_invalid_workflow', 'member_inactive', 'invalid_command', 'command_id_reused', 'issue_exists', 'issue_not_found',
    'version_conflict', 'invalid_issue', 'upload_not_found', 'upload_expired', 'upload_incomplete', 'upload_metadata_mismatch', 'qa_upload_unavailable', 'restore_conflict','qa_forbidden','qa_project_unavailable','qa_member_unavailable','qa_version_conflict','qa_command_id_reused','qa_invalid_request'];
  const code = known.find(code => message.includes(code));
  if (code) fail(code.startsWith('qa_') ? code : `qa_${code}`, ['42501'].includes(body.code) ? 403
    : ['40001', '23505'].includes(body.code) ? 409 : body.code === 'P0002' ? 404 : 400);
  return fail('qa_storage_unavailable', status >= 500 ? 503 : 400);
}

class Store {
  constructor(private env: QaEnvironment) {}
  async raw(path: string, method = 'GET', body?: unknown, query: Row = {}, headers: Record<string, string> = {}, timeout = 20000) {
    const response = await fetch(`${this.env.get('SUPABASE_URL')}${path}?${new URLSearchParams(query)}`, { method,
      headers: { apikey: this.env.get('SUPABASE_ANON_KEY') || '', Authorization: `Bearer ${this.env.get('SUPABASE_SERVICE_ROLE_KEY') || ''}`,
        'Content-Type': 'application/json', ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(timeout) });
    if (!response.ok) databaseError(await response.json().catch(() => ({})), response.status);
    return response;
  }
  async request(path: string, method = 'GET', body?: unknown, query: Row = {}) {
    const response = await this.raw(path, method, body, query, { Prefer: 'return=representation' });
    return response.status === 204 ? null : response.json();
  }
  rows(table: string, query: Row = {}): Promise<Row[]> { return this.request(`/rest/v1/${table}`, 'GET', undefined, query); }
  qaRows(table: string, query: Row = {}): Promise<Row[]> { return this.rows(table, { workspace_id: `eq.${WORKSPACE}`, ...query }); }
  rpc(name: string, body: unknown) { return this.request(`/rest/v1/rpc/${name}`, 'POST', body); }
  async all(table: string, filters: Row = {}) {
    const rows: Row[] = [];
    for (let offset = 0; ; offset += 500) {
      const page = await this.qaRows(table, { select: '*', order: 'id', offset, limit: 500, ...filters });
      rows.push(...page); if (page.length < 500) return rows;
      if (rows.length > 100000) return fail('qa_backup_too_large');
    }
  }
}

export function attachment(row: Row): QaAttachment {
  return { id: row.id, issueId: row.issue_id, fileName: row.file_name, mimeType: row.mime_type,
    size: Number(row.size), uploadedBy: row.uploaded_by, createdAt: row.created_at };
}

/** Reusable by the HTTP handler and by Slack's verified short-lived member JWT.
 * The caller supplies only a session token, never a trusted actor ID or role. */
export function createQaService(env: QaEnvironment, sessionToken: string) {
  const db = new Store(env);
  async function authenticate(): Promise<Row & { authId: string }> {
    if (!sessionToken || sessionToken === env.get('SUPABASE_SERVICE_ROLE_KEY') || sessionToken === env.get('SUPABASE_ANON_KEY')) fail('qa_unauthorized', 401);
    const response = await fetch(`${env.get('SUPABASE_URL')}/auth/v1/user`, { headers: {
      apikey: env.get('SUPABASE_ANON_KEY') || '', Authorization: `Bearer ${sessionToken}` }, signal: AbortSignal.timeout(10000) });
    if (!response.ok) fail('qa_unauthorized', 401);
    const user = await response.json();
    if (typeof user.id !== 'string' || !/^[0-9a-f-]{36}$/i.test(user.id)) fail('qa_unauthorized', 401);
    const [members, settings] = await Promise.all([
      db.rows('members', { select: 'id,role,auth_id,is_active,is_qa_admin', auth_id: `eq.${user.id}`, is_active: 'eq.true', limit: 2 }),
      db.rows('system_settings', { select: 'value', key: 'eq.feature_toggles', limit: 1 }),
    ]);
    if (members.length !== 1 || members[0].is_active !== true) fail('qa_forbidden', 403);
    if (settings[0]?.value?.qa !== true) fail('qa_disabled', 403);
    let slackIdentity = null;
    // Parse claims only after GoTrue has authenticated the complete token.
    try {
      const segment=sessionToken.split('.')[1];
      if(segment){const encoded=segment.replace(/-/g,'+').replace(/_/g,'/');
        const claims=JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(encoded.padEnd(Math.ceil(encoded.length/4)*4,'=')),c=>c.charCodeAt(0))));
        if(Object.keys(claims).some(key=>key.startsWith('livo_slack_'))){
          if(claims.sub!==user.id||!['livo_slack_binding','livo_slack_team','livo_slack_user'].every(key=>typeof claims[key]==='string'))fail('qa_forbidden',403);
          slackIdentity={bindingId:claims.livo_slack_binding,teamId:claims.livo_slack_team,userId:claims.livo_slack_user};
        }
      }
    }catch{fail('qa_forbidden',403);}
    if(slackIdentity)await db.rpc('livo_qa_live_actor',{p_auth_id:user.id,p_identity:slackIdentity});
    return { ...members[0], authId: user.id, qaAdmin: members[0].is_qa_admin === true, slackIdentity };
  }
  async function getIssue(issueId: string): Promise<QaIssue> {
    const row = (await db.qaRows('qa_issues', { select: 'data', id: `eq.${id(issueId)}`, limit: 1 }))[0];
    if (!row) return fail('qa_issue_not_found', 404);
    return row.data;
  }
  async function coordination(projectId:string,includeArchived=false) {
    const project=(await db.rows('projects',{select:'id',id:`eq.${id(projectId)}`,...(includeArchived?{}:{is_archived:'eq.false'}),limit:1}))[0];
    if(!project)fail('qa_project_unavailable',404);
    const row=(await db.qaRows('qa_project_coordination',{select:'coordinator_id,version',id:`eq.${projectId}`,limit:1}))[0];
    return {projectId,coordinatorId:row?.coordinator_id??null,version:row?.version??0};
  }
  async function context(actor: Row, projectId: string, issue?: QaIssue, command?: QaCommand): Promise<QaContext> {
    const candidateIds = new Set([actor.id, issue?.assigneeId, issue?.qaOwnerId]);
    if (command?.type === 'request_handoff') candidateIds.add(id(command.nextOwnerId));
    if (command?.type === 'triage') { candidateIds.add(id(command.assigneeId)); candidateIds.add(id(command.qaOwnerId)); }
    const candidates = [...candidateIds].filter(Boolean).map(id);
    const linked = command?.type === 'link_tasks' ? command.taskIds : [];
    if (!Array.isArray(linked) || linked.length > 50) fail('qa_invalid_tasks');
    const [members, projects, tasks, duplicates, environmentRows, fieldRows] = await Promise.all([
      db.rows('members', { select: 'id', id: `in.(${candidates.join(',')})`, is_active: 'eq.true' }),
      db.rows('projects', { select: 'id', id: `eq.${id(projectId)}`, is_archived: 'eq.false', limit: 1 }),
      linked.length ? db.rows('tasks', { select: 'id', id: `in.(${linked.map(id).join(',')})`, project_id: `eq.${id(projectId)}` }) : [],
      command?.type === 'close' && command.resolution === 'duplicate' ? db.qaRows('qa_issues', { select: 'id', id: `eq.${id(command.duplicateOfId)}`, limit: 1 }) : [],
      db.rows('system_settings', { select: 'value', key: 'eq.deployment_environments', limit: 1 }),
      !issue || command?.type === 'edit' ? db.rows('system_settings', { select: 'value', key: 'eq.qa_custom_fields', limit: 1 }) : [],
    ]);
    const config = await coordination(projectId);
    const environments = parseDeploymentEnvironments(environmentRows[0]?.value);
    if (!environments) return fail('qa_invalid_environment');
    return { ...(!issue || command?.type === 'edit' ? { fieldConfiguration: parseQaFieldConfiguration(fieldRows[0]?.value) } : {}), environmentValues: environments.values, actor: { id: actor.id, role: actor.role, qaAdmin: actor.qaAdmin, qaCoordinatorProjectIds:config.coordinatorId===actor.id?[projectId]:[] }, workspaceId: WORKSPACE, now: now(), newId: () => crypto.randomUUID(),
      memberIds: new Set(members.map(m => m.id)), projectIds: new Set(projects.map(p => p.id)),
      taskIds: new Set(tasks.map(t => t.id)), duplicateIssueIds: new Set(duplicates.map(d => d.id)) };
  }
  async function replay(actor: Row, request: Row, hash: string) {
    const receipt = (await db.qaRows('qa_commands', { select: '*', id: `eq.${commandId(request.commandId)}`, limit: 1 }))[0];
    if (!receipt) return undefined;
    if (receipt.actor_id !== actor.id || receipt.issue_id !== request.id || receipt.payload_hash !== hash) fail('qa_command_id_reused', 409);
    return receipt.response;
  }
  async function commit(actor: Row, request: Row, hash: string, data: unknown, kind: string, type: string, sourceIssue?: QaIssue, before?: QaIssue) {
    const issue = sourceIssue || data as QaIssue;
    const recipients = qaNotificationRecipients(issue, type === 'created' ? 'create' : type as QaCommand['type'] | 'comment', actor.id);
    const result = await db.rpc('livo_qa_commit', { p_auth_id: actor.authId, p_issue_id: request.id,
      p_command_id: commandId(request.commandId), p_payload_hash: hash, p_expected_version: request.expectedVersion ?? null,
      p_kind: kind, p_data: data, p_event: { slackIdentity:actor.slackIdentity, id: crypto.randomUUID(), type, detail: qaEventDetail(issue, type, before), recipients } });
    const sync = syncQaSlackIssue(env, kind === 'comment' ? issue : result).catch(() => console.error('QA Slack card refresh failed'));
    const runtime = globalThis as unknown as { EdgeRuntime?: { waitUntil?: (work: Promise<unknown>) => void } };
    if (runtime.EdgeRuntime?.waitUntil) runtime.EdgeRuntime.waitUntil(sync); else await sync;
    return result;
  }
  return { async handle(raw: unknown): Promise<any> {
    const request = object(raw), actor = await authenticate();
    switch (request.action) {
      case 'versions': {
        const projectId = id(request.projectId);
        const project = (await db.rows('projects', { select: 'id', id: `eq.${projectId}`, limit: 1 }))[0];
        if (!project) fail('qa_project_unavailable', 403);
        // Read only version-bearing fields, with the same server-only QA scope.
        const rows = await db.all('qa_issues', { project_id: `eq.${projectId}`,
          select: 'workspaceId:workspace_id,projectId:project_id,observedVersion:data->>observedVersion,targets:data->targets,runs:data->runs' });
        return qaVersionSuggestions(rows as Array<{workspaceId:string;projectId:string}>, WORKSPACE, projectId);
      }
      case 'get_coordination': return coordination(id(request.projectId));
      case 'members': {
        await coordination(id(request.projectId));
        const offset=request.offset??0,search=typeof request.search==='string'?request.search.trim():'';
        if(!Number.isSafeInteger(offset)||offset<0||offset>100000||search.length>100)fail('qa_invalid_request');
        const rows=await db.rows('members',{select:'id,name',is_active:'eq.true',order:'name,id',offset,limit:100,...(search?{name:`ilike.*${search.replace(/[\\%_*]/g,'\\$&')}*`}:{})});
        return {members:rows,hasMore:rows.length===100};
      }
      case 'save_coordination': {
        const projectId=id(request.projectId),coordinatorId=request.coordinatorId===null?null:id(request.coordinatorId);
        if(!Number.isSafeInteger(request.expectedVersion)||request.expectedVersion<0)fail('qa_invalid_version');
        return db.rpc('livo_qa_save_coordination',{p_auth_id:actor.authId,p_project_id:projectId,p_coordinator_id:coordinatorId,
          p_expected_version:request.expectedVersion,p_command_id:commandId(request.commandId),p_payload_hash:await qaPayloadHash(request),p_slack_identity:actor.slackIdentity});
      }
      case 'get_workflow': {
        const row = (await db.rows('system_settings', { select: 'value', key: 'eq.qa_workflow', limit: 1 }))[0];
        return parseQaWorkflow(row?.value);
      }
      case 'save_workflow': {
        if (!canManageQaConfiguration({role:actor.role,qaAdmin:actor.qaAdmin})) fail('qa_forbidden', 403);
        validateQaWorkflow(request.workflow);
        return db.rpc('livo_qa_save_workflow', { p_auth_id: actor.authId, p_workflow: parseQaWorkflow(request.workflow) });
      }
      case 'get_field_configuration': {
        const row = (await db.rows('system_settings', { select: 'value', key: 'eq.qa_custom_fields', limit: 1 }))[0];
        return parseQaFieldConfiguration(row?.value);
      }
      case 'save_field_configuration': {
        if (!canManageQaConfiguration({role:actor.role,qaAdmin:actor.qaAdmin})) fail('qa_forbidden',403);
        const row = (await db.rows('system_settings', { select: 'value', key: 'eq.qa_custom_fields', limit: 1 }))[0];
        const configuration = validateQaFieldConfiguration(request.configuration, parseQaFieldConfiguration(row?.value));
        return db.rpc('livo_qa_save_field_configuration', { p_auth_id: actor.authId, p_configuration: configuration });
      }
      case 'list': {
        const input: QaListInput = request.input == null ? {} : object(request.input);
        const offset = input.offset ?? 0, limit = input.limit ?? 50;
        if (!Number.isInteger(offset) || offset < 0 || offset > 100000 || !Number.isInteger(limit) || limit < 1 || limit > 100) fail('qa_invalid_page');
        const query: Row = { select: 'data', workspace_id: `eq.${WORKSPACE}`, order: 'updated_at.desc,id', offset, limit };
        if (input.projectId) query.project_id = `eq.${id(input.projectId)}`;
        if (input.state) { if (!QA_STATES.includes(input.state)) fail('qa_invalid_state'); query.state = `eq.${input.state}`; }
        if (input.states !== undefined) {
          if (input.state || !Array.isArray(input.states) || !input.states.length || input.states.length > QA_STATES.length
            || new Set(input.states).size !== input.states.length || input.states.some(state => !QA_STATES.includes(state))) fail('qa_invalid_state');
          query.state = `in.(${input.states.join(',')})`;
        }
        if (input.mine) {
          const column = ({ assigned: 'assignee_id', testing: 'qa_owner_id', reported: 'reporter_id' } as Row)[input.mine];
          if (!column) fail('qa_invalid_filter'); query[column] = `eq.${actor.id}`;
        }
        if (input.search) query.title = `ilike.*${text(input.search, 100).replace(/[\\%_*]/g, '\\$&')}*`;
        const response = await db.raw('/rest/v1/qa_issues', 'GET', undefined, query, { Prefer: 'count=exact' });
        const rows = await response.json(), total = Number(response.headers.get('Content-Range')?.split('/')[1] ?? rows.length);
        return { issues: rows.map((r: Row) => r.data), total, hasMore: offset + rows.length < total } satisfies QaListResult;
      }
      case 'get': {
        const issue = await getIssue(request.id);
        const [comments, events, attachments] = await Promise.all(['qa_comments', 'qa_events', 'qa_attachments'].map(table =>
          db.all(table, { issue_id: `eq.${issue.id}`, order: 'created_at,id' })));
        const people=[...new Set([issue.assigneeId,issue.qaOwnerId,issue.handoff?.nextOwnerId,issue.handoff?.requestedBy,issue.handoff?.acceptedBy,issue.handoff?.resolvedBy].filter(Boolean))].map(id);
        const names=people.length?await db.rows('members',{select:'id,name',id:`in.(${people.join(',')})`}):[];
        return { issue, memberNames:Object.fromEntries(names.map(m=>[m.id,m.name])), coordination:await coordination(issue.projectId,true), comments: comments.map(c => ({ id: c.id, issueId: c.issue_id, actorId: c.actor_id, body: c.body, createdAt: c.created_at })),
          events: events.map(e => ({ id: e.id, issueId: e.issue_id, actorId: e.actor_id, type: e.type, detail: e.detail, version: e.version, createdAt: e.created_at })),
          attachments: attachments.map(attachment) };
      }
      case 'create': case 'command': case 'comment': {
        id(request.id); commandId(request.commandId);
        const hash = await qaPayloadHash(request), previous = await replay(actor, request, hash);
        if (previous !== undefined) return previous;
        if (request.action === 'create') {
          const input = object(request.input) as QaCreateInput;
          const issue = createQaIssue(input, request.id, await context(actor, input.projectId));
          return commit(actor, request, hash, issue, 'create', 'created');
        }
        const issue = await getIssue(request.id);
        if (request.action === 'comment') {
          const comment = { id: crypto.randomUUID(), issueId: issue.id, actorId: actor.id, body: text(request.body, 20000), createdAt: now() };
          return commit(actor, request, hash, comment, 'comment', 'comment', issue);
        }
        if (!Number.isInteger(request.expectedVersion) || request.expectedVersion < 1) fail('qa_invalid_version');
        if (issue.version !== request.expectedVersion) fail('qa_version_conflict', 409);
        const command = object(request.command) as QaCommand;
        const next = applyQaCommand(issue, command, await context(actor, issue.projectId, issue, command));
        return commit(actor, request, hash, next, 'command', command.type, undefined, issue);
      }
      case 'upload_init': {
        const issue = await getIssue(request.id), fileName = text(request.fileName, 255), mimeType = text(request.mimeType, 100).toLowerCase();
        if (/[\\/\r\n]/.test(fileName) || !MIMES.has(mimeType) || !Number.isSafeInteger(request.size) || request.size < 1 || request.size > QA_MAX_FILE_BYTES) fail('qa_invalid_file');
        const uploadId = crypto.randomUUID(), path = `default/${issue.id}/${uploadId}`, createdAt = now();
        await db.request('/rest/v1/qa_uploads', 'POST', { id: uploadId, workspace_id: WORKSPACE, issue_id: issue.id, actor_id: actor.id,
          file_name: fileName, mime_type: mimeType, size: request.size, storage_path: path, created_at: createdAt,
          expires_at: new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString() });
        const signed = await db.request(`/storage/v1/object/upload/sign/${BUCKET}/${storagePath(path)}`, 'POST', {});
        const token = new URL(signed.url, env.get('SUPABASE_URL')).searchParams.get('token');
        if (!token) fail('qa_storage_unavailable', 503);
        return { id: uploadId, provider: 'supabase', partSize: 0, bucket: BUCKET, path, token };
      }
      case 'upload_complete': return attachment(await db.rpc('livo_qa_finalize_upload', { p_auth_id: actor.authId, p_upload_id: id(request.uploadId) }));
      case 'download': {
        const row = (await db.qaRows('qa_attachments', { select: '*', id: `eq.${id(request.attachmentId)}`, limit: 1 }))[0];
        if (!row) fail('qa_attachment_not_found', 404);
        await getIssue(row.issue_id);
        const response = await db.raw(`/storage/v1/object/authenticated/${BUCKET}/${storagePath(row.storage_path)}`, 'GET', undefined, {}, {}, 300000);
        return new Response(response.body, { headers: { 'Content-Type': row.mime_type, 'X-Content-Type-Options': 'nosniff',
          'Cache-Control': 'private, no-store', 'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(row.file_name)}` } });
      }
      case 'backup': {
        if (actor.role !== 'super_admin') fail('qa_forbidden', 403);
        const rows = await Promise.all(QA_BACKUP_TABLES.map(table => db.all(table)));
        return { tables: Object.fromEntries(QA_BACKUP_TABLES.map((table, index) => [table, rows[index]])) };
      }
      case 'restore': {
        if (actor.role !== 'super_admin') fail('qa_forbidden', 403);
        return db.rpc('livo_qa_restore', { p_auth_id: actor.authId, p_tables: validateQaBackup(request.tables), p_validate_only: request.validateOnly !== false });
      }
      default: return fail('qa_invalid_action');
    }
  } };
}
