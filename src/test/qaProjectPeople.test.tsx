// @vitest-environment jsdom
import type { ReactNode } from 'react';
import { renderHook, waitFor } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { MemberContext } from '@/context/MemberContext';
import { ExternalQaContext } from '@/context/ExternalQaContext';
import { useQaProjectPeople } from '@/hooks/useQaProjectPeople';
import type { User } from '@/types';

vi.mock('@/lib/apiBase', () => ({ USE_CF_BACKEND: false }));
vi.mock('@/integrations/supabase/client', () => ({ USING_MOCK_BACKEND: false }));

const internal: User = { id: 'internal', name: 'Internal QA', avatar: 'I', color: '', jobTitle: 'QA', isActive: true,
  role: 'member', email: 'qa@example.com', sortOrder: 0 };
const external = { id: 'external', name: 'Eligible external QA', isActive: true, isExternal: true };
const users = [internal];

it.each([false, true])('uses project-eligible QA assignment options (external viewer: %s)', async viewerExternal => {
  const projectPeople = vi.fn(async (_projectId: string, offset: number) => offset === 0
    ? { members: [external], hasMore: true }
    : { members: [{ id: 'eqa-internal-next', name: 'Next eligible QA', isActive: true, isExternal: false }], hasMore: false });
  const wrapper = ({ children }: { children: ReactNode }) => <ExternalQaContext.Provider value={viewerExternal}>
    <MemberContext.Provider value={{ users, refreshUsers: vi.fn(async () => {}) }}>{children}</MemberContext.Provider>
  </ExternalQaContext.Provider>;
  const { result } = renderHook(() => useQaProjectPeople({ projectPeople }, 'granted-project'), { wrapper });
  const ids = viewerExternal ? ['external', 'eqa-internal-next'] : ['internal', 'external', 'eqa-internal-next'];
  await waitFor(() => expect(result.current?.map(member => member.id)).toEqual(ids));
  expect(projectPeople.mock.calls.map(([projectId, offset]) => [projectId, offset])).toEqual([
    ['granted-project', 0], ['granted-project', 100],
  ]);
  expect(result.current?.find(member => member.id === 'eqa-internal-next')?.qaExternal).toBe(false);
  expect(result.current?.find(member => member.id === 'external')?.qaExternal).toBe(true);
  expect(users).toEqual([internal]);
});
