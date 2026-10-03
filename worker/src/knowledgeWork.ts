import type { Context } from 'hono';
import type { AppContext, AuthCtx, Env } from './env';
import { qaReadBody } from './qa';
import { notifyChanges } from './notify';
import { KnowledgeWorkError, knowledgeWorkError, parseKnowledgeWorkCommand, parseKnowledgeWorkQuery } from './knowledgeWork/core';
import { KNOWLEDGE_SNAPSHOT_TABLES, knowledgeDetail, planKnowledgeCommand, queryKnowledgeState, type KnowledgeState, type KnowledgeRow } from './knowledgeWork/engine';

export async function knowledgeSnapshot(env: Env, auth: AuthCtx, commandId: string | null = null): Promise<KnowledgeState> {
  const ws = auth.member.workspaceId;
  const queries = [env.DB.prepare(`SELECT m.id FROM members m JOIN auth_users u ON u.id=m.auth_id WHERE m.workspace_id=? AND m.id=? AND m.auth_id=? AND m.is_active=1 AND COALESCE(u.banned,0)=0`).bind(ws, auth.member.id, auth.userId),
    env.DB.prepare('SELECT generation FROM kb_work_clock WHERE workspace_id=?').bind(ws),
    ...KNOWLEDGE_SNAPSHOT_TABLES.map(name => name === 'kb_work_receipts'
      ? env.DB.prepare('SELECT * FROM kb_work_receipts WHERE workspace_id=? AND id=?').bind(ws, commandId)
      : env.DB.prepare(`SELECT * FROM ${name} WHERE workspace_id=?`).bind(ws))];
  const rows = await env.DB.batch<KnowledgeRow>(queries);
  if (rows[0].results.length !== 1 || rows[1].results.length !== 1) throw new KnowledgeWorkError('knowledge_forbidden', 403);
  const tables: KnowledgeState['tables'] = {};
  let total = 0;
  KNOWLEDGE_SNAPSHOT_TABLES.forEach((name, i) => {
    const values = rows[i + 2].results; total += values.length;
    if (total > 100000 || new TextEncoder().encode(JSON.stringify(values)).byteLength > 25000000) throw new KnowledgeWorkError('knowledge_incomplete_source', 409);
    tables[name] = values;
  });
  return { generation: Number(rows[1].results[0].generation), workspaceId: ws, authId: auth.userId, tables };
}
const encoded = (value: unknown) => value !== null && typeof value === 'object' ? JSON.stringify(value) : typeof value === 'boolean' ? Number(value) : value;
export async function executeKnowledgeWork(env: Env, auth: AuthCtx, input: unknown) {
  const command = parseKnowledgeWorkCommand(input), state = await knowledgeSnapshot(env, auth, command.commandId);
  const plan = await planKnowledgeCommand(state, command, () => crypto.randomUUID());
  if (plan.result.replayed) return plan.result;
  const ws = state.workspaceId, statements: D1PreparedStatement[] = [env.DB.prepare(`INSERT INTO kb_work_contexts(workspace_id,id,actor_id,auth_id,page_id,operation,expected_generation,lease_pages) VALUES(?,?,?,?,?,?,?,?)`)
    .bind(ws, command.commandId, plan.actorId, auth.userId, plan.pageId, command.operation, plan.generation, JSON.stringify(plan.leasePageIds))];
  for (const id of plan.leasePageIds) statements.push(env.DB.prepare(`INSERT INTO field_locks(workspace_id,lock_key,locked_by,expires_at) VALUES(?,?,?,strftime('%Y-%m-%dT%H:%M:%fZ','now','+30 seconds'))
    ON CONFLICT(workspace_id,lock_key) DO UPDATE SET locked_by=excluded.locked_by,expires_at=excluded.expires_at`).bind(ws, `kb:${id}`, plan.actorId));
  for (const mutation of plan.mutations) {
    // Identifiers originate solely from the domain planner, not request strings.
    const keys = Object.keys(mutation.values), values = keys.map(k => encoded(mutation.values[k]));
    if (mutation.operation === 'insert') statements.push(env.DB.prepare(`INSERT ${mutation.table === 'kb_revisions' ? 'OR IGNORE ' : ''}INTO ${mutation.table}(workspace_id,id,${keys.join(',')}) VALUES(?,?,${keys.map(() => '?').join(',')})`).bind(ws, mutation.id, ...values));
    else if (mutation.operation === 'update') statements.push(env.DB.prepare(`UPDATE ${mutation.table} SET ${keys.map(k => `${k}=?`).join(',')} WHERE workspace_id=? AND id=?`).bind(...values, ws, mutation.id));
    else statements.push(env.DB.prepare(`DELETE FROM ${mutation.table} WHERE workspace_id=? AND id=?`).bind(ws, mutation.id));
  }
  statements.push(env.DB.prepare('INSERT INTO kb_work_receipts(workspace_id,id,actor_id,page_id,canonical,event_id) VALUES(?,?,?,?,?,?)').bind(ws, command.commandId, plan.actorId, plan.pageId, plan.canonical, plan.eventId));
  statements.push(env.DB.prepare('INSERT INTO kb_work_events(workspace_id,id,actor_id,page_id,command_id,operation) VALUES(?,?,?,?,?,?)').bind(ws, plan.eventId, plan.actorId, plan.pageId, command.commandId, command.operation));
  statements.push(env.DB.prepare('DELETE FROM kb_work_contexts WHERE workspace_id=? AND id=?').bind(ws, command.commandId));
  try { await env.DB.batch(statements); }
  catch (error) {
    const fresh = await knowledgeSnapshot(env, auth, command.commandId), replay = await planKnowledgeCommand(fresh, command, () => crypto.randomUUID());
    if (replay.result.replayed) return replay.result;
    throw knowledgeWorkError(error);
  }
  const fresh = await knowledgeSnapshot(env, auth, command.commandId);
  return { ...plan.result, page: await knowledgeDetail(fresh, plan.pageId) };
}
export async function handleKnowledgeWork(c: Context<AppContext>): Promise<Response> {
  try {
    const input = JSON.parse(new TextDecoder().decode(await qaReadBody(c, 524288)));
    if (!input || typeof input !== 'object' || !['query','command'].includes(input.type) || Object.keys(input).some(k => !['type',input.type].includes(k))) throw new KnowledgeWorkError('knowledge_invalid_input');
    const auth = c.get('auth');
    if (input.type === 'query') {const query=parseKnowledgeWorkQuery(input.query);return c.json(await queryKnowledgeState(await knowledgeSnapshot(c.env,auth,query.operation==='command_result'?query.commandId:null),query));}
    const result = await executeKnowledgeWork(c.env, auth, input.command);
    if (!result.replayed) notifyChanges(c.env, c.executionCtx, [{ table:'kb_pages', eventType:'UPDATE', new:{}, old:null }], auth.member.workspaceId);
    return c.json(result);
  } catch (error) { const e = error instanceof SyntaxError ? new KnowledgeWorkError('knowledge_invalid_input') : knowledgeWorkError(error); return c.json({ error:e.code }, e.status as 400); }
}
