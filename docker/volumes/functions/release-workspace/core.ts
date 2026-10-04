/** Release records describe work performed by people. They never deploy code or mutate tasks/QA. */
export type ReleaseTarget = { environment: string; build: string; config: string; data: string };
export type ReleaseComponent = { id: string; name: string; projectId: string; taskIds: string[]; targets: ReleaseTarget[] };
export type ReleaseManifest = { title: string; ownerId: string; components: ReleaseComponent[] };
export type ReleaseEvidence = { id: string; revision: number; componentId: string; environment: string; kind: 'qa' | 'uat';
  note: string; url: string | null; actorId: string; createdAt: string; qa?: { issueId: string; issueVersion: number; fixCycle: number; targetId: string; runId: string; result: string; build: string } };
export type ReleaseException = { id: string; revision: number; scope: string; reason: string; requestedBy: string; requestedAt: string;
  decision: 'pending' | 'approved' | 'rejected'; decidedBy: string | null; decidedAt: string | null; decisionNote: string | null };
export type ReleaseRecord = { id: string; type: 'deployed' | 'failed' | 'rollback' | 'recovery'; note: string; url: string | null; actorId: string; createdAt: string };
export type ReleaseAttempt = { id: string; revision: number; environment: string; componentIds: string[]; manifest: ReleaseManifest;
  note: string; actorId: string; createdAt: string; records: ReleaseRecord[] };
export type ReleaseMaintenance = { id: string; type: 'start' | 'end'; impact: string; note: string; actorId: string; createdAt: string; revision: number };
export type ReleaseBatch = ReleaseManifest & { id: string; workspaceId: string; status: 'draft' | 'active' | 'completed' | 'cancelled';
  version: number; manifestRevision: number; evidence: ReleaseEvidence[]; exceptions: ReleaseException[]; attempts: ReleaseAttempt[];
  maintenance: ReleaseMaintenance[]; createdBy: string; createdAt: string; updatedAt: string; closureNote: string | null };
type Base = { commandId: string; batchId: string; expectedVersion: number };
export type ReleaseCommand = Base & (
  | { operation: 'create' | 'edit_manifest'; manifest: ReleaseManifest }
  | { operation: 'link_evidence'; componentId: string; environment: string; kind: 'qa' | 'uat'; note: string; url: string | null; issueId?: string; targetId?: string; runId?: string; issueVersion?: number }
  | { operation: 'request_exception'; scope: string; reason: string }
  | { operation: 'decide_exception'; exceptionId: string; decision: 'approved' | 'rejected'; note: string }
  | { operation: 'start_attempt'; environment: string; componentIds: string[]; note: string }
  | { operation: 'record_result'; attemptId: string; type: ReleaseRecord['type']; note: string; url: string | null }
  | { operation: 'record_maintenance'; type: ReleaseMaintenance['type']; impact: string; note: string }
  | { operation: 'complete' | 'cancel'; note: string }
  | { operation: 'publish_thread'; teamId: string; channelId: string; confirmed: true }
);
export type ReleaseEvent = { id: string; batchId: string; actorId: string; operation: ReleaseCommand['operation']; version: number; revision: number; createdAt: string };
export type ReleaseResult = { commandId: string; replayed: boolean; batch: ReleaseBatch; event: ReleaseEvent };
export type ReleasePage = { batches: ReleaseBatch[]; page: number; hasMore: boolean };
export type ReleaseEventPage = { events: ReleaseEvent[]; page: number; hasMore: boolean };
export type ReleaseRequest = { action: 'list'; page: number; projectId?: string; search?: string } | { action: 'get'; batchId: string }
  | { action: 'receipt'; batchId: string; commandId: string }
  | { action: 'events'; batchId: string; page: number } | { action: 'command'; command: ReleaseCommand };
export type ReleaseQaSource = { id: string; projectId: string; version: number; fixCycle: number;
  targets: Array<{ id: string; environment: string; component: string; build: string }>;
  runs: Array<{ id: string; targetId: string; result: string; build: string; fixCycle: number }> };
export type ReleaseContext = { workspaceId: string; actorId: string; role: string; now: string; newId: () => string;
  memberIds: Set<string>; projectIds: Set<string>; taskProjects: Map<string, string>; environments: string[]; qaSources: Map<string, ReleaseQaSource>;
  slackIdentity?: { bindingId: string; teamId: string; userId: string }; visibleProjectIds?: Set<string> };
export class ReleaseError extends Error { constructor(public code: string, public status = 400) { super(code); this.name = 'ReleaseError'; } }
const fail = (code = 'release_invalid_input', status = 400): never => { throw new ReleaseError(code, status); };
const obj = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : fail();
const own = (value: object, key: string) => Object.prototype.hasOwnProperty.call(value, key);
const exact = (value: Record<string, unknown>, allowed: string[]) => { if (Object.keys(value).some(key => !allowed.includes(key))) fail(); };
const str = (value: unknown, max: number): string => typeof value === 'string' && value.trim() && !/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(value) && [...value.trim()].length <= max ? value.trim() : fail();
export const releaseId = (value: unknown): string => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(value) ? value : fail();
const integer = (value: unknown, min = 0, max = 100000): number => Number.isSafeInteger(value) && Number(value) >= min && Number(value) <= max ? Number(value) : fail();
const list = <T>(value: unknown, min: number, max: number, parse: (x: unknown) => T): T[] => Array.isArray(value) && value.length >= min && value.length <= max ? value.map(parse) : fail();
const ids = (value: unknown, min: number, max: number): string[] => { const a = list(value, min, max, releaseId); if (new Set(a).size !== a.length) fail(); return a; };
const url = (value: unknown): string | null => { if (value === null) return null; const raw = str(value, 2000); try { const u = new URL(raw); if (!['https:', 'http:'].includes(u.protocol) || u.username || u.password) fail(); return raw; } catch { return fail(); } };
export function parseReleaseManifest(value: unknown): ReleaseManifest {
  const p = obj(value); exact(p, ['title', 'ownerId', 'components']);
  const components = list(p.components, 1, 30, value => {
    const c = obj(value); exact(c, ['id', 'name', 'projectId', 'taskIds', 'targets']);
    const targets = list(c.targets, 1, 15, value => { const t = obj(value); exact(t, ['environment', 'build', 'config', 'data']);
      return { environment: str(t.environment, 120), build: str(t.build, 160), config: str(t.config, 160), data: str(t.data, 160) }; });
    if (new Set(targets.map(t => t.environment)).size !== targets.length) fail();
    return { id: releaseId(c.id), name: str(c.name, 120), projectId: releaseId(c.projectId), taskIds: ids(c.taskIds, 0, 50), targets };
  });
  if (new Set(components.map(c => c.id)).size !== components.length) fail();
  if (new Set(components.flatMap(c => c.taskIds)).size > 80) fail('release_limit_reached', 413);
  return { title: str(p.title, 250), ownerId: releaseId(p.ownerId), components };
}
export function parseReleaseCommand(input: unknown): ReleaseCommand {
  const p = obj(input), base = { commandId: releaseId(p.commandId), batchId: releaseId(p.batchId), expectedVersion: integer(p.expectedVersion) };
  if (base.commandId.length < 8) fail();
  let command: ReleaseCommand;
  switch (p.operation) {
    case 'create': case 'edit_manifest': command = { ...base, operation: p.operation, manifest: parseReleaseManifest(p.manifest) }; break;
    case 'link_evidence': {
      if (p.kind !== 'qa' && p.kind !== 'uat') fail();
      command = { ...base, operation: p.operation, componentId: releaseId(p.componentId), environment: str(p.environment, 120), kind: p.kind as 'qa' | 'uat', note: str(p.note, 2000), url: url(p.url),
        ...(p.kind === 'qa' ? { issueId: releaseId(p.issueId), targetId: releaseId(p.targetId), runId: releaseId(p.runId), issueVersion: integer(p.issueVersion, 1) } : {}) }; break;
    }
    case 'request_exception': command = { ...base, operation: p.operation, scope: str(p.scope, 500), reason: str(p.reason, 2000) }; break;
    case 'decide_exception': if (p.decision !== 'approved' && p.decision !== 'rejected') fail();
      command = { ...base, operation: p.operation, exceptionId: releaseId(p.exceptionId), decision: p.decision as 'approved' | 'rejected', note: str(p.note, 2000) }; break;
    case 'start_attempt': command = { ...base, operation: p.operation, environment: str(p.environment, 120), componentIds: ids(p.componentIds, 1, 30), note: str(p.note, 2000) }; break;
    case 'record_result': if (!['deployed', 'failed', 'rollback', 'recovery'].includes(String(p.type))) fail();
      command = { ...base, operation: p.operation, attemptId: releaseId(p.attemptId), type: p.type as ReleaseRecord['type'], note: str(p.note, 2000), url: url(p.url) }; break;
    case 'record_maintenance': if (p.type !== 'start' && p.type !== 'end') fail();
      command = { ...base, operation: p.operation, type: p.type as ReleaseMaintenance['type'], impact: str(p.impact, 1000), note: str(p.note, 2000) }; break;
    case 'complete': case 'cancel': command = { ...base, operation: p.operation, note: str(p.note, 2000) }; break;
    case 'publish_thread': if(p.confirmed!==true||typeof p.teamId!=='string'||!/^T[A-Z0-9]+$/.test(p.teamId)||typeof p.channelId!=='string'||!/^C[A-Z0-9]+$/.test(p.channelId))fail();
      command={...base,operation:p.operation,teamId:p.teamId as string,channelId:p.channelId as string,confirmed:true};break;
    default: return fail();
  }
  exact(p, Object.keys(command));
  return command;
}
export function parseReleaseRequest(input: unknown): ReleaseRequest {
  const p = obj(input);
  if (p.action === 'command') { exact(p, ['action', 'command']); return { action: p.action, command: parseReleaseCommand(p.command) }; }
  if(p.action==='receipt'){exact(p,['action','batchId','commandId']);return {action:p.action,batchId:releaseId(p.batchId),commandId:releaseId(p.commandId)};}
  if (p.action === 'get' || p.action === 'events') { exact(p, p.action === 'get' ? ['action', 'batchId'] : ['action', 'batchId', 'page']);
    return p.action === 'get' ? { action: p.action, batchId: releaseId(p.batchId) } : { action: p.action, batchId: releaseId(p.batchId), page: integer(p.page) }; }
  if (p.action !== 'list') fail(); exact(p, ['action', 'page', 'projectId', 'search']);
  return { action: 'list', page: integer(p.page), ...(own(p, 'projectId') ? { projectId: releaseId(p.projectId) } : {}), ...(own(p, 'search') ? { search: str(p.search, 200) } : {}) };
}
export function canonicalReleaseJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalReleaseJson).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.entries(value).filter(([,v]) => v !== undefined).sort(([a],[b]) => a.localeCompare(b)).map(([k,v]) => `${JSON.stringify(k)}:${canonicalReleaseJson(v)}`).join(',')}}`;
  return JSON.stringify(value) ?? 'null';
}
export function releaseReferenceIds(batch: ReleaseManifest) { return { projectIds: [...new Set(batch.components.map(c => c.projectId))], taskIds: [...new Set(batch.components.flatMap(c => c.taskIds))] }; }
export function assertReleaseReferences(batch: ReleaseManifest, ctx: ReleaseContext) {
  if (!ctx.memberIds.has(batch.ownerId) || batch.components.some(c => !ctx.projectIds.has(c.projectId) || c.taskIds.some(id => ctx.taskProjects.get(id) !== c.projectId))) fail('release_reference_unavailable', 403);
}
export function applyReleaseCommand(before: ReleaseBatch | null, input: ReleaseCommand, ctx: ReleaseContext): ReleaseBatch {
  const command = parseReleaseCommand(input);
  if (!['admin', 'super_admin'].includes(ctx.role)) fail('release_forbidden', 403);
  if ((before && (before.id !== command.batchId || before.workspaceId !== ctx.workspaceId)) || (!before && command.operation !== 'create')) fail('release_not_found', 404);
  if ((before?.version ?? 0) !== command.expectedVersion || (before && command.operation === 'create')) fail('release_conflict', 409);
  const historyOnly=command.operation==='record_maintenance'||command.operation==='record_result'&&['rollback','recovery'].includes(command.type);
  if (before && ['completed', 'cancelled'].includes(before.status) && command.operation!=='publish_thread'&&!historyOnly) fail('release_closed', 409);
  if(command.operation==='publish_thread'&&(!ctx.slackIdentity||ctx.slackIdentity.teamId!==command.teamId))fail('release_forbidden',403);
  const next: ReleaseBatch = before ? structuredClone(before) : { ...('manifest' in command ? command.manifest : fail()), id: command.batchId, workspaceId: ctx.workspaceId,
    status: 'draft', version: 0, manifestRevision: 0, evidence: [], exceptions: [], attempts: [], maintenance: [], createdBy: ctx.actorId, createdAt: ctx.now, updatedAt: ctx.now, closureNote: null };
  if (command.operation === 'create' || command.operation === 'edit_manifest') {
    assertReleaseReferences(command.manifest, ctx);
    if (command.manifest.components.some(c => c.targets.some(t => !ctx.environments.includes(t.environment)))) fail('release_invalid_environment');
    Object.assign(next, structuredClone(command.manifest)); next.manifestRevision++;
  }
  if (['create','edit_manifest','link_evidence','start_attempt'].includes(command.operation)) assertReleaseReferences(next, ctx);
  const identity = { actorId: ctx.actorId, createdAt: ctx.now };
  if (command.operation === 'link_evidence') {
    const component = next.components.find(c => c.id === command.componentId), target = component?.targets.find(t => t.environment === command.environment);
    if (!component || !target) fail('release_reference_unavailable');
    const evidence: ReleaseEvidence = { id: ctx.newId(), revision: next.manifestRevision, componentId: command.componentId, environment: command.environment, kind: command.kind, note: command.note, url: command.url, ...identity };
    if (command.kind === 'qa') {
      const source = ctx.qaSources.get(command.issueId!), qaTarget = source?.targets.find(t => t.id === command.targetId), run = source?.runs.find(r => r.id === command.runId);
      if (!source || source.projectId !== component!.projectId || source.version !== command.issueVersion || !qaTarget || !run || run.targetId !== qaTarget.id || run.fixCycle !== source.fixCycle || qaTarget.environment !== target!.environment || qaTarget.component !== component!.name || qaTarget.build !== target!.build || run.build !== target!.build) fail('release_evidence_stale', 409);
      evidence.qa = { issueId: source!.id, issueVersion: source!.version, fixCycle: source!.fixCycle, targetId: qaTarget!.id, runId: run!.id, result: run!.result, build: run!.build };
    }
    next.evidence.push(evidence);
  } else if (command.operation === 'request_exception') next.exceptions.push({ id: ctx.newId(), revision: next.manifestRevision, scope: command.scope, reason: command.reason, requestedBy: ctx.actorId, requestedAt: ctx.now, decision: 'pending', decidedBy: null, decidedAt: null, decisionNote: null });
  else if (command.operation === 'decide_exception') {
    const item = next.exceptions.find(e => e.id === command.exceptionId);
    if (!item || item.revision !== next.manifestRevision || item.decision !== 'pending') fail('release_exception_stale', 409);
    // Whoever requested the exception never decides it, whatever their role.
    if (item!.requestedBy === ctx.actorId) fail('release_self_decision_forbidden', 403);
    Object.assign(item!, { decision: command.decision, decidedBy: ctx.actorId, decidedAt: ctx.now, decisionNote: command.note });
  } else if (command.operation === 'start_attempt') {
    if (!ctx.environments.includes(command.environment)) fail('release_invalid_environment');
    if (next.exceptions.some(e => e.revision === next.manifestRevision && e.decision !== 'approved')) fail('release_confirmation_required', 409);
    if (command.componentIds.some(id => !next.components.find(c => c.id === id)?.targets.some(t => t.environment === command.environment))) fail('release_reference_unavailable');
    next.attempts.push({ id: ctx.newId(), revision: next.manifestRevision, environment: command.environment, componentIds: command.componentIds, manifest: { title: next.title, ownerId: next.ownerId, components: structuredClone(next.components) }, note: command.note, ...identity, records: [] }); next.status = 'active';
  } else if (command.operation === 'record_result') {
    const attempt = next.attempts.find(a => a.id === command.attemptId);
    if (!attempt) fail('release_not_found', 404);
    const last = attempt!.records.at(-1)?.type;
    if ((['deployed', 'failed'].includes(command.type) && last) || (command.type === 'rollback' && !['deployed', 'failed'].includes(last ?? '')) || (command.type === 'recovery' && !['deployed', 'rollback'].includes(last ?? ''))) fail('release_invalid_transition', 409);
    attempt!.records.push({ id: ctx.newId(), type: command.type, note: command.note, url: command.url, ...identity });
  } else if (command.operation === 'record_maintenance') {
    const last = next.maintenance.at(-1)?.type;
    if ((command.type === 'start' && last === 'start') || (command.type === 'end' && last !== 'start')) fail('release_invalid_transition', 409);
    next.maintenance.push({ id: ctx.newId(), type: command.type, impact: command.impact, note: command.note, revision: next.manifestRevision, ...identity });
  } else if (command.operation === 'complete') {
    const latest = new Map<string, ReleaseAttempt>();
    for (const attempt of next.attempts.filter(a => a.revision === next.manifestRevision)) for (const componentId of attempt.componentIds) latest.set(`${componentId}:${attempt.environment}`, attempt);
    const covered = next.components.every(component => component.targets.every(target => {
      const attempt = latest.get(`${component.id}:${target.environment}`);
      return !!attempt && ['deployed', 'recovery'].includes(attempt.records.at(-1)?.type ?? '');
    }));
    if (!covered || next.maintenance.at(-1)?.type === 'start' || next.exceptions.some(e=>e.revision===next.manifestRevision&&e.decision!=='approved')) fail('release_confirmation_required', 409);
    next.status = 'completed'; next.closureNote = command.note;
  } else if (command.operation === 'cancel') { next.status = 'cancelled'; next.closureNote = command.note; }
  if (next.evidence.length > 200 || next.exceptions.length > 100 || next.attempts.length > 100 || next.maintenance.length > 100 || canonicalReleaseJson(next).length > 500000) fail('release_limit_reached', 413);
  next.version++; next.updatedAt = ctx.now;
  return next;
}
export const RELEASE_ERROR_STATUS: Record<string, number> = { release_invalid_input: 400, release_unauthorized: 401, release_forbidden: 403, release_not_found: 404, release_self_decision_forbidden: 403,
  release_reference_unavailable: 403, release_conflict: 409, release_command_reused: 409, release_closed: 409, release_invalid_environment: 400,
  release_evidence_stale: 409, release_exception_stale: 409, release_invalid_transition: 409, release_confirmation_required: 409, release_limit_reached: 413,
  release_unavailable: 503, release_transport_error: 503 };
export function releaseError(error: unknown): ReleaseError { if (error instanceof ReleaseError) return error;
  const code = (error instanceof Error ? error.message : '').match(/\brelease_[a-z_]+\b/)?.[0];
  return code && own(RELEASE_ERROR_STATUS, code) ? new ReleaseError(code, RELEASE_ERROR_STATUS[code]) : new ReleaseError('release_unavailable', 503); }
/** Reject incomplete wire payloads before callers treat a lost/partial response as a receipt. */
export function validReleaseResponse(request:ReleaseRequest,value:unknown):boolean {
 const object=(v:unknown):v is Record<string,any>=>!!v&&typeof v==='object'&&!Array.isArray(v);
 const strings=(v:unknown)=>Array.isArray(v)&&v.every(x=>typeof x==='string');
 const event=(v:unknown)=>object(v)&&typeof v.id==='string'&&typeof v.batchId==='string'&&typeof v.actorId==='string'&&typeof v.operation==='string'&&Number.isInteger(v.version)&&Number.isInteger(v.revision)&&typeof v.createdAt==='string';
 const batch=(v:unknown):boolean=>{if(!object(v)||typeof v.id!=='string'||typeof v.workspaceId!=='string'||!Number.isInteger(v.version)||v.version<1||!Number.isInteger(v.manifestRevision)||v.manifestRevision<1||!['draft','active','completed','cancelled'].includes(v.status)||typeof v.updatedAt!=='string')return false;
  try{parseReleaseManifest({title:v.title,ownerId:v.ownerId,components:v.components});}catch{return false;}
  return Array.isArray(v.evidence)&&v.evidence.every((r:unknown)=>object(r)&&['qa','uat'].includes(r.kind)&&typeof r.note==='string'&&typeof r.componentId==='string'&&typeof r.environment==='string')
   &&Array.isArray(v.exceptions)&&v.exceptions.every((r:unknown)=>object(r)&&typeof r.scope==='string'&&typeof r.reason==='string'&&['pending','approved','rejected'].includes(r.decision))
   &&Array.isArray(v.maintenance)&&v.maintenance.every((r:unknown)=>object(r)&&['start','end'].includes(r.type)&&typeof r.impact==='string'&&typeof r.note==='string')
   &&Array.isArray(v.attempts)&&v.attempts.every((r:unknown)=>{if(!object(r)||!strings(r.componentIds)||typeof r.environment!=='string'||!Array.isArray(r.records)||!r.records.every((x:unknown)=>object(x)&&typeof x.note==='string'&&['deployed','failed','rollback','recovery'].includes(x.type)))return false;try{parseReleaseManifest(r.manifest);return true;}catch{return false;}});
 };
 const result=(v:unknown,id:string,commandId:string)=>object(v)&&v.commandId===commandId&&typeof v.replayed==='boolean'&&batch(v.batch)&&v.batch.id===id&&event(v.event)&&v.event.batchId===id;
 if(request.action==='get')return batch(value)&&object(value)&&value.id===request.batchId;
 if(request.action==='command')return result(value,request.command.batchId,request.command.commandId);
 if(request.action==='receipt')return object(value)&&typeof value.found==='boolean'&&(!value.found||result(value.result,request.batchId,request.commandId));
 if(!object(value)||value.page!==request.page||typeof value.hasMore!=='boolean')return false;
 return request.action==='list'?Array.isArray(value.batches)&&value.batches.length<=8&&value.batches.every(batch):Array.isArray(value.events)&&value.events.length<=8&&value.events.every(event);
}
