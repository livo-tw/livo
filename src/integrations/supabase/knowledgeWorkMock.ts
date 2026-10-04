import { hasKnowledgeRestoreData } from '@/lib/knowledgeWork/restoreGuard';
import { randomUUID } from '@/lib/generateId';
import { knowledgeCan, type KnowledgeActor, type KnowledgeAclPage } from '@/lib/knowledgeWork/access';
import { KnowledgeWorkError, parseKnowledgeWorkCommand, parseKnowledgeWorkQuery } from '@/lib/knowledgeWork/core';
import { KNOWLEDGE_SNAPSHOT_TABLES, knowledgeDetail, planKnowledgeCommand, queryKnowledgeState, type KnowledgeState, type KnowledgeRow } from '@/lib/knowledgeWork/engine';
type DB = Record<string, KnowledgeRow[]>;
const internal = (table: string) => table.startsWith('kb_work_') || ['kb_publications','kb_source_links'].includes(table);
const actor = (db: DB, authId: string | undefined): KnowledgeActor => {
  const rows = (db.members || []).filter(m => m.auth_id === authId && m.is_active !== false && m.is_active !== 0);
  if (!authId || rows.length !== 1) throw new KnowledgeWorkError('knowledge_forbidden', 403);
  return { ...rows[0], is_active: true } as unknown as KnowledgeActor;
};
export function knowledgeMockRestoreAvailable(db: DB,authId:string|undefined): boolean { const who=actor(db,authId); if(!['admin','super_admin'].includes(who.role)) throw new KnowledgeWorkError('knowledge_forbidden',403); return !hasKnowledgeRestoreData(db); }
export function knowledgeMockHasData(db:DB):boolean{return hasKnowledgeRestoreData(db);}
export function knowledgeMockVisible(db: DB, authId: string | undefined, name: string, row: KnowledgeRow): boolean {
  if (internal(name)) throw new KnowledgeWorkError('knowledge_forbidden', 403);
  const who = actor(db, authId), pages = (db.kb_pages || []) as unknown as KnowledgeAclPage[];
  if (name === 'field_locks') return !String(row.lock_key).startsWith('kb:') || knowledgeCan(pages, String(row.lock_key).slice(3), who, 'view');
  return !name.startsWith('kb_') || knowledgeCan(pages, String(name === 'kb_pages' ? row.id : row.page_id), who, 'view');
}
function insidePrivateDraft(db: DB, id: unknown): boolean {
  const seen = new Set<string>();
  for (let cursor = typeof id === 'string' ? id : null; cursor && !seen.has(cursor) && seen.size < 10;) {
    seen.add(cursor);
    const row = (db.kb_pages || []).find(p => p.id === cursor);
    if (!row) return false;
    if (row.private_draft_owner_id) return true;
    cursor = typeof row.parent_id === 'string' ? row.parent_id : null;
  }
  return false;
}
/** Mirrors the database cleanup when a page or attachment is deleted. */
export function knowledgeMockForgetDeleted(db: DB, name: string, row: KnowledgeRow): void {
  const links = db.kb_source_links || [];
  if (name === 'kb_attachments') { db.kb_source_links = links.filter(l => !(l.source_kind === 'knowledge_file' && l.source_id === row.id)); return; }
  if (name !== 'kb_pages') return;
  const files = new Set((db.kb_attachments || []).filter(a => a.page_id === row.id).map(a => a.id));
  db.kb_source_links = links.filter(l => l.page_id !== row.id && !(l.source_kind === 'knowledge' && l.source_id === row.id) && !(l.source_kind === 'knowledge_file' && files.has(l.source_id)));
  const gone = new Set((db.kb_publications || []).filter(p => p.page_id === row.id).map(p => p.id));
  db.kb_publications = (db.kb_publications || []).filter(p => p.page_id !== row.id)
    .map(p => ({ ...p, predecessor_id: gone.has(p.predecessor_id) ? null : p.predecessor_id, successor_id: gone.has(p.successor_id) ? null : p.successor_id }));
  for (const table of ['kb_work_receipts', 'kb_work_events']) db[table] = (db[table] || []).filter(r => r.page_id !== row.id);
}
export function knowledgeMockWriteGuard(db: DB, authId: string | undefined, name: string, before: KnowledgeRow | null, patch: KnowledgeRow): void {
  if (!name.startsWith('kb_')) return;
  if (internal(name) || name === 'kb_revisions') throw new KnowledgeWorkError('knowledge_forbidden', 403);
  const who = actor(db, authId), pages = (db.kb_pages || []) as unknown as KnowledgeAclPage[];
  if (name === 'kb_pages') {
    if (['private_draft_owner_id','document_metadata'].some(k => Object.prototype.hasOwnProperty.call(patch, k))) throw new KnowledgeWorkError('knowledge_forbidden', 403);
    const managementOnly=Object.keys(patch).every(k=>['access_policy','parent_id','admin_only','is_archived','updated_by'].includes(k));
    const canManage=!!before && ['admin','super_admin'].includes(who.role) && knowledgeCan(pages,String(before.id),who,'view');
    if (before && !knowledgeCan(pages, String(before.id), who, 'edit') && !(managementOnly && canManage)) throw new KnowledgeWorkError('knowledge_forbidden', 403);
    if (before?.private_draft_owner_id && ['parent_id','project_id','access_policy'].some(k => k in patch && JSON.stringify(patch[k]) !== JSON.stringify(before[k]))) throw new KnowledgeWorkError('knowledge_forbidden', 403);
    if (!['admin','super_admin'].includes(who.role) && (patch.admin_only || patch.is_archived || (patch.access_policy && JSON.stringify(patch.access_policy) !== '{"mode":"inherit"}') || (before && 'parent_id' in patch && patch.parent_id !== before.parent_id))) throw new KnowledgeWorkError('knowledge_forbidden', 403);
    if (patch.parent_id && !knowledgeCan(pages, String(patch.parent_id), who, 'edit')) throw new KnowledgeWorkError('knowledge_forbidden', 403);
    // A shared page must not disappear into a private draft (same rule as the database guards).
    if (before && patch.parent_id && patch.parent_id !== before.parent_id && insidePrivateDraft(db, patch.parent_id) && !insidePrivateDraft(db, before.id))
      throw new KnowledgeWorkError('kb_private_draft_parent', 409);
  } else {
    const id = String(before?.page_id || patch.page_id);
    if (!knowledgeCan(pages, id, who, name === 'kb_comments' ? 'comment' : 'edit')) throw new KnowledgeWorkError('knowledge_forbidden', 403);
  }
}
function snapshot(db: DB, authId: string | undefined): KnowledgeState {
  actor(db, authId);
  return { generation: 0, workspaceId: 'default', authId: authId!, tables: Object.fromEntries(KNOWLEDGE_SNAPSHOT_TABLES.map(t => [t,
    structuredClone(db[t] || []).map(row => t === 'members' ? { ...row, is_active: row.is_active !== false && row.is_active !== 0 } : row)])) };
}
export async function knowledgeWorkMock(db: DB, authId: string | undefined, input: unknown) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new KnowledgeWorkError('knowledge_invalid_input');
  const body = input as Record<string, unknown>;
  if (!['command','query'].includes(String(body.type)) || Object.keys(body).some(k => !['type',body.type].includes(k))) throw new KnowledgeWorkError('knowledge_invalid_input');
  const state = snapshot(db, authId), signature = JSON.stringify(state.tables);
  if (body.type === 'query') {
    const result = await queryKnowledgeState(state, parseKnowledgeWorkQuery(body.query));
    if (JSON.stringify(snapshot(db, authId).tables) !== signature) throw new KnowledgeWorkError('knowledge_conflict', 409);
    return result;
  }
  const plan = await planKnowledgeCommand(state, parseKnowledgeWorkCommand(body.command), randomUUID);
  if (JSON.stringify(snapshot(db, authId).tables) !== signature) throw new KnowledgeWorkError('knowledge_conflict', 409);
  if (plan.result.replayed) return plan.result;
  const next = structuredClone(db);
  for (const m of plan.mutations) {
    const rows = next[m.table] ||= [];
    if (m.operation === 'insert') {
      if (m.table !== 'kb_revisions' || !rows.some(r => r.page_id === m.values.page_id && r.version === m.values.version)) rows.push({ id:m.id, ...m.values });
    } else if (m.operation === 'delete') next[m.table] = rows.filter(r => r.id !== m.id);
    else { const row = rows.find(r => r.id === m.id); if (!row) throw new KnowledgeWorkError('knowledge_conflict', 409); Object.assign(row, m.values); }
  }
  (next.kb_work_receipts ||= []).push({ id:plan.command.commandId, actor_id:plan.actorId, page_id:plan.pageId, canonical:plan.canonical, event_id:plan.eventId });
  (next.kb_work_events ||= []).push({ id:plan.eventId, actor_id:plan.actorId, page_id:plan.pageId, command_id:plan.command.commandId, operation:plan.command.operation });
  const result = { ...plan.result, page:await knowledgeDetail(snapshot(next, authId), plan.pageId) };
  if (JSON.stringify(snapshot(db, authId).tables) !== signature) throw new KnowledgeWorkError('knowledge_conflict', 409);
  for (const key of new Set([...plan.mutations.map(m => m.table),'kb_work_receipts','kb_work_events'])) db[key] = next[key];
  return result;
}
