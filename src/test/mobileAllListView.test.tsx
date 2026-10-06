import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import type { Task } from '@/types';
import type { BoardFilterState } from '@/hooks/useBoardFilters';

const state = vi.hoisted(() => ({
  mobile: true,
  windowStart: 0,
  windowSize: 2,
  openTask: vi.fn(),
  measure: vi.fn(),
  measureElement: vi.fn(),
  options: { count: 0, estimateSize: (): number => 0, getScrollElement: (): HTMLElement | null => null, getItemKey: (_index: number): string => '' },
}));
const first = { id: 'task-first', taskKey: 'EX-1', title: 'Alpha task with a long title', projectId: 'project-example', statusId: 'open', assigneeId: 'member-example', priority: 'medium', createdAt: '2026-10-07T00:00:00Z' } as Task;
const second = { ...first, id: 'task-second', taskKey: 'EX-2', title: 'Beta completed task', statusId: 'done' };
const third = { ...first, id: 'task-third', taskKey: 'EX-3', title: 'Gamma task outside the virtual window' };
const outside = { ...first, id: 'task-outside', taskKey: 'EX-4', title: 'Outside selected project', projectId: 'other-project' };

vi.mock('react-i18next', async importOriginal => ({ ...await importOriginal<typeof import('react-i18next')>(), useTranslation: () => ({ t: (key: string, options?: { key?: string }) => options?.key ? `${key} ${options.key}` : key }) }));
vi.mock('@/hooks/use-mobile', () => ({ useIsMobile: () => state.mobile }));
vi.mock('@/hooks/useProjectScope', () => ({ useProjectScope: () => ({ projectIds: new Set(['project-example']) }), useScopedProjectFilter: (): void => {} }));
vi.mock('@/context/UIContext', () => ({ useUIContext: () => ({ setSelectedTask: state.openTask }) }));
vi.mock('@/context/ProjectContext', () => ({ useProjectContext: () => ({ selectedProjectId: 'project-example', selectedLineId: null as string | null, allProjects: [{ id: 'project-example', name: 'Example project' }] }) }));
vi.mock('@/context/TaskContext', () => ({ useTaskContext: () => ({ allTasks: [first, second, third, outside], statuses: [{ id: 'open', name: 'Open', isDone: false, sortOrder: 0 }, { id: 'done', name: 'Completed', isDone: true, sortOrder: 1 }], tags: [] as never[] }) }));
vi.mock('@/context/MemberContext', () => ({ useMemberContext: () => ({ users: [{ id: 'member-example', name: 'Example assignee', sortOrder: 1 }] }) }));
vi.mock('@/context/SprintContext', () => ({ useSprintContext: () => ({ sprints: [] as never[] }) }));
vi.mock('@/hooks/useListColumns', () => ({ useListColumns: () => ({
  columnConfig: { visibleColumns: [{ key: 'taskKey', label: 'Key', fixed: true }, { key: 'title', label: 'Title', fixed: true }, { key: 'status', label: 'Status' }, { key: 'assignee', label: 'Assignee' }] },
  renderCell: (task: Task, key: string) => <span>{key === 'status' ? task.statusId === 'done' ? 'Completed' : 'Open' : key === 'assignee' ? 'Example assignee' : task[key as 'title' | 'taskKey']}</span>,
}) }));
vi.mock('@/components/ColumnConfigDropdown', () => ({ default: (): null => null }));
vi.mock('@/components/board/BoardFilterChips', () => ({ default: ({ filters }: { filters: BoardFilterState }) => <>
  <button onClick={() => filters.setFilterStatuses(['open'])}>Filter open</button>
  <button onClick={() => filters.setFilterStatuses(['missing'])}>Filter empty</button>
</> }));
vi.mock('@/components/BulkActionBar', () => ({ default: ({ selectedIds }: { selectedIds: Set<string> }) => <output aria-label="Selected tasks">{[...selectedIds].join(',')}</output> }));
vi.mock('@tanstack/react-virtual', () => {
  const virtualizer = {
    measure: state.measure,
    measureElement: state.measureElement,
    getTotalSize: () => state.options.count * state.options.estimateSize(),
    getVirtualItems: () => Array.from({ length: Math.min(state.windowSize, Math.max(0, state.options.count - state.windowStart)) }, (_, offset) => {
      const index = state.windowStart + offset;
      const size = state.options.estimateSize();
      return { index, key: state.options.getItemKey(index), start: index * size, end: (index + 1) * size, size };
    }),
  };
  return { useVirtualizer: (options: typeof state.options) => { state.options = options; return virtualizer; } };
});

import AllListView from '@/components/AllListView';

afterEach(() => {
  cleanup();
  state.mobile = true;
  state.windowStart = 0;
  state.windowSize = 2;
  state.openTask.mockClear();
  state.measure.mockClear();
  state.measureElement.mockClear();
  localStorage.clear();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('main navigation mobile task list', () => {
  it('shows measured cards with complete title, status and assignee, and opens the selected task', () => {
    render(<AllListView />);
    expect(screen.queryByRole('table')).toBeNull();
    const cards = screen.getAllByRole('article');
    expect(cards).toHaveLength(2);
    expect(cards[0]).toHaveTextContent('Gamma task outside the virtual window');
    expect(within(cards[0]).getByText('Open')).toBeInTheDocument();
    expect(within(cards[0]).getByText('Example assignee')).toBeInTheDocument();
    expect(cards[0]).toHaveAttribute('data-index', '0');
    expect(state.options.getItemKey(0)).toBe(third.id);
    expect(cards[1]).toHaveStyle({ transform: 'translateY(144px)' });
    expect(state.measureElement).toHaveBeenCalledWith(cards[0]);
    expect(screen.queryByText('Outside selected project')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'EX-3 Gamma task outside the virtual window' }));
    expect(state.openTask).toHaveBeenCalledExactlyOnceWith(third);
  });

  it('selects a card independently and selects all filtered tasks, including unrendered rows', () => {
    render(<AllListView />);
    const checkbox = screen.getByRole('checkbox', { name: 'list.selectTask EX-2' });
    expect(checkbox).toHaveClass('h-11', 'w-11');
    fireEvent.click(checkbox);
    expect(screen.getByLabelText('Selected tasks')).toHaveTextContent('task-second');
    expect(state.openTask).not.toHaveBeenCalled();
    const all = screen.getByRole('checkbox', { name: 'button.selectAll' });
    fireEvent.click(all);
    expect(all).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByLabelText('Selected tasks')).toHaveTextContent('task-first,task-second,task-third');
    expect(screen.queryByRole('checkbox', { name: 'list.selectTask EX-1' })).toBeNull();
    fireEvent.click(all);
    expect(screen.queryByLabelText('Selected tasks')).toBeNull();
  });

  it('prunes filtered-out selections and restores the same list from the empty filter state', () => {
    render(<AllListView />);
    fireEvent.click(screen.getByRole('checkbox', { name: 'list.selectTask EX-2' }));
    fireEvent.click(screen.getByRole('button', { name: 'filter.label' }));
    fireEvent.click(screen.getByRole('button', { name: 'Filter open' }));
    expect(screen.queryByLabelText('Selected tasks')).toBeNull();
    expect(screen.queryByText('Completed')).toBeNull();
    expect(screen.getAllByRole('article')).toHaveLength(2);
    fireEvent.click(screen.getByRole('button', { name: 'Filter empty' }));
    expect(screen.queryByRole('article')).toBeNull();
    expect(screen.getByText('list.noResults')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'button.clearAllFilters' }));
    expect(screen.getAllByRole('article')).toHaveLength(2);
    expect(screen.queryByLabelText('Selected tasks')).toBeNull();
  });

  it('sorts the same dataset and renders the next virtual window with the correct offset', () => {
    const { rerender } = render(<AllListView />);
    const titleSort = screen.getByRole('button', { name: 'Title' });
    fireEvent.click(titleSort);
    expect(titleSort).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getAllByRole('article')[0]).toHaveTextContent('Alpha task with a long title');
    expect(state.options.getItemKey(0)).toBe(first.id);
    state.windowStart = 2;
    rerender(<AllListView />);
    expect(screen.getAllByRole('article')).toHaveLength(1);
    expect(screen.getByRole('article')).toHaveTextContent('Gamma task outside the virtual window');
    expect(screen.getByRole('article')).toHaveStyle({ transform: 'translateY(288px)' });
    expect(JSON.parse(localStorage.getItem('livo.listSort.all') || '{}')).toEqual({ key: 'title', dir: 'asc' });
  });

  it('keeps desktop table sorting and selection, and clears measurements when the layout changes', () => {
    const { rerender } = render(<AllListView />);
    fireEvent.click(screen.getByRole('checkbox', { name: 'list.selectTask EX-2' }));
    expect(state.measure).toHaveBeenCalledTimes(1);
    state.mobile = false;
    rerender(<AllListView />);
    expect(screen.getByRole('table')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Filter open' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'filter.label' })).toBeNull();
    expect(screen.queryByRole('article')).toBeNull();
    expect(state.options.estimateSize()).toBe(41);
    expect(state.measure).toHaveBeenCalledTimes(2);
    expect(screen.getByLabelText('Selected tasks')).toHaveTextContent('task-second');
    fireEvent.click(screen.getByRole('columnheader', { name: 'Title' }));
    expect(screen.getAllByRole('row')[1]).toHaveTextContent('Alpha task with a long title');
    state.mobile = true;
    rerender(<AllListView />);
    expect(state.measure).toHaveBeenCalledTimes(3);
    expect(screen.getByRole('checkbox', { name: 'list.selectTask EX-2' })).toHaveAttribute('aria-checked', 'true');
  });

  it('exports all filtered and sorted tasks rather than just the virtual window', async () => {
    let downloaded: Blob | undefined;
    vi.stubGlobal('URL', class extends URL {
      static createObjectURL(blob: Blob): string { downloaded = blob; return 'blob:example'; }
      static revokeObjectURL(): void {}
    });
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation((): void => {});
    render(<AllListView />);
    fireEvent.click(screen.getByRole('button', { name: 'filter.label' }));
    fireEvent.click(screen.getByRole('button', { name: 'Filter open' }));
    fireEvent.click(screen.getByRole('button', { name: 'Title' }));
    state.windowSize = 1;
    fireEvent.click(screen.getByRole('button', { name: 'common.export' }));
    fireEvent.click(screen.getByRole('button', { name: 'CSV' }));
    expect(downloaded).toBeDefined();
    const csv = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.onerror = reject;
      reader.readAsText(downloaded!);
    });
    expect(csv).toContain('Alpha task with a long title');
    expect(csv).toContain('Gamma task outside the virtual window');
    expect(csv).not.toContain('Beta completed task');
    expect(csv).not.toContain('Outside selected project');
    expect(csv.indexOf('Alpha task with a long title')).toBeLessThan(csv.indexOf('Gamma task outside the virtual window'));
  });

  it('starts mobile filters collapsed and preserves active filters and their count when hidden', () => {
    render(<AllListView />);
    const toggle = screen.getByRole('button', { name: 'filter.label' });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(toggle).toHaveClass('min-h-11', 'min-w-11');
    expect(screen.queryByRole('button', { name: 'Filter open' })).toBeNull();
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    expect(document.getElementById(toggle.getAttribute('aria-controls')!)).toContainElement(screen.getByRole('button', { name: 'Filter open' }));
    fireEvent.click(screen.getByRole('button', { name: 'Filter open' }));
    expect(toggle).toHaveAccessibleName('filter.label 1');
    expect(screen.queryByText('Completed')).toBeNull();
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByRole('button', { name: 'Filter open' })).toBeNull();
    expect(toggle).toHaveAccessibleName('filter.label 1');
    expect(screen.getAllByRole('article')).toHaveLength(2);
    expect(screen.queryByText('Completed')).toBeNull();
    fireEvent.click(screen.getByRole('checkbox', { name: 'button.selectAll' }));
    expect(screen.getByLabelText('Selected tasks')).toHaveTextContent('task-first,task-third');
    fireEvent.click(toggle);
    expect(screen.getByRole('button', { name: 'Filter open' })).toBeInTheDocument();
    expect(screen.queryByText('Completed')).toBeNull();
  });
});
