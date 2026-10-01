import { describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/integrations/supabase/types';
import { withdrawApproval, withdrawAllAndDisable } from '@/lib/withdrawApproval';

type Row = Record<string, unknown>;
function fixture(failTable?: string) {
  const rows: Record<string, Row[]> = {
    approval_requests: [{ id: 'request-1', task_id: 'task-1', requested_by: 'member-1', status: 'pending' }],
    tasks: [{ id: 'task-1', approval_status: 'pending_approval', current_approval_id: 'request-1' }],
  };
  const from = (table: string) => {
    const filters: [string, unknown][] = [];
    let update: Row | undefined;
    const result = (single = false): { data: Row | Row[] | null; error: Error | null } => {
      if (table === failTable) return { data: null, error: new Error('Write failed') };
      const selected = rows[table].filter(row => filters.every(([key, value]) => row[key] === value));
      if (update) selected.forEach(row => Object.assign(row, update));
      return { data: single ? selected[0] ?? null : selected, error: null };
    };
    const query = {
      select: () => query,
      eq: (key: string, value: unknown) => { filters.push([key, value]); return query; },
      update: (value: Row) => { update = value; return query; },
      single: async () => result(true),
      maybeSingle: async () => result(true),
      then: (resolve: (value: ReturnType<typeof result>) => unknown) => Promise.resolve(result()).then(resolve),
    };
    return query;
  };
  return { rows, db: { from } as unknown as SupabaseClient<Database> };
}

describe('shared approval withdrawal', () => {
  it.each([
    { id: 'member-1', role: 'member' },
    { id: 'admin-1', role: 'admin' },
    { id: 'admin-2', role: 'super_admin' },
  ])('clears both task fields and records history for $role', async actor => {
    const { rows, db } = fixture();
    const record = vi.fn(async () => {});
    await withdrawApproval(db, 'request-1', actor, record);
    expect(rows.approval_requests[0].status).toBe('cancelled');
    expect(rows.tasks[0]).toMatchObject({ approval_status: null, current_approval_id: null });
    expect(record).toHaveBeenCalledOnce();
  });
  it('rejects a member withdrawing another requester', async () => {
    const { rows, db } = fixture();
    await expect(withdrawApproval(db, 'request-1', { id: 'member-2', role: 'member' }, vi.fn()))
      .rejects.toThrow('Not allowed');
    expect(rows.approval_requests[0].status).toBe('pending');
  });
  it('never clears a newer request linked to the same task', async () => {
    const { rows, db } = fixture();
    rows.tasks[0].current_approval_id = 'request-new';
    await withdrawApproval(db, 'request-1', { id: 'admin-1', role: 'admin' }, vi.fn());
    expect(rows.tasks[0].current_approval_id).toBe('request-new');
  });
  it('retries interrupted task cleanup without duplicating activity', async () => {
    const { rows, db } = fixture();
    rows.approval_requests[0].status = 'cancelled';
    const record = vi.fn();
    await withdrawApproval(db, 'request-1', { id: 'member-1' }, record);
    expect(rows.tasks[0].approval_status).toBeNull();
    expect(record).not.toHaveBeenCalled();
  });
  it('withdraws all through the shared path before saving OFF', async () => {
    const { rows, db } = fixture();
    const record = vi.fn();
    const withdraw = vi.fn(async (id: string) => {
      await withdrawApproval(db, id, { id: 'admin-1', role: 'admin' }, record);
      return true;
    });
    const disable = vi.fn(async () => {
      expect(rows.tasks.every(task => task.approval_status !== 'pending_approval')).toBe(true);
    });
    await withdrawAllAndDisable([{ id: 'request-1' }], withdraw,
      async () => rows.approval_requests.filter(request => request.status === 'pending'), disable);
    expect(withdraw).toHaveBeenCalledWith('request-1');
    expect(disable).toHaveBeenCalledOnce();
    expect(record).toHaveBeenCalledOnce();
  });
  it('does not turn OFF after a failed withdrawal or a concurrent new request', async () => {
    const disable = vi.fn();
    await expect(withdrawAllAndDisable([{ id: 'request-1' }], async () => false, async () => [], disable)).rejects.toThrow();
    await expect(withdrawAllAndDisable([], async () => true, async () => [{ id: 'new' }], disable)).rejects.toThrow();
    expect(disable).not.toHaveBeenCalled();
  });
  it('propagates task cleanup errors instead of claiming completion', async () => {
    const { db } = fixture('tasks');
    await expect(withdrawApproval(db, 'request-1', { id: 'admin-1', role: 'admin' }, vi.fn())).rejects.toThrow('Write failed');
  });
});
