import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ProjectCheckboxList, ProjectMultiSelect, ProjectSelectOptions } from '@/components/project/ProjectOptions';
import { groupProjectsByLine } from '@/lib/projectGroups';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('@/context/ProjectContext', () => ({ useProjectContext: () => ({ productLines: [
  { id: 'second', name: 'Second line' }, { id: 'first', name: 'First line' },
] }) }));
const lines = [{ id: 'second', name: 'Second line' }, { id: 'first', name: 'First line' }];
const projects = [
  { id: 'a', name: 'Shared name', lineId: 'first' },
  { id: 'b', name: 'Shared name', lineId: 'second' },
  { id: 'c', name: 'Archived', lineId: 'first', isArchived: true },
  { id: 'd', name: 'Missing line', lineId: 'missing' },
];
afterEach(cleanup);

describe('project selection renderers', () => {
  it('keeps native sentinel and current archived values, grouping identical names by line', () => {
    render(<select aria-label="Project" defaultValue="c"><option value="">All</option><ProjectSelectOptions groups={groupProjectsByLine(lines, projects, ['c'])} /></select>);
    expect(screen.getByRole('combobox')).toHaveValue('c');
    expect(screen.getAllByRole('group').map(group => group.getAttribute('label'))).toEqual(['Second line', 'First line', 'common.other']);
    expect(screen.getAllByRole('option').map(option => (option as HTMLOptionElement).value)).toEqual(['', 'b', 'a', 'c', 'd']);
  });

  it('keeps multi-select search and all-selection scoped to supplied active projects', () => {
    const toggle = vi.fn();
    render(<ProjectMultiSelect projects={projects} label="Project" selected={['b']} onToggle={toggle} />);
    fireEvent.click(screen.getByRole('button', { name: 'Shared name' }));
    expect(screen.getByText('Second line')).toBeInTheDocument();
    expect(screen.getByText('First line')).toBeInTheDocument();
    expect(screen.queryByText('Archived')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'button.selectAll' }));
    expect(toggle.mock.calls.map(([id]) => id)).toEqual(['a', 'd']);
    toggle.mockClear();
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Missing' } });
    expect(screen.queryByText('Second line')).not.toBeInTheDocument();
    expect(screen.queryByText('First line')).not.toBeInTheDocument();
    expect(screen.getByText('common.other')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'button.selectAll' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Missing line' }));
    expect(toggle).toHaveBeenCalledWith('d');
  });

  it('checkbox consumers preserve a supplied subset and never turn line headings into selections', () => {
    const toggle = vi.fn();
    const { container } = render(<ProjectCheckboxList groups={groupProjectsByLine(lines, [projects[1], projects[2]], { archived: 'all' })} selected={['c']} onToggle={toggle} />);
    expect(screen.getAllByRole('checkbox')).toHaveLength(2);
    expect(screen.getByRole('checkbox', { name: 'Archived' })).toBeChecked();
    fireEvent.click(screen.getByText('First line'));
    expect(toggle).not.toHaveBeenCalled();
    fireEvent.click(within(container).getByRole('checkbox', { name: 'Shared name' }));
    expect(toggle).toHaveBeenCalledWith('b');
  });
});
