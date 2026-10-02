// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { fetchComments } from '../lib/commentQueries';

describe('comment loading beyond the API row limit', () => {
  it('includes a newly inserted Slack comment after more than 1,000 existing rows', async () => {
    const rows = Array.from({ length: 1159 }, (_, index) => ({ id: `c-${String(index).padStart(4, '0')}` }));
    rows.push({ id: 'slack-new-comment' });
    const range = vi.fn(async (start: number, end: number) => ({ data: rows.slice(start, end + 1), error: null }));
    const order = vi.fn(() => ({ range }));
    const db = { from: vi.fn(() => ({ select: () => ({ order }) })) };
    const result = await fetchComments(db as any);
    expect(result.error).toBeNull();
    expect(result.data).toEqual(rows);
    expect(range).toHaveBeenCalledTimes(6);
    expect(order).toHaveBeenCalledWith('id');
  });

  it('does not replace a complete cache with a partial result when a later page fails', async () => {
    const error = { message: 'connection lost' };
    const range = vi.fn().mockResolvedValueOnce({ data: Array.from({ length: 200 }, (_, i) => ({ id: `c-${i}` })), error: null })
      .mockResolvedValueOnce({ data: null, error });
    const db = { from: () => ({ select: () => ({ order: () => ({ range }) }) }) };
    expect(await fetchComments(db as any)).toEqual({ data: null, error });
  });

  it('supports the complete local demo table without a server range API', async () => {
    const result: { data: { id: string }[]; error: null } = { data: [{ id: 'demo-comment' }], error: null };
    const db = { from: () => ({ select: () => ({ order: () => Promise.resolve(result) }) }) };
    expect(await fetchComments(db as any)).toEqual(result);
  });
});
