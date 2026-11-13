import { qaPersonDisplay } from '@/lib/qa/peopleDisplay';
import { qaRepairAssigneeOptions } from '@/lib/qa/assignmentPeople';
// @vitest-environment jsdom
import type { ReactNode } from 'react';
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { MemberContext } from '@/context/MemberContext';
import { ExternalQaContext } from '@/context/ExternalQaContext';
import { useQaProjectPeople } from '@/hooks/useQaProjectPeople';
import type { User } from '@/types';
import type { QaProjectPerson } from '@/lib/qa/client';

vi.mock('@/lib/apiBase', () => ({ USE_CF_BACKEND: false }));
vi.mock('@/integrations/supabase/client', () => ({ USING_MOCK_BACKEND: false }));
afterEach(cleanup);

const internal: User = { id: 'internal', name: 'Internal QA', avatar: 'I', color: '', jobTitle: 'QA', isActive: true,
  role: 'member', email: 'qa@example.com', sortOrder: 0 };
const external = { id: 'external', name: 'Eligible external QA', isActive: true, isExternal: true };
const users = [internal];

it.each([false, true])('uses project-eligible QA assignment options (external viewer: %s)', async viewerExternal => {
  const projectPeople = vi.fn(async (_projectId: string, offset: number) => offset === 0
    ? { members: [external], hasMore: true }
    : { members: [{ id: 'eqa-internal-next', name: 'Next eligible QA', isActive: true, isExternal: false }, { id: 'unknown-kind', name: 'Unknown kind', isActive: true }], hasMore: false });
  const wrapper = ({ children }: { children: ReactNode }) => <ExternalQaContext.Provider value={viewerExternal}>
    <MemberContext.Provider value={{ users, refreshUsers: vi.fn(async () => {}) }}>{children}</MemberContext.Provider>
  </ExternalQaContext.Provider>;
  const { result } = renderHook(() => useQaProjectPeople({ projectPeople }, 'granted-project'), { wrapper });
  const ids = viewerExternal ? ['eqa-internal-next', 'external', 'unknown-kind'] : ['internal', 'eqa-internal-next', 'external', 'unknown-kind'];
  await waitFor(() => expect(result.current?.map(member => member.id)).toEqual(ids));
  expect(projectPeople.mock.calls.map(([projectId, offset]) => [projectId, offset])).toEqual([
    ['granted-project', 0], ['granted-project', 100],
  ]);
  expect(result.current?.find(member => member.id === 'eqa-internal-next')?.qaExternal).toBe(false);
  expect(result.current?.find(member => member.id === 'external')?.qaExternal).toBe(true);
  const unknown = result.current!.find(member => member.id === 'unknown-kind')!;
  expect(unknown.qaExternal).toBe(true);
  expect(unknown.isExternal).toBeUndefined();
  expect(qaPersonDisplay(unknown).jobTitle).toBe('');
  expect(qaRepairAssigneeOptions(result.current)?.some(member => member.id === unknown.id)).toBe(false);
  expect(qaPersonDisplay(result.current!.find(member => member.id === 'external')!).jobTitle).toBe('QA');
  expect(users).toEqual([internal]);
});

it('waits for every page before ordering internal candidates by team position and external candidates by name', async () => {
  type Page = { members: QaProjectPerson[]; hasMore: boolean };
  let finish!: (page: Page) => void;
  const projectPeople = vi.fn(async (_projectId: string, offset: number): Promise<Page> => offset === 0
    ? { members: [{ id: 'member-later', name: 'Alpha internal', isActive: true, isExternal: false, sortOrder: 20 },
      { id: 'external-z', name: 'Zulu external', isActive: true, isExternal: true }], hasMore: true }
    : new Promise(resolve => { finish = resolve; }));
  const wrapper = ({ children }: { children: ReactNode }) => <ExternalQaContext.Provider value={true}>
    <MemberContext.Provider value={{ users, refreshUsers: vi.fn(async () => {}) }}>{children}</MemberContext.Provider>
  </ExternalQaContext.Provider>;
  const { result } = renderHook(() => useQaProjectPeople({ projectPeople }, 'granted-project'), { wrapper });
  await waitFor(() => expect(projectPeople).toHaveBeenCalledTimes(2));
  expect(result.current).toEqual([]);
  await act(async () => finish({ members: [
    { id: 'member-first', name: 'Zulu internal', isActive: false, isExternal: false, sortOrder: 2 },
    { id: 'external-a', name: 'alpha external', isActive: false, isExternal: true },
  ], hasMore: false }));
  expect(result.current?.map(person => person.id)).toEqual(['member-first', 'member-later', 'external-a', 'external-z']);
  expect(result.current?.find(person => person.id === 'member-first')).toMatchObject({ isActive: false, qaExternal: false, sortOrder: 2 });
  expect(result.current?.find(person => person.id === 'external-a')).toMatchObject({ isActive: false, qaExternal: true, sortOrder: 99 });
  expect(qaRepairAssigneeOptions(result.current)?.map(person => person.id)).toEqual(['member-first', 'member-later']);
});
