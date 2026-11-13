import { act, cleanup, fireEvent, render, renderHook, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { User } from '@/types';
import { sortUsersByDept } from '@/lib/department';
import { mentionSuggestions } from '@/lib/mentions';
import { useMemberState } from '@/context/hooks/useMemberState';
import UserSelect from '@/components/UserSelect';

const state = vi.hoisted(() => ({ users: [] as User[], rows: [] as Record<string, unknown>[] }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('@/context/MemberContext', () => ({ useMemberContext: () => ({ users: state.users }) }));
vi.mock('@/integrations/supabase/client', () => ({ supabase: {
  from: () => ({ select: () => ({ order: async () => ({ data: state.rows, error: null as null }) }) }),
} }));

const person = (id: string, name: string, sortOrder: number, isActive = true): User => ({
  id, name, sortOrder, isActive, jobTitle: 'Engineer', role: 'member', avatar: name[0],
  color: '#123456', email: `${id}@example.com`,
});
const orderedIds = (users: User[]) => users.map(user => user.id);
beforeEach(() => {
  state.users = [person('c', 'Alpha match', 3), person('b', 'Match Baker', 2),
    person('inactive', 'Inactive', 0, false), person('a', 'Zulu match', 1)];
  state.rows = [];
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { configurable: true, value: vi.fn() });
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); Reflect.deleteProperty(HTMLElement.prototype, 'scrollIntoView'); });

describe('default member order across loads and member pickers', () => {
  it('normalizes both first-load setter and later refresh without changing eligibility or the input array', async () => {
    const input = [...state.users];
    const { result } = renderHook(useMemberState);
    act(() => result.current.setUsers(input));
    expect(orderedIds(result.current.users)).toEqual(['inactive', 'a', 'b', 'c']);
    expect(orderedIds(input)).toEqual(['c', 'b', 'inactive', 'a']);
    expect(result.current.users.find(user => user.id === 'inactive')?.isActive).toBe(false);
    state.rows = input.map(user => ({ ...user, job_title: user.jobTitle, is_active: user.isActive,
      sort_order: user.id === 'c' ? -1 : user.sortOrder }));
    await act(async () => result.current.refreshUsers());
    expect(orderedIds(result.current.users)).toEqual(['c', 'inactive', 'a', 'b']);
  });

  it('uses IDs for equal or absent ranks, keeping missing ranks at the shared default position', () => {
    const input = [{ id: 'z', sortOrder: 2 }, { id: 'b' }, { id: 'a', sortOrder: 99 },
      { id: 'q', sortOrder: 2 }, { id: 'last', sortOrder: 101 }];
    expect(sortUsersByDept(input).map(user => user.id)).toEqual(['q', 'z', 'a', 'b', 'last']);
    expect(input[0].id).toBe('z');
  });

  it('keeps dropdown, search and hidden form options in team order without promoting a suggested or selected member', () => {
    const view = render(<form><UserSelect label="Assignee" name="owner" value="c" activeOnly
      allowEmpty emptyLabel="Unassigned" preferredUserIds={['c']} /></form>);
    fireEvent.click(screen.getByRole('combobox', { name: 'Assignee' }));
    const labels = () => within(screen.getByRole('listbox')).getAllByRole('option')
      .map(option => option.textContent?.replace(/Engineer/g, '').trim());
    expect(labels()).toEqual(['Unassigned', 'ZZulu match', 'MMatch Baker', 'AAlpha match']);
    fireEvent.change(screen.getByRole('combobox', { name: /common.search/ }), { target: { value: 'match' } });
    expect(labels()).toEqual(['Unassigned', 'ZZulu match', 'MMatch Baker', 'AAlpha match']);
    expect(Array.from(view.container.querySelectorAll('select[name="owner"] option')).map(option => option.getAttribute('value')))
      .toEqual(['', 'a', 'b', 'c']);
    expect(view.container.querySelector('select[name="owner"]')?.getAttribute('required')).toBeNull();
  });

  it('keeps matching mention suggestions in team order instead of promoting a name prefix', () => {
    expect(orderedIds(mentionSuggestions(state.users, 'match'))).toEqual(['a', 'b', 'c']);
    expect(orderedIds(mentionSuggestions(state.users, ''))).toEqual(['a', 'b', 'c']);
  });
});
