import type { Task, Status } from '@/types';
import type { QaIssue, QaListInput, QaListResult, QaState } from '@/lib/qa/domain';
import { qaShortId } from '@/lib/qa/shortId';
import { isQaTerminal } from '@/lib/qa/domain';

export type AssignmentRole = 'assignee' | 'reviewer' | 'fix' | 'verify' | 'handoff';
export type MyAssignment = {
  key: string; id: string; kind: 'task' | 'bug'; title: string; reference: string;
  projectId: string; roles: AssignmentRole[]; dueDate?: string | null; priority: number;
  updated: string; task?: Task; issue?: QaIssue; status?: Status;
};
export const ACTIVE_QA_STATES: QaState[] = ['new', 'triaged', 'in_progress', 'verification', 'verified', 'failed'];

export function assignmentDay(value?: string | null): number {
  if (!value) return Infinity;
  const date = /^\d{4}-\d{2}-\d{2}$/.test(value) ? new Date(`${value}T00:00:00`) : new Date(value);
  if (!Number.isFinite(date.getTime())) return Infinity;
  date.setHours(0, 0, 0, 0); return date.getTime();
}

/** Counts records once even when the same member has both responsibilities. */
export function buildMyAssignments(tasks: Task[], statuses: Status[], issues: QaIssue[], memberId: string, now = new Date()): MyAssignment[] {
  if (!memberId) return [];
  const statusMap = new Map(statuses.map(status => [status.id, status]));
  const priorities = { highest: 0, high: 1, medium: 2, low: 3, lowest: 4 };
  const items: MyAssignment[] = [];
  for (const task of tasks) {
    const status = statusMap.get(task.statusId);
    if (status?.isDone) continue;
    const roles: AssignmentRole[] = [];
    if (task.assigneeId === memberId) roles.push('assignee');
    if (task.reviewerId === memberId) roles.push('reviewer');
    if (roles.length) items.push({ key: `task:${task.id}`, id: task.id, kind: 'task', title: task.title, reference: task.taskKey, projectId: task.projectId, roles, dueDate: task.dueDate, priority: priorities[task.priority] ?? 2, updated: task.createdAt, task, status });
  }
  for (const issue of new Map(issues.map(issue => [issue.id, issue])).values()) {
    if (isQaTerminal(issue.state)) continue;
    const roles: AssignmentRole[] = [];
    if (issue.assigneeId === memberId) roles.push('fix');
    if (issue.qaOwnerId === memberId) roles.push('verify');
    // A handoff waiting on me is my work too, until it is resolved.
    if (issue.handoff && !issue.handoff.resolvedAt && issue.handoff.nextOwnerId === memberId) roles.push('handoff');
    if (roles.length) items.push({ key: `bug:${issue.id}`, id: issue.id, kind: 'bug', title: issue.title, reference: qaShortId(issue.id), projectId: issue.projectId, roles, dueDate: issue.dueDate, priority: issue.priority - 1, updated: issue.updatedAt, issue });
  }
  const today = assignmentDay(now.toISOString());
  const urgency = (item: MyAssignment) => { const day = assignmentDay(item.dueDate); return day < today ? 0 : day === today ? 1 : Number.isFinite(day) ? 2 : 3; };
  return items.sort((left, right) => urgency(left) - urgency(right) || assignmentDay(left.dueDate) - assignmentDay(right.dueDate) || left.priority - right.priority || right.updated.localeCompare(left.updated) || left.key.localeCompare(right.key));
}

type List = (input: QaListInput, signal?: AbortSignal) => Promise<QaListResult>;
/** A preview page's length is never used as the total. Incomplete reads fail closed. */
export async function loadMyQaAssignments(list: List, signal?: AbortSignal): Promise<QaIssue[]> {
  const acquire = async (mine: 'assigned' | 'testing' | 'handoff') => {
    for (let attempt = 0; attempt < 2; attempt++) {
      const issues = new Map<string, QaIssue>();
      let offset = 0, total: number | undefined, changed = false;
      for (;;) {
        if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
        const page = await list({ mine, states: ACTIVE_QA_STATES, offset, limit: 100 }, signal);
        if (!Number.isInteger(page.total) || page.total < 0 || page.total > 100000 || (page.hasMore && !page.issues.length)) throw new Error('incomplete_assignments');
        total ??= page.total;
        if (page.total !== total) changed = true;
        for (const issue of page.issues) { if (issues.has(issue.id)) changed = true; issues.set(issue.id, issue); }
        offset += page.issues.length;
        if (!page.hasMore) break;
        if (offset >= page.total || offset > 100000) throw new Error('incomplete_assignments');
      }
      if (!changed && issues.size === total) return [...issues.values()];
    }
    throw new Error('incomplete_assignments');
  };
  const [assigned, testing, handoff] = await Promise.all([acquire('assigned'), acquire('testing'), acquire('handoff')]);
  return [...new Map([...assigned, ...testing, ...handoff].map(issue => [issue.id, issue])).values()];
}
