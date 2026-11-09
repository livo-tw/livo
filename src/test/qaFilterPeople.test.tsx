import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { useQaFilterPeople } from '@/hooks/useQaFilterPeople';
import type { QaClient, QaFilterPerson } from '@/lib/qa/client';

vi.mock('@/context/ExternalQaContext', () => ({ useExternalQa: () => false }));
vi.mock('@/lib/apiBase', () => ({ USE_CF_BACKEND: false }));
vi.mock('@/integrations/supabase/client', () => ({ USING_MOCK_BACKEND: false }));
afterEach(cleanup);

type Page = { members: QaFilterPerson[]; hasMore: boolean };
const person = (id: string, active = true): QaFilterPerson => ({ id, name: `Example ${id}`, isActive: active });

it('offers filter labels only after every scope page is read, preserving historical inactive people', async () => {
  let finish!: (page: Page) => void;
  const filterPeople = vi.fn(({ offset }: { offset?: number }) => offset === 0
    ? Promise.resolve({ members: [person('first')], hasMore: true })
    : new Promise<Page>(resolve => { finish = resolve; }));
  const { result } = renderHook(() => useQaFilterPeople({ filterPeople }, ['project-b', 'project-a'], 'example-admin'));
  await waitFor(() => expect(filterPeople).toHaveBeenCalledTimes(2));
  expect(result.current.people).toBeUndefined();
  expect(result.current.loading).toBe(true);
  await act(async () => finish({ members: [person('historical', false)], hasMore: false }));
  expect(result.current.people).toEqual([person('first'), person('historical', false)]);
  expect(result.current.loading).toBe(false);
  expect(filterPeople.mock.calls[0][0]).toEqual({ projectIds: ['project-a', 'project-b'], offset: 0 });
  expect(filterPeople.mock.calls[1][0]).toEqual({ projectIds: ['project-a', 'project-b'], offset: 100 });
});

it('aborts a previous scope and prevents its late page from restoring old filter labels', async () => {
  let finish!: (page: Page) => void;
  let previousSignal: AbortSignal | undefined;
  const filterPeople = vi.fn(({ projectIds }: { projectIds?: string[] }, signal?: AbortSignal) => {
    if (projectIds?.[0] === 'old-project') {
      previousSignal = signal;
      return new Promise<Page>(resolve => { finish = resolve; });
    }
    return Promise.resolve({ members: [person('current')], hasMore: false });
  });
  const client = { filterPeople } as Pick<QaClient, 'filterPeople'>;
  const { result, rerender } = renderHook(({ projectIds }) => useQaFilterPeople(client, projectIds, 'example-admin'), { initialProps: { projectIds: ['old-project'] } });
  await waitFor(() => expect(filterPeople).toHaveBeenCalledTimes(1));
  rerender({ projectIds: ['new-project'] });
  await waitFor(() => expect(result.current.people).toEqual([person('current')]));
  expect(previousSignal?.aborted).toBe(true);
  await act(async () => finish({ members: [person('old')], hasMore: false }));
  expect(result.current.people).toEqual([person('current')]);
});

it('does not offer a partial directory after a failed page and retries from the beginning', async () => {
  const filterPeople = vi.fn().mockResolvedValueOnce({ members: [person('partial')], hasMore: true })
    .mockRejectedValueOnce(new Error('unavailable')).mockResolvedValue({ members: [person('complete')], hasMore: false });
  const { result } = renderHook(() => useQaFilterPeople({ filterPeople }, ['example-project'], 'example-admin'));
  await waitFor(() => expect(result.current.failed).toBe(true));
  expect(result.current.people).toBeUndefined();
  act(() => result.current.retry());
  await waitFor(() => expect(result.current.people).toEqual([person('complete')]));
  expect(filterPeople.mock.calls[2][0]).toEqual({ projectIds: ['example-project'], offset: 0 });
});
