import { ApprovalCommandError, approvalSnapshotSteps, canActOnApproval, parseApprovalCommand, type ApprovalCommand, type ApprovalCommandResult, type ApprovalRequestState, type ApprovalExpectedTask, type ApprovalStepSnapshot } from '../approval-command/core.ts';
import type { Row } from './core.ts';
import type { MemberDatabase } from './workspace-backend.ts';

export type ApprovalEntry = { request: ApprovalRequestState; task: Row; canAct: boolean; canWithdraw: boolean; legacy: boolean; enabled: boolean };
export type ApprovalPage = { entries: ApprovalEntry[]; cursor: number; nextCursor: number | null; enabled: boolean };
export type ApprovalSubmitTarget = { id: string; name: string; ruleId: string | null; ruleSnapshot: Row | null; steps: ApprovalStepSnapshot[] };
export type ApprovalSubmitPreparation = { task: Row; expected: ApprovalExpectedTask; targets: ApprovalSubmitTarget[]; cursor: number; nextCursor: number | null; omitted: number };
export type ApprovalSubmitCommand = Extract<ApprovalCommand,{operation:'submit'}>;
export interface ApprovalData {
  list(actor: Row, cursor: number): Promise<ApprovalPage>;
  detail(actor: Row, requestId: string): Promise<ApprovalEntry>;
  command(actor: Row, command: ApprovalCommand): Promise<ApprovalCommandResult>;
  prepareSubmit?(actor: Row, taskId: string, options?: { byKey?: boolean; cursor?: number }): Promise<ApprovalSubmitPreparation>;
}
const identifier = (value: unknown): string => {
  if (typeof value !== 'string' || !/^[\w-]{1,200}$/.test(value)) throw new ApprovalCommandError('approval_invalid_input');
  return value;
};
const one = (value: unknown): Row => (Array.isArray(value) ? value[0] : value) as Row || {};

/** All content uses the verified member JWT and live RLS. No service-role reads. */
export function createApprovalData(memberDb: (actor: Row) => MemberDatabase,
  execute: (actor: Row, command: ApprovalCommand) => Promise<ApprovalCommandResult>): ApprovalData {
  async function context(actor: Row) {
    const db = memberDb(actor);
    const member = (await db.rows('members', { select: 'id,role,is_active', id: `eq.${identifier(actor.id)}`, is_active: 'eq.true', limit: '1' }))[0];
    if (!member || member.id !== actor.id || member.is_active !== true) throw new ApprovalCommandError('approval_forbidden');
    const setting = (await db.rows('system_settings', { select: 'value', key: 'eq.feature_toggles', limit: '1' }))[0]?.value;
    let enabled = setting?.approvals;
    if (typeof enabled !== 'boolean') {
      const rules = await db.rows('approval_rules', { select: 'id', limit: '1' });
      const requests = rules.length ? [] : await db.rows('approval_requests', { select: 'id', limit: '1' });
      enabled = rules.length > 0 || requests.length > 0;
    }
    return { db, member, enabled: enabled === true };
  }
  async function entry(ctx: Awaited<ReturnType<typeof context>>, request: ApprovalRequestState): Promise<ApprovalEntry | null> {
    const task = (await ctx.db.rows('tasks', { select: 'id,task_key,title,requirement,project_id,current_approval_id,projects!inner(id,name,is_archived)',
      id: `eq.${identifier(request.task_id)}`, 'projects.is_archived': 'eq.false', limit: '1' }))[0];
    if (!task || one(task.projects).is_archived === true) return null;
    const legacy = !approvalSnapshotSteps(request);
    let currentRule = true;
    if (request.rule_id) currentRule = (await ctx.db.rows('approval_rules', { select: 'id,is_active', id: `eq.${identifier(request.rule_id)}`, limit: '1' }))[0]?.is_active === true;
    const pending = request.status === 'pending' && task.current_approval_id === request.id;
    return { request, task: { ...task, project_name: one(task.projects).name }, enabled: ctx.enabled, legacy,
      canAct: pending && ctx.enabled && currentRule && canActOnApproval(request, { id: ctx.member.id, role: ctx.member.role, active: true }),
      canWithdraw: pending && (request.requested_by === ctx.member.id || ['admin', 'super_admin'].includes(ctx.member.role)) };
  }
  return {
    async prepareSubmit(actor, taskId, options = {}) {
      const cursor = options.cursor ?? 0;
      if (!Number.isSafeInteger(cursor) || cursor < 0 || cursor > 1000000) throw new ApprovalCommandError('approval_invalid_input');
      const ctx = await context(actor);
      if (!ctx.enabled) throw new ApprovalCommandError('approval_disabled');
      const found = await ctx.db.rows('tasks', {select:'id,task_key,title,project_id,status_id,requires_approval,current_approval_id,approval_status,projects!inner(id,name,is_archived)',
        [options.byKey ? 'task_key' : 'id']:`eq.${identifier(taskId)}`, 'projects.is_archived':'eq.false',limit:options.byKey?'2':'1'});
      const task = found[0], project = one(task?.projects);
      if (found.length !== 1 || !task || (options.byKey ? task.task_key !== taskId : task.id !== taskId) || project.id !== task.project_id || project.is_archived !== false ||
        typeof task.requires_approval !== 'boolean') throw new ApprovalCommandError('approval_forbidden');
      const id = identifier(task.id), projectId = identifier(task.project_id), statusId = identifier(task.status_id);
      if (task.current_approval_id != null || task.approval_status != null ||
        (await ctx.db.rows('approval_requests',{select:'id',task_id:`eq.${id}`,status:'eq.pending',limit:'1'})).length)
        throw new ApprovalCommandError('approval_pending');
      const current = (await ctx.db.rows('statuses',{select:'id,name',id:`eq.${statusId}`,limit:'1'}))[0];
      if (!current || current.id !== statusId) throw new ApprovalCommandError('approval_forbidden');
      // Eight choices keep Slack metadata bounded. The sentinel is never lost:
      // even a page whose rules are invalid retains its continuation.
      const statuses = await ctx.db.rows('statuses',{select:'id,name',id:`neq.${statusId}`,order:'sort_order.asc,id.asc',offset:String(cursor),limit:'9'});
      const targets: ApprovalSubmitTarget[] = []; let omitted = 0;
      for (const status of statuses.slice(0,8)) {
        const targetId = identifier(status.id);
        if (targetId === statusId) { omitted++; continue; }
        const rules = await ctx.db.rows('approval_rules',{select:'*',project_id:`eq.${projectId}`,from_status:`eq.${statusId}`,to_status:`eq.${targetId}`,is_active:'eq.true',limit:'2'});
        if (rules.length > 1 || rules.some(rule=>rule.project_id!==projectId || rule.from_status!==statusId || rule.to_status!==targetId || rule.is_active!==true)) { omitted++; continue; }
        const rule = rules[0]; let steps: ApprovalStepSnapshot[];
        if (rule) {
          const ruleId = identifier(rule.id), raw = await ctx.db.rows('approval_rule_steps',{select:'*',rule_id:`eq.${ruleId}`,order:'step_order.asc',limit:'101'});
          const parsed = approvalSnapshotSteps({steps_snapshot:raw as ApprovalStepSnapshot[]});
          if (!parsed || raw.some(step=>step.rule_id!==ruleId)) { omitted++; continue; }
          const users = [...new Set(parsed.filter(step=>step.approver_type==='user').map(step=>identifier(step.approver_user_id)))];
          if (users.length) {
            const active = await ctx.db.rows('members',{select:'id,is_active',id:`in.(${users.join(',')})`,is_active:'eq.true',limit:'101'});
            if (users.some(user=>!active.some(member=>member.id===user && member.is_active===true))) { omitted++; continue; }
          }
          steps = parsed;
        } else steps = [{step_order:1,approver_type:'role',approver_role:'admin',approver_user_id:null}];
        targets.push({id:targetId,name:String(status.name||''),ruleId:rule?identifier(rule.id):null,ruleSnapshot:rule||null,steps});
      }
      return {task:{id,task_key:task.task_key,title:task.title,project_name:project.name,from_status_name:current.name},
        expected:{statusId,requiresApproval:task.requires_approval,currentApprovalId:null,approvalStatus:null},
        targets,cursor,nextCursor:statuses.length>8?cursor+8:null,omitted};
    },
    async list(actor, cursor) {
      if (!Number.isSafeInteger(cursor) || cursor < 0 || cursor > 1000000) throw new ApprovalCommandError('approval_invalid_input');
      const ctx = await context(actor), entries: ApprovalEntry[] = [];
      let offset = cursor;
      // A sparse page may be empty but still has a continuation. Never silently
      // truncate the actor's queue or expose hidden request IDs in cursor values.
      for (let batch = 0; batch < 8; batch++) {
        const rows = await ctx.db.rows('approval_requests', { select: '*', status: 'eq.pending', order: 'created_at.desc,id.asc', limit: '25', offset: String(offset) });
        for (const raw of rows) {
          const item = await entry(ctx, raw as ApprovalRequestState);
          if (item && (item.canAct || item.canWithdraw)) {
            if (entries.length === 8) return { entries, cursor, nextCursor: offset, enabled: ctx.enabled };
            entries.push(item);
          }
          offset++;
        }
        if (rows.length < 25) return { entries, cursor, nextCursor: null, enabled: ctx.enabled };
      }
      return { entries, cursor, nextCursor: offset, enabled: ctx.enabled };
    },
    async detail(actor, requestId) {
      const ctx = await context(actor);
      const request = (await ctx.db.rows('approval_requests', { select: '*', id: `eq.${identifier(requestId)}`, limit: '1' }))[0];
      const item = request && await entry(ctx, request as ApprovalRequestState);
      if (!item) throw new ApprovalCommandError('approval_forbidden');
      const statusIds = [...new Set([request.from_status,request.to_status].map(identifier))];
      const statuses = await ctx.db.rows('statuses', {select:'id,name',id:`in.(${statusIds.join(',')})`});
      const requester = (await ctx.db.rows('members', {select:'id,name',id:`eq.${identifier(request.requested_by)}`,limit:'1'}))[0];
      item.task.from_status_name = statuses.find(status=>status.id===request.from_status)?.name;
      item.task.to_status_name = statuses.find(status=>status.id===request.to_status)?.name;
      item.task.requester_name = requester?.name;
      return item;
    },
    async command(actor, input) {
      // Refresh active membership even for a modal opened by a valid past session.
      const ctx = await context(actor), command = parseApprovalCommand(input);
      if (command.operation !== 'withdraw' && !ctx.enabled) throw new ApprovalCommandError('approval_disabled');
      return execute(actor, command);
    },
  };
}

/** The same authenticated HTTP adapter as the app; never post an actor/role. */
export async function executeSlackApprovalCommand(env: {get(name: string): string | undefined}, actor: Row, input: ApprovalCommand,
  fetcher: typeof fetch = fetch): Promise<ApprovalCommandResult> {
  if (!actor.jwt) throw new ApprovalCommandError('approval_forbidden');
  const command = parseApprovalCommand(input);
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const response = await fetcher(`${env.get('SUPABASE_URL')}/functions/v1/approval-command`, { method: 'POST',
        headers: { Authorization: `Bearer ${actor.jwt}`, apikey: env.get('SUPABASE_ANON_KEY') || '', 'Content-Type': 'application/json' },
        body: JSON.stringify(command), signal: AbortSignal.timeout(15000) });
      const result = await response.json();
      if (result?.error === 'approval_unavailable' || response.status >= 500) throw new Error('transport');
      if (!response.ok || result?.error) throw new ApprovalCommandError(/^approval_[a-z_]+$/.test(result?.error) ? result.error : 'approval_forbidden');
      if (result?.commandId !== command.commandId || !result.task?.id || typeof result.replayed !== 'boolean' || !result.eventId ||
        ('requestId' in command && result.request?.id !== command.requestId) ||
        ('taskId' in command && result.task.id !== command.taskId) ||
        (command.operation==='submit' && result.request?.task_id !== command.taskId)) throw new Error('transport');
      return result as ApprovalCommandResult;
    } catch (error) {
      if (error instanceof ApprovalCommandError) throw error;
      if (attempt) throw new ApprovalCommandError('approval_transport_error', 503);
    }
  }
  throw new ApprovalCommandError('approval_transport_error', 503);
}
