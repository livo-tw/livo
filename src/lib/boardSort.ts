import type { Priority, Task } from '@/types';
import type { QaListInput } from '@/lib/qa/domain';

/**
 * Board sort rules shared by the task board and the QA board. Both offer the
 * same choices and directions; the QA server applies them per column
 * (compareQaIssues in qa/domain.ts), the task board in the browser.
 */
export type BoardSortField = 'default' | 'priority' | 'dueDate' | 'createdAt';
export type BoardSortDirection = 'asc' | 'desc';
export interface BoardSort { field: BoardSortField; direction: BoardSortDirection }
export const BOARD_SORT_FIELDS: BoardSortField[] = ['default', 'priority', 'dueDate', 'createdAt'];
export const DEFAULT_BOARD_SORT: BoardSort = { field: 'default', direction: 'desc' };
/** First direction when a field is picked: most important, earliest due, or newest first. */
export const boardSortDefaultDirection = (field: BoardSortField): BoardSortDirection => field === 'dueDate' ? 'asc' : 'desc';

/** Same 1 (highest) to 5 (lowest) scale as the stored QA priority. */
export const TASK_PRIORITY_RANK: Record<Priority, number> = { highest: 1, high: 2, medium: 3, low: 4, lowest: 5 };

/** Sorts tasks for display; ties and the default keep the loaded order. */
export function sortBoardTasks(tasks: Task[], sort: BoardSort): Task[] {
  if (sort.field === 'default') return tasks;
  const sign = sort.direction === 'asc' ? 1 : -1;
  const text = (left: string, right: string) => left < right ? -1 : left > right ? 1 : 0;
  const compare = (a: Task, b: Task): number => {
    if (sort.field === 'priority') return -sign * ((TASK_PRIORITY_RANK[a.priority] ?? 3) - (TASK_PRIORITY_RANK[b.priority] ?? 3));
    if (sort.field === 'createdAt') return sign * text(a.createdAt || '', b.createdAt || '');
    // Without a due date: last in both directions.
    if (!a.dueDate || !b.dueDate) return Number(!a.dueDate) - Number(!b.dueDate);
    return sign * text(a.dueDate, b.dueDate);
  };
  return tasks.map((task, index) => ({ task, index }))
    .sort((a, b) => compare(a.task, b.task) || a.index - b.index)
    .map(entry => entry.task);
}

/** The QA list request for a board sort; the QA default is "most recently updated". */
export function qaBoardSort(sort: BoardSort): Pick<QaListInput, 'sort' | 'direction'> {
  return sort.field === 'default' ? {} : { sort: sort.field, direction: sort.direction };
}

const storageKey = (board: 'tasks' | 'qa') => `livo.boardSort.${board}`;
/** A per-device preference; private windows or blocked storage fall back to the default. */
export function readBoardSort(board: 'tasks' | 'qa'): BoardSort {
  try {
    const value = JSON.parse(localStorage.getItem(storageKey(board)) || 'null') as Partial<BoardSort> | null;
    if (value && BOARD_SORT_FIELDS.includes(value.field as BoardSortField) && (value.direction === 'asc' || value.direction === 'desc'))
      return { field: value.field as BoardSortField, direction: value.direction };
  } catch { /* fall back to the default */ }
  return DEFAULT_BOARD_SORT;
}
export function writeBoardSort(board: 'tasks' | 'qa', sort: BoardSort) {
  try { localStorage.setItem(storageKey(board), JSON.stringify(sort)); } catch { /* the choice still applies until reload */ }
}
