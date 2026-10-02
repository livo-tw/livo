/** Shared QA contract. Canonical source copied to both backend runtimes. */
export type QaState = 'new' | 'triaged' | 'in_progress' | 'verification' | 'closed';
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
export interface QaIssue {
  id: string; workspaceId: string; projectId: string; title: string; steps: string; expected: string;
  actual: string; observedEnvironment: string; observedVersion: string; component: string;
  reporterId: string; assigneeId: string | null; qaOwnerId: string | null;
  severity: QaSeverity; priority: number; dueDate: string | null; state: QaState;
  resolution: QaResolution | null; resolutionReason: string; duplicateOfId: string | null;
  fixCycle: number; version: number; fixSummary: string; holdReason: string;
  targets: QaTarget[]; runs: QaRun[]; taskIds: string[];
  createdAt: string; updatedAt: string; closedAt: string | null; reopenedAt: string | null;
}
export interface QaCreateInput {
  projectId: string; title: string; actual: string; observedEnvironment: string;
  observedVersion?: string; steps?: string; expected?: string; component?: string; severity?: QaSeverity;
}
export type QaCommand =
  | { type: 'edit'; title: string; actual: string; steps: string; expected: string; observedEnvironment: string; observedVersion: string; component: string }
  | { type: 'triage'; assigneeId: string; qaOwnerId: string; severity: QaSeverity; priority: number; dueDate: string | null }
  | { type: 'start_fix' }
  | { type: 'submit_fix'; summary: string; targets: Array<Pick<QaTarget, 'environment' | 'component' | 'build' | 'required'>> }
  | { type: 'record_deployment'; targetId: string; build: string; evidence: string }
  | { type: 'record_verification'; targetId: string; build: string; result: QaResult; note: string }
  | { type: 'close'; resolution: QaResolution; reason: string; duplicateOfId?: string }
  | { type: 'reopen'; reason: string }
  | { type: 'hold'; reason: string }
  | { type: 'link_tasks'; taskIds: string[] };
export interface QaActor { id: string; role: string; }
export interface QaContext {
  actor: QaActor; workspaceId: string; now: string; newId: () => string;
  /** Trusted same-workspace, active entities resolved by the backend. */
  memberIds: ReadonlySet<string>; projectIds: ReadonlySet<string>; taskIds: ReadonlySet<string>;
  duplicateIssueIds?: ReadonlySet<string>;
}
export interface QaComment { id: string; issueId: string; actorId: string; body: string; createdAt: string; }
export interface QaEvent { id: string; issueId: string; actorId: string; type: string; detail: string; createdAt: string; version: number; }
export interface QaAttachment { id: string; issueId: string; fileName: string; mimeType: string; size: number; uploadedBy: string; createdAt: string; }
export interface QaDetail { issue: QaIssue; comments: QaComment[]; events: QaEvent[]; attachments: QaAttachment[]; }
export interface QaListInput { projectId?: string; state?: QaState; search?: string; mine?: 'assigned' | 'testing' | 'reported'; offset?: number; limit?: number; }
export interface QaListResult { issues: QaIssue[]; total: number; hasMore: boolean; }
export interface QaUpload { id: string; provider: 'r2' | 'supabase'; partSize: number; bucket?: string; path?: string; token?: string; }
export class QaError extends Error {
  constructor(public readonly code: string, public readonly status = 400) { super(code); this.name = 'QaError'; }
}
export const QA_MAX_FILE_BYTES = 200 * 1024 * 1024;
export const QA_PART_BYTES = 5 * 1024 * 1024;
export const QA_STATES: QaState[] = ['new', 'triaged', 'in_progress', 'verification', 'closed'];

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

/** Permissions are checked again inside both server adapters; UI is advisory. */
export function canQaCommand(issue: QaIssue, actor: QaActor, type: QaCommand['type']): boolean {
  const lead = admin(actor) || issue.qaOwnerId === actor.id;
  const developer = admin(actor) || issue.assigneeId === actor.id;
  const participant = lead || developer || issue.reporterId === actor.id;
  if (type === 'reopen') return participant && (issue.state === 'closed' || issue.state === 'verification');
  if (issue.state === 'closed') return false;
  switch (type) {
    case 'triage': return lead;
    case 'start_fix': return developer && ['triaged', 'in_progress'].includes(issue.state);
    case 'submit_fix': return developer && ['triaged', 'in_progress', 'verification'].includes(issue.state);
    case 'record_deployment': return (developer || lead) && issue.state === 'verification';
    case 'record_verification': return lead && issue.state === 'verification';
    case 'close': return lead;
    case 'link_tasks': return lead || developer;
    case 'edit': case 'hold': return participant;
    default: return false;
  }
}

export function createQaIssue(input: QaCreateInput, issueId: string, ctx: QaContext): QaIssue {
  validContext(ctx);
  record(input);
  keys(input, ['projectId', 'title', 'actual', 'observedEnvironment', 'observedVersion', 'steps', 'expected', 'component', 'severity']);
  const projectId = id(input.projectId);
  if (!ctx.projectIds.has(projectId)) return fail('qa_project_unavailable');
  return {
    id: id(issueId), workspaceId: ctx.workspaceId, projectId,
    title: str(input.title, 200, true), actual: str(input.actual, 20000, true),
    steps: str(input.steps ?? ''), expected: str(input.expected ?? ''),
    observedEnvironment: str(input.observedEnvironment, 120, true), observedVersion: str(input.observedVersion ?? '', 200),
    component: str(input.component ?? '', 120), reporterId: ctx.actor.id, assigneeId: null, qaOwnerId: null,
    severity: enumValue(input.severity ?? 'untriaged', ['untriaged', 'low', 'medium', 'high']),
    priority: 3, dueDate: null, state: 'new', resolution: null, resolutionReason: '', duplicateOfId: null,
    fixCycle: 0, version: 1, fixSummary: '', holdReason: '', targets: [], runs: [], taskIds: [],
    createdAt: ctx.now, updatedAt: ctx.now, closedAt: null, reopenedAt: null,
  };
}

export function latestQaRun(issue: QaIssue, targetId: string): QaRun | undefined {
  return issue.runs.filter(run => run.fixCycle === issue.fixCycle && run.targetId === targetId)
    .reduce<QaRun | undefined>((latest, run) => !latest || run.sequence > latest.sequence ? run : latest, undefined);
}

/** Each candidate is immutable. A new build requires submit_fix, never a target edit. */
export function applyQaCommand(issue: QaIssue, command: QaCommand, ctx: QaContext): QaIssue {
  validContext(ctx);
  record(command);
  if (issue.workspaceId !== ctx.workspaceId || !ctx.projectIds.has(issue.projectId)) return fail('qa_forbidden', 403);
  if (!canQaCommand(issue, ctx.actor, command.type)) return fail('qa_forbidden', 403);
  const next: QaIssue = { ...issue, targets: issue.targets.map(target => ({ ...target })), runs: [...issue.runs], taskIds: [...issue.taskIds], version: issue.version + 1, updatedAt: ctx.now };
  switch (command.type) {
    case 'edit': {
      keys(command, ['type', 'title', 'actual', 'steps', 'expected', 'observedEnvironment', 'observedVersion', 'component']);
      next.title = str(command.title, 200, true); next.actual = str(command.actual, 20000, true);
      next.steps = str(command.steps); next.expected = str(command.expected);
      next.observedEnvironment = str(command.observedEnvironment, 120, true);
      next.observedVersion = str(command.observedVersion, 200); next.component = str(command.component, 120);
      break;
    }
    case 'triage': {
      keys(command, ['type', 'assigneeId', 'qaOwnerId', 'severity', 'priority', 'dueDate']);
      next.assigneeId = member(command.assigneeId, ctx); next.qaOwnerId = member(command.qaOwnerId, ctx);
      next.severity = enumValue(command.severity, ['low', 'medium', 'high']);
      if (!Number.isInteger(command.priority) || command.priority < 1 || command.priority > 5) return fail('qa_invalid_priority');
      next.priority = command.priority;
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
        const key = JSON.stringify([environment.toLowerCase(), component.toLowerCase()]);
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
      if (result === 'fail') { next.state = 'in_progress'; next.reopenedAt = ctx.now; }
      break;
    }
    case 'close': {
      keys(command, ['type', 'resolution', 'reason', 'duplicateOfId']);
      const resolution = enumValue(command.resolution, ['fixed', 'duplicate', 'not_bug', 'wont_fix', 'cannot_reproduce']);
      if (resolution === 'fixed') {
        const required = issue.targets.filter(target => target.required);
        if (issue.state !== 'verification' || !required.length || required.some(target => {
          const run = latestQaRun(issue, target.id);
          return !target.deployedAt || !run || run.result !== 'pass' || run.build !== target.build;
        })) return fail('qa_verification_required');
      }
      next.resolutionReason = str(command.reason, 8000, resolution !== 'fixed');
      if (resolution === 'duplicate') {
        const duplicate = id(command.duplicateOfId);
        if (duplicate === issue.id || !ctx.duplicateIssueIds?.has(duplicate)) return fail('qa_duplicate_unavailable');
        next.duplicateOfId = duplicate;
      } else {
        if (command.duplicateOfId) return fail('qa_invalid_request');
        next.duplicateOfId = null;
      }
      next.state = 'closed'; next.resolution = resolution; next.closedAt = ctx.now;
      break;
    }
    case 'reopen':
      keys(command, ['type', 'reason']); next.holdReason = str(command.reason, 8000, true);
      next.state = issue.assigneeId ? 'in_progress' : 'new'; next.resolution = null; next.resolutionReason = '';
      next.duplicateOfId = null; next.closedAt = null; next.reopenedAt = ctx.now; break;
    case 'hold':
      keys(command, ['type', 'reason']); next.holdReason = str(command.reason, 8000); break;
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
export function qaEventDetail(issue: QaIssue, type: string): string {
  const target = (item: QaTarget) => `${item.environment} · ${item.component || '-'} · ${item.build} · ${item.required ? '必要' : '選填'}`;
  if (type === 'submit_fix') return `修復輪次 ${issue.fixCycle}\n${issue.fixSummary}\n${issue.targets.map(target).join('\n')}`;
  if (type === 'record_deployment') return issue.targets.filter(item => item.deployedAt).map(item =>
    `${target(item)}\n${item.deployedAt} · ${item.deployedBy}\n${item.deploymentEvidence}`).join('\n\n');
  if (type === 'record_verification') {
    const run = issue.runs[issue.runs.length - 1];
    return run ? `第 ${run.fixCycle} 輪 · 第 ${run.sequence} 次驗證\n${run.environment} · ${run.component || '-'} · ${run.build}\n${run.result.toUpperCase()}\n${run.note}` : '';
  }
  if (type === 'close') return `${issue.resolution}\n${issue.resolutionReason}${issue.duplicateOfId ? '\n' + issue.duplicateOfId : ''}`;
  if (type === 'hold' || type === 'reopen') return issue.holdReason;
  if (type === 'triage') return `RD: ${issue.assigneeId} · QA: ${issue.qaOwnerId}\n${issue.severity} · P${issue.priority}${issue.dueDate ? '\n' + issue.dueDate : ''}`;
  if (type === 'link_tasks') return issue.taskIds.join('\n');
  if (type === 'edit' || type === 'create' || type === 'created') return `${issue.title}\n${issue.observedEnvironment} · ${issue.observedVersion || '版本未知'}\n${issue.actual}\n${issue.steps}\n${issue.expected}`;
  return '';
}

/** Notifications are generated from committed transitions, never from UI guesses. */
export function qaNotificationRecipients(issue: QaIssue, type: QaCommand['type'] | 'create' | 'comment', actorId: string): string[] {
  const ids = type === 'record_deployment' || type === 'submit_fix' ? [issue.qaOwnerId]
    : type === 'record_verification' || type === 'triage' || type === 'reopen' ? [issue.assigneeId, issue.qaOwnerId]
    : type === 'close' ? [issue.reporterId, issue.assigneeId] : [issue.assigneeId, issue.qaOwnerId];
  return [...new Set(ids.filter((value): value is string => !!value && value !== actorId))];
}
