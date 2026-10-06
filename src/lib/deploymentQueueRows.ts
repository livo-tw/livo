import type { Task, Status } from '@/types';
import type { QaIssue, QaListInput, QaListResult, QaTarget } from '@/lib/qa/domain';

const PAGE_SIZE = 100;
export type CompletePage<T> = { data: T[] | null; error: unknown; count: number | null };
/** Completeness is proved by exact totals, stable pages and unique IDs, not an empty fallback. */
export async function readCompletePages<T extends { id: string }>(read: (offset: number, limit: number) => PromiseLike<CompletePage<T>>, signal?: AbortSignal): Promise<T[]> {
  let total: number | null = null;
  const rows: T[] = [], seen = new Set<string>();
  for (let offset = 0; offset <= 100000; offset += PAGE_SIZE) {
    if (signal?.aborted) throw new Error('deployment-queue-read-aborted');
    const result = await read(offset, PAGE_SIZE);
    if (signal?.aborted) throw new Error('deployment-queue-read-aborted');
    if (result.error || !Array.isArray(result.data) || !Number.isInteger(result.count) || result.count! < 0 || result.count! > 100000 || (total !== null && total !== result.count)) throw new Error('deployment-queue-incomplete');
    total = result.count;
    for (const row of result.data) { if (!row || typeof row.id !== 'string' || seen.has(row.id)) throw new Error('deployment-queue-incomplete'); seen.add(row.id); rows.push(row); }
    if (rows.length === total) return rows;
    if (rows.length > total! || result.data.length !== PAGE_SIZE) throw new Error('deployment-queue-incomplete');
  }
  throw new Error('deployment-queue-incomplete');
}
export async function readPendingQa(list: (input: QaListInput, signal?: AbortSignal) => Promise<QaListResult>, projectIds: string[] | undefined, signal?: AbortSignal): Promise<QaIssue[]> {
  return readCompletePages(async (offset, limit) => {
    const result = await list({ states: ['verification', 'verified'], projectIds, offset, limit, sort: 'createdAt', direction: 'asc' }, signal);
    if (typeof result.hasMore !== 'boolean' || result.hasMore !== (offset + result.issues.length < result.total)) throw new Error('deployment-queue-incomplete');
    return { data: result.issues, count: result.total, error: null };
  }, signal);
}
export function pendingDeploymentTasks(tasks: readonly Task[], statuses: readonly Pick<Status, 'id' | 'isDone'>[], statusIds: readonly string[]): Task[] {
  const configured = new Set(statusIds), terminal = new Set(statuses.filter(s => s.isDone).map(s => s.id)), available = new Set(statuses.map(s => s.id));
  return tasks.filter(task => configured.has(task.statusId) && available.has(task.statusId) && !terminal.has(task.statusId) && !task.completedAt);
}
export type QaDeploymentRow = { id: string; issue: QaIssue; target: QaTarget };
export function pendingQaDeployments(issues: readonly QaIssue[]): QaDeploymentRow[] {
  return issues.filter(issue => ['verification', 'verified'].includes(issue.state) && !issue.closedAt).flatMap(issue => issue.targets.filter(target => !target.deployedAt).map(target => ({ id: `${issue.id}:${target.id}`, issue, target })));
}
