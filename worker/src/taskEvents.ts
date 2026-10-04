import type { Env } from './env';
import { rowToWire } from './meta';
import type { ChangeEvent } from './protocol';
import { TABLES } from './tables';

/**
 * Replace each `tasks` change event's row with the full stored row.
 *
 * Command endpoints return only the fields they changed (approval: 7 columns,
 * deadline: 5, acknowledgement: a few), but realtime subscribers replace the
 * whole card with the payload (useHighFreqSubs → mapTask), so a partial row made
 * the card lose its title, project and status on every open client until reload.
 * DELETE events and other tables pass through unchanged. If a task can no longer
 * be read (or the read fails), its event is dropped rather than broadcast
 * half-empty; the command's own response is never affected.
 */
export async function withFullTaskRows(env: Env, workspaceId: string, events: ChangeEvent[]): Promise<ChangeEvent[]> {
  const ids = [...new Set(events
    .filter((event) => event.table === 'tasks' && event.eventType !== 'DELETE' && typeof event.new?.id === 'string')
    .map((event) => event.new!.id as string))];
  if (!ids.length) return events;
  let rows = new Map<string, Record<string, unknown>>();
  try {
    const { results } = await env.DB.prepare(
      `SELECT * FROM tasks WHERE workspace_id = ? AND id IN (${ids.map(() => '?').join(',')})`,
    ).bind(workspaceId, ...ids).all<Record<string, unknown>>();
    rows = new Map((results || []).map((row) => [String(row.id), rowToWire(row, TABLES.tasks)]));
  } catch {
    // Realtime is best-effort: the command already committed, so never fail it here.
  }
  return events.flatMap((event) => {
    if (event.table !== 'tasks' || event.eventType === 'DELETE' || typeof event.new?.id !== 'string') return [event];
    const row = rows.get(event.new.id as string);
    return row ? [{ ...event, new: row }] : [];
  });
}
