import type { Task, TaskDeployment } from '@/types';

type BoardReadError = { message: string };
type BoardPage<Row> = { data: Row[] | null; error: BoardReadError | null; count?: number | null };
type BoardQuery<Row> = PromiseLike<BoardPage<Row>> & {
  order(column: 'id'): BoardQuery<Row>;
  limit(size: number): BoardQuery<Row>;
  gt(column: 'id', cursor: string): BoardQuery<Row>;
};

const PAGE_SIZE = 500;
const COUNT = { count: 'exact' } as const;

/** Keyset pagination works with PostgREST's configurable cap and the cloud client. */
export async function fetchBoardRows<Row extends { id: string }>(
  build: (options?: typeof COUNT) => BoardQuery<Row>,
): Promise<BoardPage<Row>> {
  const rows: Row[] = [];
  const seen = new Set<string>();
  let cursor: string | undefined;
  for (;;) {
    try {
      const query = build(cursor === undefined ? COUNT : undefined).order('id').limit(PAGE_SIZE);
      const { data, error, count } = await (cursor === undefined ? query : query.gt('id', cursor));
      if (error) return { data: null, error };
      if (!data) return { data: null, error: { message: 'Board page returned no data' } };
      if (!data.length) return { data: rows, error: null };

      for (const row of data) {
        if (!row.id || seen.has(row.id)) {
          return { data: null, error: { message: 'Board pagination returned an invalid cursor' } };
        }
        seen.add(row.id);
        rows.push(row);
      }
      if (cursor === undefined && count === rows.length) return { data: rows, error: null };
      cursor = data[data.length - 1].id;
    } catch (error) {
      return { data: null, error: { message: error instanceof Error ? error.message : String(error) } };
    }
  }
}

export type BoardTaskEvent =
  | { kind: 'insert' | 'update'; task: Task }
  | { kind: 'delete'; id: string };

export type BoardTaskChanges = Map<string, { task: Task; inserted: boolean } | null>;

export type BeginBoardRead = (kind: 'startup' | 'refresh') => {
  isCurrent: () => boolean;
  publish: (tasks: Task[], deployments: Map<string, TaskDeployment[]>) => void;
  close: () => void;
};

export function applyBoardTaskChanges(tasks: Task[], changes: BoardTaskChanges): Task[] {
  if (!changes.size) return tasks;
  const byId = new Map(tasks.map(task => [task.id, task]));
  for (const [id, change] of changes) {
    if (!change) {
      byId.delete(id);
      continue;
    }
    const fetched = byId.get(id);
    if (fetched) {
      byId.set(id, {
        ...change.task,
        deployments: fetched.deployments,
        attachmentCount: fetched.attachmentCount,
        tagIds: fetched.tagIds,
      });
    } else if (change.inserted) {
      byId.set(id, change.task);
    }
  }
  return [...byId.values()];
}
