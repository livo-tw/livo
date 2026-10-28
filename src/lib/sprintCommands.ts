import type { SprintCommand, SprintCommandResult, SprintIntent } from './sprintLifecycle';
import { randomUUID } from './generateId';

interface RpcClient {
  rpc(name: 'livo_sprint_command', args: { p_command: unknown }): PromiseLike<{ data: unknown; error: unknown }>;
}
const known = new Set(['sprint_invalid_input', 'sprint_unauthorized', 'sprint_forbidden', 'sprint_conflict', 'sprint_command_reused', 'sprint_not_found']);
export class SprintCommandError extends Error {
  constructor(public code: string, public uncertain = false) { super(code); }
}
export function sprintError(error: unknown): SprintCommandError {
  if (error instanceof SprintCommandError) return error;
  const value = error as { message?: unknown; code?: unknown } | null;
  for (const candidate of [value?.code, value?.message]) {
    if (typeof candidate === 'string' && known.has(candidate)) return new SprintCommandError(candidate);
  }
  return new SprintCommandError('sprint_transport_error', true);
}
function resultOf(data: unknown, command: SprintCommand): SprintCommandResult {
  if (!data || typeof data !== 'object') throw new SprintCommandError('sprint_transport_error', true);
  const value = data as SprintCommandResult;
  if (value.sprintId !== command.sprintId || !Number.isSafeInteger(value.version) || value.version < 1 ||
      ![value.completedCount, value.cancelledCount, value.pendingCount].every(n => Number.isSafeInteger(n) && n >= 0) ||
      ![value.pendingIds, value.taskIds, ...(value.carryIds === undefined ? [] : [value.carryIds])].every(ids => Array.isArray(ids) && ids.every(id => typeof id === 'string' && id.length > 0))) {
    throw new SprintCommandError('sprint_transport_error', true);
  }
  return value;
}
function intentKey(intent: SprintIntent) {
  return JSON.stringify(intent.operation === 'start' ? { ...intent, taskIds: [...new Set(intent.taskIds)].sort() } : intent);
}

/** One unresolved command at a time; double clicks and lost responses reuse its ID. */
export function createSprintCommandRunner(db: RpcClient) {
  let pending: { key: string; command: SprintCommand } | null = null;
  let flight: Promise<SprintCommandResult> | null = null;
  return {
    pending: () => pending?.command ?? null,
    run(intent: SprintIntent): Promise<SprintCommandResult> {
      const key = intentKey(intent);
      if (pending && pending.key !== key) return Promise.reject(new SprintCommandError('sprint_resolve_pending', true));
      if (flight) return flight;
      if (!pending) pending = { key, command: { ...intent, commandId: randomUUID() } as SprintCommand };
      const command = pending.command;
      flight = Promise.resolve().then(async () => {
        try {
          const { data, error } = await db.rpc('livo_sprint_command', { p_command: command });
          if (error) throw sprintError(error);
          const result = resultOf(data, command);
          pending = null;
          return result;
        } catch (error) {
          const failure = sprintError(error);
          if (!failure.uncertain) pending = null;
          throw failure;
        } finally { flight = null; }
      });
      return flight;
    },
  };
}
