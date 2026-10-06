import { describe, expect, it, vi } from 'vitest';
import { pendingDeploymentTasks, pendingQaDeployments, readCompletePages, readPendingQa, type CompletePage } from '@/lib/deploymentQueueRows';
import type { Task } from '@/types';
import type { QaIssue } from '@/lib/qa/domain';
import { resolveDeploymentQueueView, resolveFeatureToggles } from '@/lib/featureToggles';

const issue = (patch: Partial<QaIssue> = {}): QaIssue => ({ id: 'example-bug', state: 'verification', closedAt: null, targets: [{ id: 'target', environment: 'Staging', component: '', build: '', required: true, deployedAt: null, deployedBy: null, deploymentEvidence: '' }], ...patch } as QaIssue);
describe('complete deployment queue reads', () => {
  it('reads every visible page and preserves the exact scoped count', async () => {
    const rows = Array.from({ length: 205 }, (_, n) => ({ id: `example-${n}` }));
    const read = vi.fn(async (offset: number, limit: number): Promise<CompletePage<{ id: string }>> => ({ data: rows.slice(offset, offset + limit), error: null, count: rows.length }));
    expect(await readCompletePages(read)).toHaveLength(205); expect(read).toHaveBeenCalledTimes(3);
  });
  it.each([
    { data: null, error: { message: 'denied' }, count: null },
    { data: [], error: null, count: null },
    { data: [], error: null, count: 1 },
    { data: [{ id: 'same' }, { id: 'same' }], error: null, count: 2 },
  ])('rejects an incomplete read instead of returning a zero queue: %j', async result => { await expect(readCompletePages(async () => result)).rejects.toThrow('incomplete'); });
  it('rejects a changed total across pages', async () => {
    const read = vi.fn().mockResolvedValueOnce({ data: Array.from({ length: 100 }, (_, n) => ({ id: `example-${n}` })), error: null, count: 101 }).mockResolvedValueOnce({ data: [{ id: 'last' }], error: null, count: 102 });
    await expect(readCompletePages(read)).rejects.toThrow('incomplete');
  });
  it('rejects revoked scope while a page is in flight', async () => {
    const controller = new AbortController();
    await expect(readCompletePages(async () => { controller.abort(); return { data: [], error: null, count: 0 }; }, controller.signal)).rejects.toThrow('aborted');
  });
  it('only acquires current verification stages through the scoped QA list API', async () => {
    const list = vi.fn().mockResolvedValue({ issues: [issue()], total: 1, hasMore: false });
    expect(await readPendingQa(list, ['example-project'])).toHaveLength(1);
    expect(list).toHaveBeenCalledWith(expect.objectContaining({ states: ['verification', 'verified'], projectIds: ['example-project'] }), undefined);
  });
  it('does not accept a misleading QA hasMore flag', async () => { await expect(readPendingQa(async () => ({ issues: [], total: 1, hasMore: false }), undefined)).rejects.toThrow('incomplete'); });
});
describe('existing deployment queue rows', () => {
  it('uses configured statuses and excludes terminal or completed tasks', () => {
    const tasks = ['pending', 'completed', 'done', 'other'].map(id => ({ id, statusId: id === 'done' ? 'done' : id === 'other' ? 'other' : 'wait', completedAt: id === 'completed' ? '2026-10-01' : undefined } as Task));
    expect(pendingDeploymentTasks(tasks, [{ id: 'wait', isDone: false }, { id: 'done', isDone: true }], ['wait', 'done']).map(t => t.id)).toEqual(['pending']);
    expect(pendingDeploymentTasks(tasks, [{ id: 'wait', isDone: false }], [])).toEqual([]);
  });
  it('includes optional current targets without inventing versions or environments', () => {
    const base = issue(); const optional = { ...base.targets[0], id: 'optional', required: false, environment: 'Production' };
    const deployed = { ...base.targets[0], id: 'deployed', deployedAt: '2026-10-01T00:00:00Z' };
    const rows = pendingQaDeployments([issue({ targets: [base.targets[0], optional, deployed] }), issue({ id: 'failed', state: 'failed' }), issue({ id: 'closed', state: 'closed' }), issue({ id: 'old-fix', state: 'in_progress' })]);
    expect(rows.map(row => row.target.id)).toEqual(['target', 'optional']); expect(rows.every(row => row.target.build === '')).toBe(true);
  });
  it('defaults the master switch off and redirects a disabled queue view', () => {
    expect(resolveFeatureToggles(undefined, { hasApprovalRules: false, hasApprovalRequests: false }).deploymentQueue).toBe(false);
    expect(resolveDeploymentQueueView('deployment-queue', false)).toBe('board'); expect(resolveDeploymentQueueView('deployment-queue', true)).toBe('deployment-queue');
  });
});
