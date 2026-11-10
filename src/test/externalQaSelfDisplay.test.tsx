import { useContext } from 'react';
import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { AuthContext } from '@/context/AuthContext';
import { useMemberContext } from '@/context/MemberContext';
import UserSelect from '@/components/UserSelect';
import ExternalQaShell from '@/components/qa/ExternalQaShell';
import { parseWorkspaceProfile } from '@/lib/qa/externalProfile';
import { qaPersonDisplay } from '@/lib/qa/peopleDisplay';

vi.mock('react-i18next', async importOriginal => ({ ...await importOriginal<typeof import('react-i18next')>(),
  useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('@/integrations/supabase/client', () => ({ supabase: { auth: { signOut: vi.fn() } } }));
vi.mock('@/components/qa/QaWorkspace', () => ({ default: () => {
  const { users } = useMemberContext(), auth = useContext(AuthContext);
  return <><UserSelect label="Self profile" value="visitor" options={users} displayProfile={qaPersonDisplay} />
    <output aria-label="Raw job titles">{JSON.stringify({ actor: auth?.currentMember?.jobTitle, users: users.map(user => user.jobTitle) })}</output></>;
} }));
afterEach(cleanup);

it.each([false, true])('renders the external self through the shared display resolver (legacy directory row: %s)', existing => {
  const raw = { id: 'visitor', name: '🧪 Example tester', avatar: '', color: '', jobTitle: '', isActive: true };
  const profile = parseWorkspaceProfile({ external: true, id: raw.id, name: raw.name, qaEnabled: true, environments: ['Stage'],
    projects: [{ id: 'example-project', name: 'Example project' }], members: existing ? [raw] : [] });
  if (!profile.external) throw new Error('Expected external profile');
  const before = JSON.stringify(profile.members);
  const view = render(<ExternalQaShell profile={profile} reload={vi.fn(async () => {})} />);
  const header = within(view.container.querySelector('header')!);
  expect(header.getByText('🧪')).toHaveStyle({ backgroundColor: '#64748b' });
  expect(header.getByText('QA')).toBeInTheDocument();
  const picker = screen.getByRole('combobox', { name: 'Self profile' });
  expect(within(picker).getByText('🧪')).toBeInTheDocument();
  expect(within(picker).getByText('QA')).toBeInTheDocument();
  expect(screen.getByLabelText('Raw job titles')).toHaveTextContent('{"actor":"","users":[""]}');
  expect(JSON.stringify(profile.members)).toBe(before);
});
