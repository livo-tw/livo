/** Shared QA contract. Canonical source copied to both backend runtimes. */
import { DEFAULT_DEPLOYMENT_ENVIRONMENTS } from './environments.ts';
import { validateQaCustomFieldValues, QaFieldError, DEFAULT_QA_FIELD_CONFIGURATION, type QaCustomFieldValues, type QaFieldConfiguration } from './fields.ts';
export type QaState = 'new' | 'triaged' | 'in_progress' | 'verification' | 'verified' | 'failed' | 'closed' | 'dismissed';
export type QaSeverity = 'untriaged' | 'low' | 'medium' | 'high';
export type QaResult = 'pass' | 'fail' | 'blocked';
export type QaResolution = 'fixed' | 'duplicate' | 'not_bug' | 'wont_fix' | 'cannot_reproduce';
export interface QaTarget {
  id: string; environment: string; component: string; build: string; required: boolean;
  deployedAt: string | null; deployedBy: string | null; deploymentEvidence: string;
}
export interface QaRun {
  id: string; sequence: number; fixCycle: number; targetId: string; environment: string;
  component: string; build: string; result: QaResult; note: string; testerId: string; createdAt: string;
}
export interface QaCoordination { projectId: string; coordinatorId: string | null; version: number; }
export interface QaHandoff {
  id: string; reason: string; nextOwnerId: string; replyBy: string | null; externalDependency: string;
  requestedBy: string; requestedAt: string; acceptedBy: string | null; acceptedAt: string | null;
  resolvedBy: string | null; resolvedAt: string | null; resolutionEvidence: string;
}
export interface QaIssue {
  id: string; workspaceId: string; projectId: string; title: string; steps: string; expected: string;
  actual: string; observedEnvironment: string; observedVersion: string; component: string;
  reporterId: string; assigneeId: string | null; qaOwnerId: string | null;
  severity: QaSeverity; priority: number; dueDate: string | null; state: QaState;
  resolution: QaResolution | null; resolutionReason: string; duplicateOfId: string | null;
  fixCycle: number; version: number; fixSummary: string;
  /** What blocks the bug now; empty when nothing does. Cleared by a new fix or a reopen. */
  holdReason: string;
  /** Why the bug was last reopened. Records reopened before this field existed kept it in holdReason. */
  reopenReason?: string;
  targets: QaTarget[]; runs: QaRun[]; taskIds: string[];
  handoff?: QaHandoff | null;
  createdAt: string; updatedAt: string; closedAt: string | null; reopenedAt: string | null;
  /** Actual closing actor. Optional for records saved before this field existed. */
  closedBy?: string | null;
  customFields?: QaCustomFieldValues;
  /** Preserved by privileged historical restore only; never accepted by create/edit. */
  legacySource?: { system: string; originalStatus: string; recordId: string; snapshotSha256: string; [key: string]: unknown };
}
export interface QaCreateInput {
  projectId: string; title: string; actual: string; observedEnvironment: string;
  customFields?: QaCustomFieldValues;
  observedVersion?: string; steps?: string; expected?: string; component?: string; severity?: QaSeverity;
}
export type QaCommand =
  | { type: 'set_state'; state: QaState }
  | { type: 'edit'; customFields?: QaCustomFieldValues; title: string; actual: string; steps: string; expected: string; observedEnvironment: string; observedVersion: string; component: string }
  | { type: 'triage'; assigneeId: string; qaOwnerId: string; severity: QaSeverity; priority: number; dueDate: string | null }
  | { type: 'start_fix' }
  | { type: 'submit_fix'; summary: string; targets: Array<Pick<QaTarget, 'environment' | 'component' | 'build' | 'required'>> }
  | { type: 'record_deployment'; targetId: string; build: string; evidence: string }
  | { type: 'record_verification'; targetId: string; build: string; result: QaResult; note: string }
  | { type: 'close'; resolution: QaResolution; reason: string; duplicateOfId?: string; acknowledgeHistoricalPass?: boolean }
  | { type: 'reopen'; reason: string }
  | { type: 'hold'; reason: string }
  | { type: 'request_handoff'; reason: string; nextOwnerId: string; replyBy: string | null; externalDependency: string }
  | { type: 'accept_handoff'; handoffId: string }
  | { type: 'resolve_handoff'; handoffId: string; evidence: string }
  | { type: 'link_tasks'; taskIds: string[] };
export interface QaActor { id: string; role: string; qaCoordinatorProjectIds?: readonly string[]; qaAdmin?: boolean; }
export interface QaContext {
  actor: QaActor; workspaceId: string; now: string; newId: () => string;
  /** Trusted same-workspace, active entities resolved by the backend. */
  memberIds: ReadonlySet<string>; projectIds: ReadonlySet<string>; taskIds: ReadonlySet<string>;
  duplicateIssueIds?: ReadonlySet<string>;
  environmentValues?: readonly string[];
  fieldConfiguration?: QaFieldConfiguration;
}
export interface QaComment { id: string; issueId: string; actorId: string; body: string; createdAt: string; }
export interface QaEvent { id: string; issueId: string; actorId: string; type: string; detail: string; createdAt: string; version: number; }
export interface QaAttachment { id: string; issueId: string; fileName: string; mimeType: string; size: number; uploadedBy: string; createdAt: string; }
export interface QaDetail { memberNames?: Record<string,string>; coordination?: QaCoordination; issue: QaIssue; comments: QaComment[]; events: QaEvent[]; attachments: QaAttachment[]; }
/** Board sort keys shared with the task board (src/lib/boardSort.ts); 'updated' is the default. */
export type QaSortField = 'updated' | 'priority' | 'dueDate' | 'createdAt';
export type QaSortDirection = 'asc' | 'desc';
export interface QaListInput {
  projectId?: string; state?: QaState; states?: QaState[]; search?: string; mine?: 'assigned' | 'testing' | 'reported' | 'involved' | 'handoff'; offset?: number; limit?: number;
  projectIds?: string[]; assigneeIds?: string[]; qaOwnerIds?: string[]; reporterIds?: string[];
  /** 1 (highest) to 5 (lowest), the stored QA priority. */
  priorities?: number[]; severities?: QaSeverity[];
  sort?: QaSortField; direction?: QaSortDirection;
}
export interface QaListResult { issues: QaIssue[]; total: number; hasMore: boolean; }
export interface QaUpload { id: string; provider: 'r2' | 'supabase'; partSize: number; bucket?: string; path?: string; token?: string; }
export class QaError extends Error {
  constructor(public readonly code: string, public readonly status = 400) { super(code); this.name = 'QaError'; }
}
export const QA_MAX_FILE_BYTES = 200 * 1024 * 1024;
export const QA_PART_BYTES = 5 * 1024 * 1024;
export const QA_STATES: QaState[] = ['new', 'triaged', 'in_progress', 'verification', 'verified', 'failed', 'closed', 'dismissed'];
export const isQaTerminal = (state: QaState) => state === 'closed' || state === 'dismissed';
export const QA_SEVERITIES: QaSeverity[] = ['untriaged', 'low', 'medium', 'high'];
export const QA_SORT_FIELDS: QaSortField[] = ['updated', 'priority', 'dueDate', 'createdAt'];
/** Natural first direction: newest, most important, or earliest due first. */
export const qaDefaultSortDirection = (field: QaSortField): QaSortDirection => field === 'dueDate' ? 'asc' : 'desc';
export interface QaListFilters {
  projectIds?: string[]; assigneeIds?: string[]; qaOwnerIds?: string[]; reporterIds?: string[];
  priorities?: number[]; severities?: QaSeverity[]; sort: QaSortField; direction: QaSortDirection;
}
const QA_FILTER_MAX = 200;

/**
 * Validates the list filters every backend applies the same way. Each id goes
 * through the runtime's own id check. An empty list is rejected: "match
 * nothing" and "no filter" must not be confused.
 */
/**
 * A search for a bug id rather than title words: the short id shown on cards
 * ("#1a2b3c4d", any part after the #) or a full id. Returns the id part to
 * match, or null for an ordinary title search. Both servers and the demo use it.
 */
export function qaIdSearch(search: string | undefined): string | null {
  const value = (search ?? '').trim();
  const short = /^#([0-9A-Za-z_-]{1,64})$/.exec(value);
  if (short) return short[1];
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value) ? value : null;
}

export function normalizeQaListFilters(input: QaListInput, id: (value: unknown) => string): QaListFilters {
  const list = <T>(value: unknown, item: (entry: unknown) => T): T[] | undefined => {
    if (value === undefined) return undefined;
    if (!Array.isArray(value) || !value.length || value.length > QA_FILTER_MAX) return fail('qa_invalid_filter');
    const items = value.map(item);
    if (new Set(items).size !== items.length) return fail('qa_invalid_filter');
    return items;
  };
  const sort = input.sort === undefined ? 'updated' : input.sort;
  if (!QA_SORT_FIELDS.includes(sort)) return fail('qa_invalid_filter');
  const direction = input.direction === undefined ? qaDefaultSortDirection(sort) : input.direction;
  if (direction !== 'asc' && direction !== 'desc') return fail('qa_invalid_filter');
  return {
    projectIds: list(input.projectIds, id), assigneeIds: list(input.assigneeIds, id),
    qaOwnerIds: list(input.qaOwnerIds, id), reporterIds: list(input.reporterIds, id),
    priorities: list(input.priorities, value => Number.isInteger(value) && (value as number) >= 1 && (value as number) <= 5 ? value as number : fail('qa_invalid_filter')),
    severities: list(input.severities, value => QA_SEVERITIES.includes(value as QaSeverity) ? value as QaSeverity : fail('qa_invalid_filter')),
    sort, direction,
  };
}

export function matchesQaListFilters(issue: QaIssue, filters: QaListFilters): boolean {
  return (!filters.projectIds || filters.projectIds.includes(issue.projectId))
    && (!filters.assigneeIds || (!!issue.assigneeId && filters.assigneeIds.includes(issue.assigneeId)))
    && (!filters.qaOwnerIds || (!!issue.qaOwnerId && filters.qaOwnerIds.includes(issue.qaOwnerId)))
    && (!filters.reporterIds || filters.reporterIds.includes(issue.reporterId))
    && (!filters.priorities || filters.priorities.includes(issue.priority))
    && (!filters.severities || filters.severities.includes(issue.severity));
}

/**
 * Reference order for QA lists; D1 and PostgreSQL must return the same order.
 * Priority "desc" lists the most important (priority 1) first. Issues without a
 * due date stay last in both directions. Ties: most recently updated, then id.
 */
export function compareQaIssues(a: QaIssue, b: QaIssue, sort: QaSortField, direction: QaSortDirection): number {
  const sign = direction === 'asc' ? 1 : -1;
  const text = (left: string, right: string) => left < right ? -1 : left > right ? 1 : 0;
  const tie = () => text(b.updatedAt, a.updatedAt) || text(a.id, b.id);
  if (sort === 'updated') return sign * text(a.updatedAt, b.updatedAt) || text(a.id, b.id);
  if (sort === 'priority') return -sign * (a.priority - b.priority) || tie();
  if (sort === 'createdAt') return sign * text(a.createdAt, b.createdAt) || tie();
  if (!a.dueDate || !b.dueDate) return Number(!a.dueDate) - Number(!b.dueDate) || tie();
  return sign * text(a.dueDate, b.dueDate) || tie();
}

/** A historical PASS is source evidence, not a fabricated LIVO verification run. */
export function isHistoricalQaPass(issue: QaIssue): boolean {
  const source = issue.legacySource;
  return issue.state === 'verified' && issue.fixCycle === 0 && issue.targets.length === 0 && issue.runs.length === 0
    && source?.system === 'slack_list' && source.originalStatus === 'PASS'
    && /^Rec[A-Z0-9]+$/.test(source.recordId) && /^[a-f0-9]{64}$/i.test(source.snapshotSha256);
}

const admin = (actor: QaActor) => actor.role === 'admin' || actor.role === 'super_admin';
const fail = (code: string, status = 400): never => { throw new QaError(code, status); };
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return fail('qa_invalid_request');
  return value as Record<string, unknown>;
}
function keys(value: object, allowed: string[]) {
  if (Object.keys(value).some(key => !allowed.includes(key))) fail('qa_invalid_request');
}
function str(value: unknown, max = 20000, required = false): string {
  if (typeof value !== 'string' || value.length > max || value.includes('\u0000')) return fail('qa_invalid_text');
  const text = value.trim();
  if (required && !text) return fail('qa_required');
  return text;
}
function id(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,99}$/.test(value)) return fail('qa_invalid_id');
  return value;
}
function enumValue<T extends string>(value: unknown, values: readonly T[]): T {
  if (typeof value !== 'string' || !values.includes(value as T)) return fail('qa_invalid_value');
  return value as T;
}
function member(value: unknown, ctx: QaContext) {
  const memberId = id(value);
  if (!ctx.memberIds.has(memberId)) return fail('qa_member_unavailable');
  return memberId;
}
function validContext(ctx: QaContext) {
  if (!ctx.actor.id || !ctx.memberIds.has(ctx.actor.id)) fail('qa_forbidden', 403);
  if (!Number.isFinite(Date.parse(ctx.now))) fail('qa_invalid_time');
}
function activeEnvironment(value: string, ctx: QaContext): string {
  if (!(ctx.environmentValues ?? DEFAULT_DEPLOYMENT_ENVIRONMENTS).includes(value)) return fail('qa_invalid_environment');
  return value;
}

/** Restore preserves evidence verbatim; malformed or invented partial shapes fail closed. */
export function validateQaHandoff(value: unknown): QaHandoff | null | undefined {
  if(value===undefined)return undefined;
  if(value===null)return null;
  const h=record(value);keys(h,['id','reason','nextOwnerId','replyBy','externalDependency','requestedBy','requestedAt','acceptedBy','acceptedAt','resolvedBy','resolvedAt','resolutionEvidence']);
  for(const key of ['id','nextOwnerId','requestedBy'])id(h[key]);
  str(h.reason,8000,true);str(h.externalDependency,2000);str(h.resolutionEvidence,8000);
  for(const key of ['replyBy','requestedAt','acceptedAt','resolvedAt']){
    const v=h[key];if(v===null&&key!=='requestedAt')continue;
    if(typeof v!=='string'||!Number.isFinite(Date.parse(v))||new Date(v).toISOString()!==v)fail('qa_invalid_date');
  }
  for(const [person,stamp] of [['acceptedBy','acceptedAt'],['resolvedBy','resolvedAt']]){
    if((h[person]===null)!==(h[stamp]===null))fail('qa_invalid_request');if(h[person]!==null)id(h[person]);
  }
  if(h.acceptedBy!==null&&h.acceptedBy!==h.nextOwnerId)fail('qa_invalid_request');
  if(h.resolvedAt!==null&&!String(h.resolutionEvidence).trim())fail('qa_required');
  return h as unknown as QaHandoff;
}

function customFields(value: unknown, ctx: QaContext, previous?: QaCustomFieldValues): QaCustomFieldValues {
  try { return validateQaCustomFieldValues(value, ctx.fieldConfiguration ?? DEFAULT_QA_FIELD_CONFIGURATION, previous); }
  catch (error) { if (error instanceof QaFieldError) return fail(error.code); throw error; }
}

/** Permissions are checked again inside both server adapters; UI is advisory. */
export function canQaCommand(issue: QaIssue, actor: QaActor, type: QaCommand['type']): boolean {
  const lead = admin(actor) || issue.qaOwnerId === actor.id;
  const developer = admin(actor) || issue.assigneeId === actor.id;
  const participant = lead || developer || issue.reporterId === actor.id;
  const coordinator = actor.qaCoordinatorProjectIds?.includes(issue.projectId) === true;
  // Status editing uses the existing participant scope, including completed issues.
  if (type === 'set_state') return participant;
  if (type === 'reopen') return participant && (isQaTerminal(issue.state) || ['verification', 'verified'].includes(issue.state));
  if (isQaTerminal(issue.state)) return false;
  switch (type) {
    // Any active member may set or change the owners of an open bug (team decision, 2026-10).
    case 'triage': return true;
    case 'request_handoff': return participant || coordinator;
    case 'accept_handoff': return !!issue.handoff && !issue.handoff.resolvedAt && !issue.handoff.acceptedAt && issue.handoff.nextOwnerId === actor.id;
    case 'resolve_handoff': return !!issue.handoff && !issue.handoff.resolvedAt && (admin(actor) || issue.handoff.nextOwnerId === actor.id);
    case 'start_fix': return developer && ['triaged', 'in_progress', 'failed'].includes(issue.state);
    case 'submit_fix': return developer && ['triaged', 'in_progress', 'verification', 'verified', 'failed'].includes(issue.state);
    case 'record_deployment': return (developer || lead) && ['verification', 'verified'].includes(issue.state);
    case 'record_verification': return lead && ['verification', 'verified'].includes(issue.state);
    case 'close': return lead;
    case 'link_tasks': return lead || developer;
    case 'hold': return participant || coordinator;
    case 'edit': return participant;
    default: return false;
  }
}

/**
 * Comments are open to every active member, on any state including closed bugs,
 * like task comments. Both servers only build an actor for an active member, so
 * Slack thread replies from anyone on the team are kept rather than dropped.
 */
export function canQaComment(_issue: QaIssue, actor: QaActor): boolean {
  return typeof actor.id === 'string' && actor.id.length > 0;
}

export function createQaIssue(input: QaCreateInput, issueId: string, ctx: QaContext): QaIssue {
  validContext(ctx);
  record(input);
  keys(input, ['projectId', 'title', 'actual', 'observedEnvironment', 'observedVersion', 'steps', 'expected', 'component', 'severity', 'customFields']);
  const projectId = id(input.projectId);
  if (!ctx.projectIds.has(projectId)) return fail('qa_project_unavailable');
  return {
    id: id(issueId), workspaceId: ctx.workspaceId, projectId,
    title: str(input.title, 200, true), actual: str(input.actual, 20000, true),
    steps: str(input.steps ?? ''), expected: str(input.expected ?? ''),
    observedEnvironment: activeEnvironment(str(input.observedEnvironment, 120, true), ctx), observedVersion: str(input.observedVersion ?? '', 200),
    component: str(input.component ?? '', 120), reporterId: ctx.actor.id, assigneeId: null, qaOwnerId: null,
    severity: enumValue(input.severity ?? 'untriaged', ['untriaged', 'low', 'medium', 'high']),
    customFields: customFields(input.customFields, ctx),
    priority: 3, dueDate: null, state: 'new', resolution: null, resolutionReason: '', duplicateOfId: null,
    fixCycle: 0, version: 1, fixSummary: '', holdReason: '', targets: [], runs: [], taskIds: [],
    createdAt: ctx.now, updatedAt: ctx.now, closedAt: null, reopenedAt: null,
  };
}

export function latestQaRun(issue: QaIssue, targetId: string): QaRun | undefined {
  return issue.runs.filter(run => run.fixCycle === issue.fixCycle && run.targetId === targetId)
    .reduce<QaRun | undefined>((latest, run) => !latest || run.sequence > latest.sequence ? run : latest, undefined);
}

export function requiredTargetsPassed(issue: QaIssue): boolean {
  const required = issue.targets.filter(target => target.required);
  return required.length > 0 && required.every(target => {
    const run = latestQaRun(issue, target.id);
    return !!target.deployedAt && run?.result === 'pass' && run.build === target.build;
  });
}

/** Each candidate is immutable. A new build requires submit_fix, never a target edit. */
export function applyQaCommand(issue: QaIssue, command: QaCommand, ctx: QaContext): QaIssue {
  validContext(ctx);
  record(command);
  if (issue.workspaceId !== ctx.workspaceId || !ctx.projectIds.has(issue.projectId)) return fail('qa_forbidden', 403);
  if (!canQaCommand(issue, ctx.actor, command.type)) return fail('qa_forbidden', 403);
  const next: QaIssue = { ...issue, targets: issue.targets.map(target => ({ ...target })), runs: [...issue.runs], taskIds: [...issue.taskIds], version: issue.version + 1, updatedAt: ctx.now };
  switch (command.type) {
    case 'set_state': {
      keys(command, ['type', 'state']);
      const state = enumValue(command.state, QA_STATES);
      if (state === issue.state) break;
      next.state = state;
      next.resolution = null; next.resolutionReason = ''; next.duplicateOfId = null;
      next.closedAt = isQaTerminal(state) ? ctx.now : null;
      next.closedBy = isQaTerminal(state) ? ctx.actor.id : null;
      if (isQaTerminal(issue.state) && !isQaTerminal(state)) next.reopenedAt = ctx.now;
      break;
    }
    case 'edit': {
      keys(command, ['type', 'title', 'actual', 'steps', 'expected', 'observedEnvironment', 'observedVersion', 'component', 'customFields']);
      next.customFields = customFields(command.customFields, ctx, issue.customFields);
      next.title = str(command.title, 200, true); next.actual = str(command.actual, 20000, true);
      next.steps = str(command.steps); next.expected = str(command.expected);
      next.observedEnvironment = str(command.observedEnvironment, 120, true);
      if (next.observedEnvironment !== issue.observedEnvironment) activeEnvironment(next.observedEnvironment, ctx);
      next.observedVersion = str(command.observedVersion, 200); next.component = str(command.component, 120);
      break;
    }
    case 'triage': {
      keys(command, ['type', 'assigneeId', 'qaOwnerId', 'severity', 'priority', 'dueDate']);
      next.assigneeId = member(command.assigneeId, ctx); next.qaOwnerId = member(command.qaOwnerId, ctx);
      next.severity = enumValue(command.severity, ['low', 'medium', 'high']);
      if (!Number.isInteger(command.priority) || command.priority < 1 || command.priority > 5) return fail('qa_invalid_priority');
      next.priority = command.priority;
      if (next.legacySource?.priorityMeaning === 'LIVO default 3; source has severity only')
        next.legacySource = { ...next.legacySource, priorityMeaning: 'LIVO triage selected priority' };
      if (command.dueDate !== null && (typeof command.dueDate !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(command.dueDate) || !Number.isFinite(Date.parse(command.dueDate)) || new Date(command.dueDate).toISOString().slice(0, 10) !== command.dueDate)) return fail('qa_invalid_date');
      next.dueDate = command.dueDate;
      if (issue.state === 'new') next.state = 'triaged';
      break;
    }
    case 'start_fix':
      keys(command, ['type']); next.state = 'in_progress'; break;
    case 'submit_fix': {
      keys(command, ['type', 'summary', 'targets']);
      next.fixSummary = str(command.summary, 8000, true);
      if (!issue.assigneeId || !issue.qaOwnerId || !ctx.memberIds.has(issue.assigneeId) || !ctx.memberIds.has(issue.qaOwnerId)) return fail('qa_triage_required');
      if (!Array.isArray(command.targets) || !command.targets.length || command.targets.length > 30) return fail('qa_targets_required');
      const seen = new Set<string>();
      next.targets = command.targets.map((raw): QaTarget => {
        record(raw); keys(raw, ['environment', 'component', 'build', 'required']);
        const environment = str(raw.environment, 120, true), component = str(raw.component, 120), build = str(raw.build, 200, true);
        activeEnvironment(environment, ctx);
        const key = JSON.stringify([environment, component.toLowerCase()]);
        if (seen.has(key) || typeof raw.required !== 'boolean') return fail('qa_invalid_target');
        seen.add(key);
        return { id: ctx.newId(), environment, component, build, required: raw.required, deployedAt: null, deployedBy: null, deploymentEvidence: '' };
      });
      if (!next.targets.some(target => target.required)) return fail('qa_required_target');
      next.fixCycle++; next.state = 'verification'; next.holdReason = '';
      break;
    }
    case 'record_deployment': {
      keys(command, ['type', 'targetId', 'build', 'evidence']);
      const target = next.targets.find(item => item.id === command.targetId);
      if (!target || str(command.build, 200, true) !== target.build) return fail('qa_build_mismatch', 409);
      target.deploymentEvidence = str(command.evidence, 8000, true); target.deployedBy = ctx.actor.id; target.deployedAt = ctx.now;
      break;
    }
    case 'record_verification': {
      keys(command, ['type', 'targetId', 'build', 'result', 'note']);
      const target = next.targets.find(item => item.id === command.targetId);
      if (!target || str(command.build, 200, true) !== target.build) return fail('qa_build_mismatch', 409);
      if (!target.deployedAt) return fail('qa_not_deployed');
      if (issue.runs.length >= 2000) return fail('qa_history_limit');
      const result = enumValue(command.result, ['pass', 'fail', 'blocked']);
      const note = str(command.note, 8000, result !== 'pass');
      next.runs.push({ id: ctx.newId(), sequence: issue.runs.reduce((seq, run) => Math.max(seq, run.sequence), 0) + 1,
        fixCycle: issue.fixCycle, targetId: target.id, environment: target.environment, component: target.component,
        build: target.build, result, note, testerId: ctx.actor.id, createdAt: ctx.now });
      if (result === 'fail') { next.state = 'failed'; next.reopenedAt = ctx.now; }
      else next.state = requiredTargetsPassed(next) ? 'verified' : 'verification';
      break;
    }
    case 'close': {
      keys(command, ['type', 'resolution', 'reason', 'duplicateOfId', 'acknowledgeHistoricalPass']);
      const resolution = enumValue(command.resolution, ['fixed', 'duplicate', 'not_bug', 'wont_fix', 'cannot_reproduce']);
      if (command.acknowledgeHistoricalPass !== undefined && typeof command.acknowledgeHistoricalPass !== 'boolean') return fail('qa_invalid_request');
      const historical = command.acknowledgeHistoricalPass === true;
      if (historical && (resolution !== 'fixed' || !isHistoricalQaPass(issue))) return fail('qa_historical_pass_unavailable');
      if (resolution === 'fixed') {
        // Before verified existed, a fully passing candidate remained verification.
        // Permit that saved shape only with the same complete, current real evidence.
        if (!historical && (!['verified', 'verification'].includes(issue.state) || !requiredTargetsPassed(issue))) return fail('qa_verification_required');
      }
      next.resolutionReason = str(command.reason, 8000, resolution !== 'fixed' || historical);
      if (resolution === 'duplicate') {
        const duplicate = id(command.duplicateOfId);
        if (duplicate === issue.id || !ctx.duplicateIssueIds?.has(duplicate)) return fail('qa_duplicate_unavailable');
        next.duplicateOfId = duplicate;
      } else {
        if (command.duplicateOfId) return fail('qa_invalid_request');
        next.duplicateOfId = null;
      }
      next.state = resolution === 'fixed' ? 'closed' : 'dismissed'; next.resolution = resolution; next.closedAt = ctx.now; next.closedBy = ctx.actor.id;
      break;
    }
    case 'reopen':
      keys(command, ['type', 'reason']); next.reopenReason = str(command.reason, 8000, true); next.holdReason = '';
      next.state = issue.assigneeId ? 'in_progress' : 'new'; next.resolution = null; next.resolutionReason = '';
      next.duplicateOfId = null; next.closedAt = null; next.closedBy = null; next.reopenedAt = ctx.now; break;
    case 'hold':
      keys(command, ['type', 'reason']); next.holdReason = str(command.reason, 8000); break;
    case 'request_handoff': {
      keys(command, ['type', 'reason', 'nextOwnerId', 'replyBy', 'externalDependency']);
      const replyBy = command.replyBy;
      if (replyBy !== null && (typeof replyBy !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(replyBy) || !Number.isFinite(Date.parse(replyBy)) || new Date(replyBy).toISOString() !== replyBy)) return fail('qa_invalid_date');
      next.handoff = { id: ctx.newId(), reason: str(command.reason, 8000, true), nextOwnerId: member(command.nextOwnerId, ctx),
        replyBy, externalDependency: str(command.externalDependency, 2000), requestedBy: ctx.actor.id, requestedAt: ctx.now,
        acceptedBy: null, acceptedAt: null, resolvedBy: null, resolvedAt: null, resolutionEvidence: '' };
      break;
    }
    case 'accept_handoff': case 'resolve_handoff': {
      keys(command, command.type === 'accept_handoff' ? ['type','handoffId'] : ['type','handoffId','evidence']);
      if (!issue.handoff || id(command.handoffId) !== issue.handoff.id) return fail('qa_handoff_conflict', 409);
      next.handoff = command.type === 'accept_handoff'
        ? { ...issue.handoff, acceptedBy: ctx.actor.id, acceptedAt: ctx.now }
        : { ...issue.handoff, resolvedBy: ctx.actor.id, resolvedAt: ctx.now, resolutionEvidence: str(command.evidence, 8000, true) };
      break;
    }
    case 'link_tasks': {
      keys(command, ['type', 'taskIds']);
      if (!Array.isArray(command.taskIds) || command.taskIds.length > 50) return fail('qa_invalid_tasks');
      const ids = command.taskIds.map(id);
      if (new Set(ids).size !== ids.length || ids.some(task => !ctx.taskIds.has(task))) return fail('qa_task_unavailable');
      next.taskIds = ids; break;
    }
    default: return fail('qa_invalid_command');
  }
  // D1 rows are bounded; never silently discard old attempts to make room.
  // The command receipt also stores the aggregate and result in one D1 row.
  if (new TextEncoder().encode(JSON.stringify(next)).byteLength > 650000) return fail('qa_history_limit');
  return next;
}

/** Immutable audit snapshots survive replacement of the current fix targets. */
export function qaEventDetail(issue: QaIssue, type: string, before?: QaIssue | null): string {
  if (type === 'set_state') return JSON.stringify({ message: '狀態已變更', mode: 'manual', from: before?.state ?? null, to: issue.state });
  const target = (item: QaTarget) => `${item.environment} · ${item.component || '-'} · ${item.build} · ${item.required ? '必要' : '選填'}`;
  if (type === 'submit_fix') return `修復輪次 ${issue.fixCycle}\n${issue.fixSummary}\n${issue.targets.map(target).join('\n')}`;
  if (type === 'record_deployment') return issue.targets.filter(item => item.deployedAt).map(item =>
    `${target(item)}\n${item.deployedAt} · ${item.deployedBy}\n${item.deploymentEvidence}`).join('\n\n');
  if (type === 'record_verification') {
    const run = issue.runs[issue.runs.length - 1];
    return run ? `第 ${run.fixCycle} 輪 · 第 ${run.sequence} 次驗證\n${run.environment} · ${run.component || '-'} · ${run.build}\n${run.result.toUpperCase()}\n${run.note}` : '';
  }
  if (type === 'close') return `${issue.resolution}\n${issue.resolution === 'fixed' && issue.fixCycle === 0 && issue.legacySource?.originalStatus === 'PASS' ? '依既有歷史 PASS 證據明確結案；未新增 LIVO 驗證紀錄。\n' : ''}${issue.resolutionReason}${issue.duplicateOfId ? '\n' + issue.duplicateOfId : ''}`;
  if (['request_handoff','accept_handoff','resolve_handoff'].includes(type) && issue.handoff) {
    const h = issue.handoff;
    return JSON.stringify({ handoffId:h.id,reason:h.reason,nextOwnerId:h.nextOwnerId,replyBy:h.replyBy,externalDependency:h.externalDependency,
      requestedBy:h.requestedBy,requestedAt:h.requestedAt,acceptedBy:h.acceptedBy,acceptedAt:h.acceptedAt,resolvedBy:h.resolvedBy,resolvedAt:h.resolvedAt,resolutionEvidence:h.resolutionEvidence });
  }
  if (type === 'hold') return issue.holdReason;
  if (type === 'reopen') return issue.reopenReason ?? issue.holdReason;
  if (type === 'triage') return `RD: ${issue.assigneeId} · QA: ${issue.qaOwnerId}\n${issue.severity} · P${issue.priority}${issue.dueDate ? '\n' + issue.dueDate : ''}`;
  if (type === 'link_tasks') return issue.taskIds.join('\n');
  if (type === 'edit' || type === 'create' || type === 'created') return `${issue.title}\n${issue.observedEnvironment} · ${issue.observedVersion || '版本未知'}\n${issue.actual}\n${issue.steps}\n${issue.expected}`;
  return '';
}

/**
 * Who hears about a committed change, on both servers. Notifications come from
 * committed transitions, never from UI guesses, and never go to the actor.
 * A new bug goes to `triagers`, which only the server knows: the project's QA
 * coordinator, or the workspace admins when the project has none.
 */
export function qaNotificationRecipients(issue: QaIssue, type: QaCommand['type'] | 'create' | 'comment', actorId: string, triagers: readonly string[] = []): string[] {
  const everyone = [issue.reporterId, issue.assigneeId, issue.qaOwnerId];
  const ids = type === 'create' ? [...triagers]
    : type === 'request_handoff' ? [issue.handoff?.nextOwnerId]
    : type === 'accept_handoff' || type === 'resolve_handoff' ? [issue.handoff?.requestedBy, issue.assigneeId, issue.qaOwnerId]
    : type === 'set_state' || type === 'comment' || type === 'close' ? everyone
    : type === 'record_deployment' || type === 'submit_fix' ? [issue.qaOwnerId]
    // Starting work or linking tasks changes nothing anyone else has to act on.
    : type === 'start_fix' || type === 'link_tasks' ? []
    // triage, record_verification, reopen, hold, edit: the people working on the bug.
    : [issue.assigneeId, issue.qaOwnerId];
  return [...new Set(ids.filter((value): value is string => !!value && value !== actorId))];
}
