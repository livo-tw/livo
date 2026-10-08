import { requiredTargetsPassed, type QaIssue, type QaState } from './domain.ts';
/** Presentation only: immutable event snapshots and command receipts stay unchanged. */
export const QA_NOTIFICATION_FIELDS = ['projectId', 'assigneeId', 'qaOwnerId', 'severity', 'priority', 'dueDate'] as const;
export type QaNotificationField = typeof QA_NOTIFICATION_FIELDS[number];
export interface QaFieldChange { field: QaNotificationField; before: unknown; after: unknown; hasBefore: boolean }
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const own = (value: Record<string, unknown>, key: string) => Object.prototype.hasOwnProperty.call(value, key);
function snapshot(detail: unknown): Record<string, unknown> | null {
  if (typeof detail !== 'string' || detail.length > 16000) return null;
  try { const value: unknown = JSON.parse(detail); return object(value) ? value : null; } catch { return null; }
}
/** Known fields only; malformed/unknown structures never become visible JSON. */
export function qaFieldChanges(detail: unknown): QaFieldChange[] | null {
  const value = snapshot(detail);
  if (!value || !object(value.after) || (own(value, 'before') && !object(value.before))) return null;
  const after = value.after, before = object(value.before) ? value.before : null;
  return QA_NOTIFICATION_FIELDS.filter(field => own(after, field) && (!before || before[field] !== after[field]))
    .map(field => ({ field, before: before?.[field], after: after[field], hasBefore: !!before }));
}
const id = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,199}$/.test(value);
/** Bounded label lookups only. These ids must never affect routing or authorization. */
export function qaNotificationReferences(eventType: unknown, detail: unknown): { members: string[]; projects: string[] } {
  if (typeof eventType === 'string' && HANDOFF_EVENTS.includes(eventType)) {
    const value = handoffSnapshot(detail);
    return { members: value ? [...new Set([value.nextOwnerId, value.acceptedBy, value.resolvedBy].filter(id))] : [], projects: [] };
  }
  const changes = eventType === 'update_fields' ? qaFieldChanges(detail) : eventType === 'triage' ? qaFieldChanges(triageSnapshot(detail)) : null;
  const references = (fields: readonly QaNotificationField[]) => [...new Set((changes || []).filter(change => fields.includes(change.field))
    .flatMap(change => [change.before, change.after]).filter(id))];
  return { members: references(['assigneeId', 'qaOwnerId']), projects: references(['projectId']) };
}
const copy = {
  'zh-TW': { priorities: ['最高', '高', '中', '低', '最低'], severities: { untriaged: '待判定', low: '低', medium: '中', high: '高' },
    fields: { projectId: '專案', assigneeId: '修復負責人', qaOwnerId: '驗證 QA', severity: '嚴重程度', priority: '優先級', dueDate: '期限' },
    unassigned: '未指定', unset: '未設定', unknownMember: '未知成員', unknownProject: '未知專案', updated: 'Bug 欄位已更新，請在 LIVO 查看詳情。', unchanged: '欄位未變更',
    states: { new: '新回報', triaged: '已指派', in_progress: '修復中', verification: '待驗證', verified: 'PASS', failed: 'FAIL', closed: '已結案', dismissed: '不處理' },
    manualState: '手動變更狀態', stateUpdated: '狀態已更新，請在 LIVO 查看詳情。', noticeUpdated: 'Bug 已更新，請在 LIVO 查看詳情。',
    handoffOwner: '交接給', handoffAcceptedBy: '接收人', handoffResolvedBy: '解除人', handoffReason: '交接原因', replyBy: '預期回覆時間', externalDependency: '外部依賴', resolutionEvidence: '解除依據',
    handoffUpdated: '交接紀錄已更新，請在 LIVO 查看詳情。', fixCycle: '修復輪次', fixSummary: '修復說明', fixUpdated: '修復紀錄已更新，請在 LIVO 查看詳情。',
    environment: '環境', component: '功能／區域', build: '版本', requirement: '驗證需求', required: '必要', optional: '選填', deploymentBy: '部署人', deploymentAt: '部署時間', deploymentEvidence: '部署依據', deploymentUpdated: '部署紀錄已更新，請在 LIVO 查看詳情。',
    verificationCycle: '驗證輪次', verificationSequence: '驗證次數', verificationResult: '驗證結果', verificationNote: '驗證備註', verificationUpdated: '驗證紀錄已更新，請在 LIVO 查看詳情。', verificationAutoClosed: '所有必要環境已部署並驗證通過，已自動結案。',
    results: { PASS: 'PASS（驗證通過）', FAIL: 'FAIL（驗證失敗）', BLOCKED: '受阻（尚未完成驗證）' },
    resolution: '結案結果', resolutionReason: '結案說明', resolutions: { fixed: '已修復', duplicate: '重複 Bug', not_bug: '非 Bug', wont_fix: '不處理', cannot_reproduce: '無法重現' },
    closeUpdated: '結案紀錄已更新，請在 LIVO 查看詳情。', linkedTasks: '已連結任務', linkedTasksUpdated: '已更新連結任務，請在 LIVO 查看詳情。' },
  'zh-CN': { priorities: ['最高', '高', '中', '低', '最低'], severities: { untriaged: '待判定', low: '低', medium: '中', high: '高' },
    fields: { projectId: '项目', assigneeId: '修复负责人', qaOwnerId: '验证 QA', severity: '严重程度', priority: '优先级', dueDate: '截止日期' },
    unassigned: '未指定', unset: '未设置', unknownMember: '未知成员', unknownProject: '未知项目', updated: 'Bug 字段已更新，请在 LIVO 查看详情。', unchanged: '字段未变更',
    states: { new: '新回报', triaged: '已指派', in_progress: '修复中', verification: '待验证', verified: 'PASS', failed: 'FAIL', closed: '已结案', dismissed: '不处理' },
    manualState: '手动变更状态', stateUpdated: '状态已更新，请在 LIVO 查看详情。', noticeUpdated: 'Bug 已更新，请在 LIVO 查看详情。',
    handoffOwner: '交接给', handoffAcceptedBy: '接收人', handoffResolvedBy: '解除人', handoffReason: '交接原因', replyBy: '预期回复时间', externalDependency: '外部依赖', resolutionEvidence: '解除依据',
    handoffUpdated: '交接记录已更新，请在 LIVO 查看详情。', fixCycle: '修复轮次', fixSummary: '修复说明', fixUpdated: '修复记录已更新，请在 LIVO 查看详情。',
    environment: '环境', component: '功能／区域', build: '版本', requirement: '验证需求', required: '必要', optional: '选填', deploymentBy: '部署人', deploymentAt: '部署时间', deploymentEvidence: '部署依据', deploymentUpdated: '部署记录已更新，请在 LIVO 查看详情。',
    verificationCycle: '验证轮次', verificationSequence: '验证次数', verificationResult: '验证结果', verificationNote: '验证备注', verificationUpdated: '验证记录已更新，请在 LIVO 查看详情。', verificationAutoClosed: '所有必要环境已部署并验证通过，已自动结案。',
    results: { PASS: 'PASS（验证通过）', FAIL: 'FAIL（验证失败）', BLOCKED: '受阻（尚未完成验证）' },
    resolution: '结案结果', resolutionReason: '结案说明', resolutions: { fixed: '已修复', duplicate: '重复 Bug', not_bug: '非 Bug', wont_fix: '不处理', cannot_reproduce: '无法重现' },
    closeUpdated: '结案记录已更新，请在 LIVO 查看详情。', linkedTasks: '已连接任务', linkedTasksUpdated: '已更新连接任务，请在 LIVO 查看详情。' },
  en: { priorities: ['Highest', 'High', 'Medium', 'Low', 'Lowest'], severities: { untriaged: 'Untriaged', low: 'Low', medium: 'Medium', high: 'High' },
    fields: { projectId: 'Project', assigneeId: 'Developer', qaOwnerId: 'Verification owner', severity: 'Severity', priority: 'Priority', dueDate: 'Due date' },
    unassigned: 'Unassigned', unset: 'Not set', unknownMember: 'Unknown member', unknownProject: 'Unknown project', updated: 'Bug fields were updated. Open LIVO for details.', unchanged: 'No fields changed',
    states: { new: 'New', triaged: 'Assigned', in_progress: 'Fix in progress', verification: 'Awaiting verification', verified: 'PASS', failed: 'FAIL', closed: 'Closed', dismissed: 'Dismissed' },
    manualState: 'Manual state change', stateUpdated: 'The state was updated. Open LIVO for details.', noticeUpdated: 'The bug was updated. Open LIVO for details.',
    handoffOwner: 'Handoff to', handoffAcceptedBy: 'Accepted by', handoffResolvedBy: 'Resolved by', handoffReason: 'Handoff reason', replyBy: 'Reply by', externalDependency: 'External dependency', resolutionEvidence: 'Resolution evidence',
    handoffUpdated: 'The handoff was updated. Open LIVO for details.', fixCycle: 'Fix cycle', fixSummary: 'Fix summary', fixUpdated: 'The fix was updated. Open LIVO for details.',
    environment: 'Environment', component: 'Component / area', build: 'Build', requirement: 'Verification requirement', required: 'Required', optional: 'Optional', deploymentBy: 'Deployed by', deploymentAt: 'Deployed at', deploymentEvidence: 'Deployment evidence', deploymentUpdated: 'Deployment records were updated. Open LIVO for details.',
    verificationCycle: 'Fix cycle', verificationSequence: 'Verification attempt', verificationResult: 'Verification result', verificationNote: 'Verification note', verificationUpdated: 'Verification records were updated. Open LIVO for details.', verificationAutoClosed: 'All required environments were deployed and passed verification. The bug closed automatically.',
    results: { PASS: 'PASS (verification passed)', FAIL: 'FAIL (verification failed)', BLOCKED: 'Blocked (verification incomplete)' },
    resolution: 'Resolution', resolutionReason: 'Closure reason', resolutions: { fixed: 'Fixed', duplicate: 'Duplicate bug', not_bug: 'Not a bug', wont_fix: 'Will not fix', cannot_reproduce: 'Cannot reproduce' },
    closeUpdated: 'Closure records were updated. Open LIVO for details.', linkedTasks: 'Linked tasks', linkedTasksUpdated: 'Linked tasks were updated. Open LIVO for details.' },
};
const words = (locale?: string) => /^zh[-_](?:CN|SG|Hans)/i.test(locale || '') ? copy['zh-CN'] : /^zh/i.test(locale || '') || !locale ? copy['zh-TW'] : copy.en;
/** Stored QA priority is 1 (highest) through 5 (lowest), matching task cards. */
export function qaPriorityText(priority: unknown, locale?: string): string {
  const number = typeof priority === 'number' ? priority : typeof priority === 'string' && /^[1-5]$/.test(priority) ? Number(priority) : NaN;
  return Number.isInteger(number) && number >= 1 && number <= 5 ? words(locale).priorities[number - 1] : words(locale).unset;
}
export function qaSeverityText(severity: unknown, locale?: string): string {
  const c = words(locale);
  return typeof severity === 'string' && own(c.severities, severity) ? c.severities[severity as keyof typeof c.severities] : c.unset;
}
export function qaDueDateText(value: unknown, locale?: string): string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return words(locale).unset;
  const date = new Date(value + 'T00:00:00Z');
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value ? value : words(locale).unset;
}
export interface QaNotificationTextContext {
  memberName: (id: string) => string | undefined;
  projectName: (id: string) => string | undefined;
  locale?: string;
  /** Trusted display labels only; never used for authorization or state transitions. */
  stateName?: (state: string) => string | undefined;
  /** Current trusted aggregate, used only to disambiguate legacy audit metadata. */
  fixSnapshot?: Pick<QaIssue, 'fixCycle' | 'targets'> & Partial<Pick<QaIssue, 'fixSummary'>>;
  /** Presentation preference only; severity and its audit snapshot stay stored. */
  showSeverity?: boolean;
  /** Fresh authorized aggregate; user notes are never treated as closure proof. */
  verificationSnapshot?: QaIssue;
}
export function qaFieldNotificationText(detail: unknown, ctx: QaNotificationTextContext): string {
  const changes = qaFieldChanges(detail), c = words(ctx.locale);
  if (changes === null) return c.updated;
  const name = (input: unknown, lookup: (id: string) => string | undefined, missing: string, unknown: string) => {
    if (input === null || input === undefined || input === '') return missing;
    if (!id(input)) return unknown;
    const label = lookup(input);
    return typeof label === 'string' && label.trim() && label !== input ? label.replace(/\s+/g, ' ').trim().slice(0, 100) : unknown;
  };
  const display = (field: QaNotificationField, input: unknown) => {
    if (field === 'projectId') return name(input, ctx.projectName, c.unset, c.unknownProject);
    if (field === 'assigneeId' || field === 'qaOwnerId') return name(input, ctx.memberName, c.unassigned, c.unknownMember);
    if (field === 'severity') return qaSeverityText(input, ctx.locale);
    if (field === 'priority') return qaPriorityText(input, ctx.locale);
    return qaDueDateText(input, ctx.locale);
  };
  const visible = changes.filter(change => ctx.showSeverity !== false || change.field !== 'severity');
  if (!visible.length && changes.length) return c.updated;
  return visible.map(change => `${c.fields[change.field]}：${change.hasBefore ? display(change.field, change.before) + ' → ' : ''}${display(change.field, change.after)}`).join('\n') || c.unchanged;
}

function triageSnapshot(detail: unknown): string | null {
  if (typeof detail !== 'string' || detail.length > 16000) return null;
  const match = /^RD: (\S+) · QA: (\S+)\n(\w+) · P([1-5])(?:\n(\S+))?$/.exec(detail);
  return match ? JSON.stringify({ after: { assigneeId: match[1], qaOwnerId: match[2], severity: match[3], priority: Number(match[4]), dueDate: match[5] || null } }) : null;
}
type Copy = ReturnType<typeof words>;
const isState = (value: unknown): value is QaState => typeof value === 'string' && own(copy['zh-TW'].states, value);
const note = (value: unknown, max = 8000): value is string => typeof value === 'string' && value.length <= max && !value.includes('\u0000');
const HANDOFF_EVENTS = ['request_handoff', 'accept_handoff', 'resolve_handoff'];
function displayMember(value: unknown, ctx: QaNotificationTextContext, c: Copy): string {
  if (value === null || value === undefined || value === '') return c.unassigned;
  if (!id(value)) return c.unknownMember;
  const name = ctx.memberName(value);
  return typeof name === 'string' && name.trim() && name !== value ? name.replace(/\s+/g, ' ').trim().slice(0, 100) : c.unknownMember;
}
function dateTime(value: unknown): string | null {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) return null;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) && date.toISOString() === value ? value.slice(0, 16).replace('T', ' ') + ' UTC' : null;
}
function stateNotificationText(detail: unknown, ctx: QaNotificationTextContext, c: Copy): string {
  const value = snapshot(detail);
  if (!value || value.mode !== 'manual' || !isState(value.from) || !isState(value.to)) return c.stateUpdated;
  const label = (state: QaState) => {
    const custom = ctx.stateName?.(state);
    return typeof custom === 'string' && custom.trim() && custom !== state ? custom.replace(/\s+/g, ' ').trim().slice(0, 100) : c.states[state];
  };
  return `${c.manualState}：${label(value.from)} → ${label(value.to)}`;
}
function handoffSnapshot(detail: unknown): Record<string, unknown> | null {
  const value = snapshot(detail);
  return value && id(value.nextOwnerId) && note(value.reason) && value.reason.trim() &&
    (!own(value, 'externalDependency') || note(value.externalDependency, 2000)) &&
    (!own(value, 'resolutionEvidence') || note(value.resolutionEvidence)) ? value : null;
}
function handoffNotificationText(eventType: string, detail: unknown, ctx: QaNotificationTextContext, c: Copy): string {
  const value = handoffSnapshot(detail);
  if (!value) return c.handoffUpdated;
  const lines = [`${c.handoffReason}：${value.reason}`];
  if (eventType === 'request_handoff') {
    lines.unshift(`${c.handoffOwner}：${displayMember(value.nextOwnerId, ctx, c)}`, `${c.replyBy}：${dateTime(value.replyBy) || c.unset}`);
    if (value.externalDependency) lines.push(`${c.externalDependency}：${value.externalDependency}`);
  } else if (eventType === 'accept_handoff') {
    if (!id(value.acceptedBy) || !dateTime(value.acceptedAt)) return c.handoffUpdated;
    lines.unshift(`${c.handoffAcceptedBy}：${displayMember(value.acceptedBy, ctx, c)}`);
  } else {
    if (!id(value.resolvedBy) || !dateTime(value.resolvedAt) || !note(value.resolutionEvidence) || !value.resolutionEvidence.trim()) return c.handoffUpdated;
    lines.unshift(`${c.handoffResolvedBy}：${displayMember(value.resolvedBy, ctx, c)}`, `${c.resolutionEvidence}：${value.resolutionEvidence}`);
  }
  return lines.join('\n');
}
interface TargetSnapshot { environment: string; component: string; build: string; required: boolean }
function trustedTargets(ctx: QaNotificationTextContext): TargetSnapshot[] | null {
  const current = ctx.fixSnapshot;
  if (!current || !Number.isSafeInteger(current.fixCycle) || current.fixCycle < 0 || !Array.isArray(current.targets) || !current.targets.length || current.targets.length > 30) return null;
  return current.targets.every(target => target && note(target.environment, 120) && target.environment.trim() && note(target.component, 120) &&
    note(target.build, 200) && typeof target.required === 'boolean') ? current.targets : null;
}
const targetLine = (target: TargetSnapshot) => `${target.environment} · ${target.component || '-'} · ${target.build} · ${target.required ? '必要' : '選填'}`;
function targetText(target: TargetSnapshot, c: Copy): string {
  return [`${c.environment}：${target.environment}`, `${c.build}：${target.build && target.build !== '-' ? target.build : c.unset}`,
    ...(target.component && target.component !== '-' ? [`${c.component}：${target.component}`] : []),
    `${c.requirement}：${target.required ? c.required : c.optional}`].join('\n');
}
function fixNotificationText(detail: unknown, ctx: QaNotificationTextContext, c: Copy): string {
  const targets = trustedTargets(ctx), summary = ctx.fixSnapshot?.fixSummary;
  if (!targets || !note(detail, 16000) || !note(summary, 8000)) return c.fixUpdated;
  const expected = `修復輪次 ${ctx.fixSnapshot!.fixCycle}\n${summary}\n${targets.map(targetLine).join('\n')}`;
  // Full equality prevents a truncated author's copied target line from being
  // mistaken for generated metadata. A stale aggregate is safely summarized.
  if (detail !== expected) return c.fixUpdated;
  return `${c.fixCycle}：${ctx.fixSnapshot!.fixCycle}\n${c.fixSummary}：${summary || c.unset}\n\n${targets.map(target => targetText(target, c)).join('\n\n')}`;
}
interface DeploymentSnapshot { target: TargetSnapshot; deployedAt: string; deployedBy: string; evidence: string }
function deploymentSnapshots(detail: unknown, ctx: QaNotificationTextContext): DeploymentSnapshot[] | null {
  if (!trustedTargets(ctx) || !note(detail, 16000)) return null;
  const targets = ctx.fixSnapshot!.targets.filter(target => target.deployedAt);
  if (!targets.length || targets.some(target => !dateTime(target.deployedAt) || !id(target.deployedBy) || !note(target.deploymentEvidence, 8000))) return null;
  const expected = targets.map(target => `${targetLine(target)}\n${target.deployedAt} · ${target.deployedBy}\n${target.deploymentEvidence}`).join('\n\n');
  // Legacy delivery payloads can be truncated to 2,000 characters. Never infer
  // evidence boundaries from copied excerpts; require the complete producer text.
  if (detail !== expected) return null;
  return targets.map(target => ({ target, deployedAt: dateTime(target.deployedAt)!, deployedBy: target.deployedBy!, evidence: target.deploymentEvidence }));
}
function deploymentNotificationText(detail: unknown, ctx: QaNotificationTextContext, c: Copy): string {
  const values = deploymentSnapshots(detail, ctx);
  return values ? values.map(value => `${targetText(value.target, c)}\n${c.deploymentBy}：${displayMember(value.deployedBy, ctx, c)}\n${c.deploymentAt}：${value.deployedAt}` +
    (value.evidence ? `\n${c.deploymentEvidence}：${value.evidence}` : '')).join('\n\n') : c.deploymentUpdated;
}
const AUTO_CLOSE_AUDIT_LINE = '所有必要環境已部署並驗證通過，已自動結案。';
/** A copied marker in a user's note is not system closure metadata. Require the
 * complete canonical audit body and the fresh closing aggregate's actual run. */
export function qaVerificationAutoClosed(detail: unknown, issue?: QaIssue): boolean {
  if (!issue || issue.state !== 'closed' || issue.resolution !== 'fixed' || !issue.closedAt || !issue.closedBy ||
      !Array.isArray(issue.targets) || !Array.isArray(issue.runs) || !requiredTargetsPassed(issue)) return false;
  const run = issue.runs[issue.runs.length - 1];
  if (!run || run.result !== 'pass' || run.fixCycle !== issue.fixCycle || issue.closedAt !== run.createdAt || issue.closedBy !== run.testerId) return false;
  const expected = `第 ${run.fixCycle} 輪 · 第 ${run.sequence} 次驗證\n${run.environment} · ${run.component || '-'} · ${run.build}\nPASS\n${run.note}\n${AUTO_CLOSE_AUDIT_LINE}`;
  return detail === expected;
}
function verificationNotificationText(detail: unknown, ctx: QaNotificationTextContext, c: Copy): string {
  if (!note(detail, 16000)) return c.verificationUpdated;
  const match = /^第 (0|[1-9]\d{0,8}) 輪 · 第 ([1-9]\d{0,8}) 次驗證\n([^\n]+)\n(PASS|FAIL|BLOCKED)\n([\s\S]*)$/.exec(detail);
  if (!match) return c.verificationUpdated;
  const fields = match[3].split(' · ');
  if (fields.length !== 3 || !note(fields[0], 120) || !fields[0].trim() || !note(fields[1], 120) || !note(fields[2], 200)) return c.verificationUpdated;
  const autoClosed = qaVerificationAutoClosed(detail, ctx.verificationSnapshot);
  const verificationNote = autoClosed ? match[5].slice(0, -(AUTO_CLOSE_AUDIT_LINE.length + 1)) : match[5];
  return [`${c.verificationCycle}：${match[1]}｜${c.verificationSequence}：${match[2]}`, `${c.environment}：${fields[0]}`, `${c.build}：${fields[2] && fields[2] !== '-' ? fields[2] : c.unset}`,
    ...(fields[1] && fields[1] !== '-' ? [`${c.component}：${fields[1]}`] : []), `${c.verificationResult}：${c.results[match[4] as keyof Copy['results']]}`,
    ...(verificationNote ? [`${c.verificationNote}：${verificationNote}`] : []), ...(autoClosed ? [c.verificationAutoClosed] : [])].join('\n');
}
function closeNotificationText(detail: unknown, c: Copy): string {
  if (!note(detail, 16000)) return c.closeUpdated;
  const lines = detail.split('\n'), resolution = lines.shift()!;
  if (!own(c.resolutions, resolution)) return c.closeUpdated;
  // The final duplicate issue id is generated metadata, not the author's reason.
  if (resolution === 'duplicate') {
    if (lines.length < 2 || !id(lines[lines.length - 1])) return c.closeUpdated;
    lines.pop();
  }
  const reason = lines.join('\n');
  return `${c.resolution}：${c.resolutions[resolution as keyof Copy['resolutions']]}` + (reason ? `\n${c.resolutionReason}：${reason}` : '');
}
/** Shared by channel notices and DMs; structured audit data is never rendered.
 * User-authored comment/hold/reopen text is deliberately left to the caller's
 * plain-text and Slack escaping, including notes that happen to contain JSON.
 */
export function qaNotificationDetailText(eventType: unknown, detail: unknown, ctx: QaNotificationTextContext): string | undefined {
  const c = words(ctx.locale);
  if (eventType === 'update_fields') return qaFieldNotificationText(detail, ctx);
  if (eventType === 'triage') return qaFieldNotificationText(triageSnapshot(detail), ctx);
  if (eventType === 'set_state' || eventType === 'state_changed') return stateNotificationText(detail, ctx, c);
  if (typeof eventType === 'string' && HANDOFF_EVENTS.includes(eventType)) return handoffNotificationText(eventType, detail, ctx, c);
  if (eventType === 'submit_fix') return fixNotificationText(detail, ctx, c);
  if (eventType === 'record_deployment') return deploymentNotificationText(detail, ctx, c);
  if (eventType === 'record_verification') return verificationNotificationText(detail, ctx, c);
  if (eventType === 'close') return closeNotificationText(detail, c);
  if (eventType === 'link_tasks') {
    if (!note(detail, 16000) || !detail) return c.linkedTasksUpdated;
    const tasks = detail.split('\n');
    return tasks.length <= 50 && new Set(tasks).size === tasks.length && tasks.every(id) ? `${c.linkedTasks}：${tasks.length}` : c.linkedTasksUpdated;
  }
  if (['comment', 'hold', 'reopen', 'create', 'created', 'edit'].includes(String(eventType))) return undefined;
  return detail === '' || detail === null || detail === undefined ? '' : c.noticeUpdated;
}
