// Fan change events out to the RealtimeHub Durable Object (fire-and-forget).
//
// One DO instance PER WORKSPACE: workspace 'default' keeps the historical
// name 'hub' (existing self-host/demo connections stay on the same instance),
// every other workspace gets 'ws:<id>'. The DO code itself is
// workspace-agnostic — isolation comes purely from instance routing, so a
// tenant's sockets can never observe another tenant's events or presence.

import type { ChangeEvent } from './protocol';
import type { Ctx, Env } from './env';
import { DEFAULT_WORKSPACE } from './env';

export function hubName(workspaceId: string): string {
  return workspaceId === DEFAULT_WORKSPACE ? 'hub' : `ws:${workspaceId}`;
}

export function notifyChanges(
  env: Env,
  ctx: Ctx,
  events: ChangeEvent[],
  workspaceId: string = DEFAULT_WORKSPACE
): void {
  if (!events.length) return;
  // KB events are invalidations only. Never broadcast private page/revision/comment bodies.
  events = events.map(e => e.table.startsWith('kb_') ? { ...e, new: {}, old: null } : e);
  const stub = env.REALTIME.get(env.REALTIME.idFromName(hubName(workspaceId)));
  ctx.waitUntil(
    stub
      .fetch('https://do/notify', { method: 'POST', body: JSON.stringify(events) })
      .catch(() => { /* realtime is best-effort; writes must not fail on notify */ })
  );
}
