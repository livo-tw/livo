import { knowledgeCan, parseKnowledgePolicy, type KnowledgeAclPage, type KnowledgeActor } from './access.ts';
import { KnowledgeWorkError, canonicalKnowledgePayload, knowledgeDraftHtml, knowledgePreviewFingerprint,
  parseKnowledgeMetadata, parseKnowledgeWorkCommand, parseKnowledgeWorkQuery } from './core.ts';
import type { KnowledgeWorkCommand, KnowledgeWorkDetail, KnowledgePublication, KnowledgeMetadata, KnowledgeSourceKind, KnowledgeSourceRef,
  KnowledgeSearchItem, KnowledgeSearchResult, KnowledgeDraftPreview, KnowledgeWorkResult } from './core.ts';
export type KnowledgeRow = Record<string, unknown>;
export const KNOWLEDGE_SNAPSHOT_TABLES = ['members','projects','statuses','tasks','task_specs','task_attachments','qa_issues','qa_attachments',
  'kb_pages','kb_revisions','kb_attachments','kb_publications','kb_source_links','kb_work_receipts','field_locks','system_settings'] as const;
export type KnowledgeState = { generation: number; workspaceId: string; authId: string; tables: Record<string, KnowledgeRow[]> };
export type KnowledgeMutation = { table: 'kb_pages' | 'kb_revisions' | 'kb_publications' | 'kb_source_links'; operation: 'insert' | 'update' | 'delete'; id: string; values: KnowledgeRow };
export type KnowledgePlan = { actorId: string; pageId: string; generation: number; eventId: string; command: KnowledgeWorkCommand; canonical: string; mutations: KnowledgeMutation[]; leasePageIds: string[]; result: KnowledgeWorkResult };
const fail = (code = 'knowledge_forbidden', status = 403): never => { throw new KnowledgeWorkError(code, status); };
const bool = (v: unknown) => v === true || v === 1;
const str = (v: unknown) => typeof v === 'string' ? v : '';
const json = (v: unknown): unknown => { if (typeof v !== 'string') return v; try { return JSON.parse(v); } catch { return null; } };
const emptyMetadata: KnowledgeMetadata = { documentKind: null, ownerId: null, applicability: { productVersion: null, environment: null, summary: null } };
const metadata = (row: KnowledgeRow): KnowledgeMetadata => row.document_metadata ? parseKnowledgeMetadata(json(row.document_metadata)) : structuredClone(emptyMetadata);
const table = (s: KnowledgeState, key: string) => s.tables[key] || [];
const byId = (s: KnowledgeState, key: string, id: string) => table(s, key).find(r => r.id === id);
function actor(s: KnowledgeState): KnowledgeActor {
  const rows = table(s, 'members').filter(r => r.auth_id === s.authId && bool(r.is_active));
  if (rows.length !== 1 || !['member', 'admin', 'super_admin'].includes(str(rows[0].role))) return fail();
  return rows[0] as unknown as KnowledgeActor;
}
const aclPages = (s: KnowledgeState) => table(s, 'kb_pages') as unknown as KnowledgeAclPage[];
function can(s: KnowledgeState, id: string, action: 'view' | 'edit' = 'view'): boolean { return knowledgeCan(aclPages(s), id, actor(s), action); }
function page(s: KnowledgeState, id: string, edit = false): KnowledgeRow {
  const p = byId(s, 'kb_pages', id);
  if (!p || !can(s, id, edit ? 'edit' : 'view')) return fail('knowledge_unavailable', 404);
  if (p.project_id && !activeProject(s, str(p.project_id))) return fail('knowledge_unavailable', 404);
  return p;
}
const activeProject = (s: KnowledgeState, id: string) => { const p = byId(s, 'projects', id); return p && !bool(p.is_archived); };
const activeMember = (s: KnowledgeState, id: string) => { const m = byId(s, 'members', id); return m && bool(m.is_active) && ['member','admin','super_admin'].includes(str(m.role)); };
/** Source freshness is exact SHA-256 of the visible source representation, never an auth grant. */
async function digest(input: unknown): Promise<string> {
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(input))))].map(x => x.toString(16).padStart(2, '0')).join('');
}
const plain = (v: unknown) => str(v).replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '').replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '').replace(/<[^>]*>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').trim();
type Source = { ref: KnowledgeSourceRef; item: KnowledgeSearchItem; text: string; aclPageId: string | null };
function qaEnabled(s: KnowledgeState): boolean {
  const setting = table(s, 'system_settings').find(r => r.key === 'feature_toggles');
  const value = json(setting?.value) as Record<string, unknown> | null;
  return value?.qa === true;
}
async function source(s: KnowledgeState, kind: KnowledgeSourceKind, id: string): Promise<Source> {
  actor(s);
  let row: KnowledgeRow | undefined, title = '', body = '', projectId: string | null = null, aclPageId: string | null = null;
  let extra: Partial<KnowledgeSearchItem> = {}, freshness: unknown;
  if (kind === 'knowledge') {
    row = page(s, id); if (bool(row.is_archived)) return fail('knowledge_source_unavailable', 409);
    title = str(row.title); body = plain(row.body); projectId = row.project_id as string | null; aclPageId = id; freshness = row.version;
    const effective = table(s, 'kb_publications').find(p => p.page_id === id && p.state === 'effective');
    if (effective) { const pinned = publication(s, str(effective.id)); title = pinned.title; body = plain(pinned.body); freshness = [effective.id, pinned.page_version]; extra.publicationId=pinned.id; extra.publicationVersion=pinned.version; }
  } else if (kind === 'task') {
    row = byId(s, 'tasks', id); if (!row || !activeProject(s, str(row.project_id))) return fail('knowledge_source_unavailable', 409);
    const specs = table(s, 'task_specs').filter(r => r.task_id === id); if (specs.length > 1) return fail('knowledge_incomplete_source', 409);
    title = `${str(row.task_key)} ${str(row.title)}`.trim(); projectId = str(row.project_id); extra.taskKey = str(row.task_key);
    const status = byId(s, 'statuses', str(row.status_id));
    body = [plain(specs[0]?.requirement || row.description), `Status: ${str(status?.name) || str(row.status_id)}`, `Due: ${str(row.due_date) || '—'}`].filter(Boolean).join('\n');
    freshness = [row, specs[0] || null, status?.name || null];
  } else if (kind === 'qa') {
    row = byId(s, 'qa_issues', id); if (!qaEnabled(s) || !row || !activeProject(s, str(row.project_id))) return fail('knowledge_source_unavailable', 409);
    const data = json(row.data) as KnowledgeRow | null;
    title = str(row.title); projectId = str(row.project_id); freshness = row.version;
    body = [`State: ${str(row.state)}`, plain(data?.steps), plain(data?.expectedResult), plain(data?.actualResult)].filter(Boolean).join('\n');
  } else {
    const tableName = kind === 'knowledge_file' ? 'kb_attachments' : kind === 'task_file' ? 'task_attachments' : 'qa_attachments';
    row = byId(s, tableName, id); if (!row) return fail('knowledge_source_unavailable', 409);
    const parent = await source(s, kind === 'knowledge_file' ? 'knowledge' : kind === 'task_file' ? 'task' : 'qa', str(row.page_id || row.task_id || row.issue_id));
    title = str(row.file_name); projectId = parent.item.projectId; aclPageId = parent.aclPageId; freshness = row;
    extra = kind === 'knowledge_file' ? { pageId: str(row.page_id) } : kind === 'task_file' ? { taskId: str(row.task_id), taskKey: parent.item.taskKey } : { issueId: str(row.issue_id) };
    body = 'Attachment filename and metadata only; file contents were not read.';
  }
  const version = await digest(freshness), ref = { kind, id, version };
  const effective = kind === 'knowledge' && table(s, 'kb_publications').some(p => p.page_id === id && p.state === 'effective');
  return { ref, item: { ...ref, title, projectId, effective, ...extra }, text: body, aclPageId };
}
async function verifiedSource(s: KnowledgeState, ref: KnowledgeSourceRef): Promise<Source> {
  const result = await source(s, ref.kind, ref.id); if (result.ref.version !== ref.version) return fail('knowledge_conflict', 409); return result;
}
function publication(s: KnowledgeState, id: string): KnowledgePublication {
  const p = byId(s, 'kb_publications', id); if (!p) return fail('knowledge_unavailable', 404);
  page(s, str(p.page_id)); const revision = table(s, 'kb_revisions').find(r => r.page_id === p.page_id && r.version === p.page_version);
  if (!revision) return fail('knowledge_incomplete_source', 409);
  // A hidden predecessor/successor must not expose even its identifier through detail.
  const visibleId = (other: unknown) => { const v = byId(s, 'kb_publications', str(other)); return v && can(s, str(v.page_id)) ? str(other) : null; };
  return { id: str(p.id), page_id: str(p.page_id), page_version: Number(p.page_version), state: p.state as KnowledgePublication['state'], version: Number(p.version),
    predecessor_id: visibleId(p.predecessor_id), successor_id: visibleId(p.successor_id), published_by: str(p.published_by), published_at: str(p.published_at),
    title: str(revision.title), body: str(revision.body), metadata: metadata(revision) };
}
export async function knowledgeDetail(s: KnowledgeState, id: string): Promise<KnowledgeWorkDetail> {
  const p = page(s, id), a = actor(s), links: KnowledgeSourceRef[] = [], linkItems: KnowledgeSearchItem[] = [];
  for (const link of table(s, 'kb_source_links').filter(r => r.page_id === id)) {
    try {
      const value = await source(s, link.source_kind as KnowledgeSourceKind, str(link.source_id));
      const ref = { kind: link.source_kind as KnowledgeSourceKind, id: str(link.source_id), version: str(link.source_version) }; links.push(ref);
      const pinned = ref.kind === 'knowledge' ? table(s, 'kb_revisions').find(r => r.page_id === ref.id && r.version === link.source_page_version) : null;
      linkItems.push({ ...value.item, version: ref.version, ...(pinned ? { title:str(pinned.title) } : {}) });
    } catch { /* Unavailable source details and IDs stay private. */ }
  }
  const current = table(s, 'kb_publications').find(r => r.page_id === id && r.state === 'effective');
  return { pageId: id, pageVersion: Number(p.version), title: str(p.title), body: str(p.body), projectId: p.project_id as string | null, parentId: p.parent_id as string | null,
    privateDraftOwnerId: typeof p.private_draft_owner_id === 'string' ? p.private_draft_owner_id : null, metadata: metadata(p),
    publication: current ? publication(s, str(current.id)) : null, links, linkItems, canEdit: can(s, id, 'edit'),
    canShare: p.private_draft_owner_id === a.id && can(s, id, 'edit') };
}
export async function queryKnowledgeState(s: KnowledgeState, input: unknown): Promise<KnowledgeWorkDetail | KnowledgePublication | KnowledgeSearchResult | KnowledgeDraftPreview | {found:boolean;result?:KnowledgeWorkResult}> {
  actor(s); const q = parseKnowledgeWorkQuery(input);
  if(q.operation==='command_result'){const r=table(s,'kb_work_receipts').find(r=>r.id===q.commandId&&r.actor_id===actor(s).id);return r?{found:true,result:{commandId:q.commandId,replayed:true,eventId:str(r.event_id),page:await knowledgeDetail(s,str(r.page_id))}}:{found:false};}
  if (q.operation === 'detail') return knowledgeDetail(s, q.pageId);
  if (q.operation === 'publication') return publication(s, q.publicationId);
  if (q.operation === 'prepare_draft') {
    const refs: KnowledgeSourceRef[] = [], sections: string[] = [];
    for (const ref of q.input.sourceRefs) { const value = await verifiedSource(s, ref); refs.push(value.ref); sections.push(`${value.item.title}\n${value.text}`); }
    const title = q.input.title || `${q.input.kind === 'meeting' ? 'Meeting' : 'Weekly'} draft${q.input.period ? ` ${q.input.period.from} – ${q.input.period.to}` : ''}`;
    const text = [q.input.notes, ...sections].filter(Boolean).join('\n\n');
    if (text.length > 100000) return fail('knowledge_incomplete_source', 409);
    return { kind: q.input.kind, title, text, sourceRefs: refs, period: q.input.period || null,
      coverage: { complete: true, sources: refs.length, unavailable: 0, limitations: ['selected_sources_only', 'attachment_metadata_only', 'not_a_confirmed_decision'] }, previewFingerprint: knowledgePreviewFingerprint(refs) };
  }
  const rows: KnowledgeSearchItem[] = [], kinds = q.operation === 'drafts' ? ['knowledge'] as KnowledgeSourceKind[] : q.types;
  const sourceTables = { knowledge:'kb_pages', task:'tasks', qa:'qa_issues', knowledge_file:'kb_attachments', task_file:'task_attachments', qa_file:'qa_attachments' };
  for (const kind of kinds) for (const row of table(s, sourceTables[kind])) {
    if (q.operation === 'drafts' && row.private_draft_owner_id !== actor(s).id) continue;
    try {
      const value = await source(s, kind, str(row.id));
      if (q.operation === 'search') {
        if (q.projectIds.length && !q.projectIds.includes(value.item.projectId || '')) continue;
        if (q.effectiveOnly && !value.item.effective) continue;
        // Current body and filename search, but published results use only the pinned effective revision.
        let haystack = `${value.item.title}\n${kind === 'knowledge' || kind === 'task' || kind === 'qa' ? value.text : ''}`;
        if (q.effectiveOnly && kind === 'knowledge') { const pub = table(s, 'kb_publications').find(p => p.page_id === row.id && p.state === 'effective')!; const pinned = publication(s, str(pub.id)); haystack = `${pinned.title}\n${plain(pinned.body)}`; value.item.title = pinned.title; }
        if (!haystack.toLocaleLowerCase().includes(q.query.toLocaleLowerCase())) continue;
      }
      rows.push(value.item);
    } catch (error) { if (!(error instanceof KnowledgeWorkError)) throw error; }
  }
  rows.sort((a,b) => a.title.localeCompare(b.title) || a.kind.localeCompare(b.kind) || a.id.localeCompare(b.id));
  return { items: rows.slice(q.cursor, q.cursor + 20), nextCursor: rows.length > q.cursor + 20 ? q.cursor + 20 : null,
    coverage: { complete: true, sources: rows.length, unavailable: 0, limitations: ['attachment_metadata_only'] } };
}
function ancestorPolicies(s: KnowledgeState, id: string | null): string[] {
  const policies: string[] = [], seen = new Set<string>();
  while (id) { if (seen.has(id) || seen.size >= 3) return fail('knowledge_cycle', 409); seen.add(id);
    const p = page(s, id); if (p.private_draft_owner_id) return fail('knowledge_scope_conflict', 409);
    const policy = parseKnowledgePolicy(p.access_policy); if (!policy) return fail();
    if (policy.mode === 'custom') policies.push(JSON.stringify(policy.view)); id = p.parent_id as string | null;
  }
  return policies;
}
function scopeSafe(s: KnowledgeState, sourcePage: string | null, targetPage: string | null) {
  if (!sourcePage) return;
  const required = ancestorPolicies(s, sourcePage), allowed = ancestorPolicies(s, targetPage);
  if (required.some(rule => !allowed.includes(rule))) fail('knowledge_scope_conflict', 409);
}
export async function planKnowledgeCommand(state: KnowledgeState, input: unknown, makeId: () => string, now = new Date().toISOString()): Promise<KnowledgePlan> {
  const command = parseKnowledgeWorkCommand(input), canonical = canonicalKnowledgePayload(command), a = actor(state);
  const prior = table(state, 'kb_work_receipts').find(r => r.id === command.commandId);
  if (prior) {
    if (prior.actor_id !== a.id || prior.canonical !== canonical) return fail('knowledge_command_reused', 409);
    const detail = await knowledgeDetail(state, str(prior.page_id));
    return { actorId: a.id, pageId: detail.pageId, generation: state.generation, eventId: str(prior.event_id), command, canonical, mutations: [], leasePageIds: [],
      result: { commandId: command.commandId, replayed: true, eventId: str(prior.event_id), page: detail } };
  }
  const s = structuredClone(state), mutations: KnowledgeMutation[] = [], leasePageIds: string[] = [];
  const mutate = (name: KnowledgeMutation['table'], operation: KnowledgeMutation['operation'], id: string, values: KnowledgeRow) => {
    mutations.push({ table: name, operation, id, values }); const rows = s.tables[name] ||= [];
    if (operation === 'insert') rows.push({ id, ...values }); else if (operation === 'delete') s.tables[name] = rows.filter(r => r.id !== id);
    else { const r = rows.find(r => r.id === id); if (!r) fail('knowledge_conflict', 409); Object.assign(r!, values); }
  };
  const preserve = (p: KnowledgeRow) => { if (!table(s, 'kb_revisions').some(r => r.page_id === p.id && r.version === p.version)) mutate('kb_revisions', 'insert', makeId(), {
    page_id: p.id, version: p.version, title: p.title, body: p.body, document_metadata: metadata(p), created_by: p.updated_by, created_at: p.updated_at }); };
  const sourceRevision = (ref: KnowledgeSourceRef): number | null => {
    if (ref.kind !== 'knowledge') return null;
    const target = page(s, ref.id), effective = table(s, 'kb_publications').find(r => r.page_id === ref.id && r.state === 'effective');
    if (effective) return Number(effective.page_version); preserve(target); return Number(target.version);
  };
  const revise = (p: KnowledgeRow, patch: KnowledgeRow) => { preserve(p); mutate('kb_pages', 'update', str(p.id), { ...patch, version: Number(p.version) + 1, updated_by: a.id, updated_at: now }); };
  let p: KnowledgeRow;
  if (command.operation === 'save_draft') {
    for (const ref of command.preview.sourceRefs) await verifiedSource(s, ref);
    const id = makeId(); mutate('kb_pages', 'insert', id, { title: command.title, body: knowledgeDraftHtml(command.text), project_id: null, parent_id: null,
      sort_order: 0, is_archived: false, admin_only: false, category: command.preview.kind === 'meeting' ? 'meeting' : 'general', access_policy: { mode: 'inherit' },
      created_by: a.id, updated_by: a.id, created_at: now, updated_at: now, version: 1, private_draft_owner_id: a.id, document_metadata: structuredClone(emptyMetadata) });
    p = byId(s, 'kb_pages', id)!;
    for (const ref of command.preview.sourceRefs) mutate('kb_source_links', 'insert', makeId(), { page_id: id, source_kind: ref.kind, source_id: ref.id, source_version: ref.version, source_page_version: sourceRevision(ref), created_by: a.id, created_at: now });
  } else {
    p = page(s, command.pageId, true); if (Number(p.version) !== command.expectedVersion) return fail('knowledge_conflict', 409);
    leasePageIds.push(str(p.id));
    const locked = table(s, 'field_locks').some(r => r.lock_key === `kb:${p.id}` && r.locked_by !== a.id && Date.parse(str(r.expires_at)) > Date.parse(now));
    if (locked) return fail('knowledge_conflict', 409);
    if (command.operation === 'set_metadata') {
      if (command.metadata.ownerId && !activeMember(s, command.metadata.ownerId)) return fail('knowledge_source_unavailable', 409);
      revise(p, { document_metadata: command.metadata });
    } else if (command.operation === 'publish' || command.operation === 'replace') {
      const m = metadata(p); if (p.private_draft_owner_id || !m.documentKind || !m.ownerId || !activeMember(s, m.ownerId)) return fail('knowledge_scope_conflict', 409);
      const current = table(s, 'kb_publications').find(r => r.page_id === p.id && r.state === 'effective');
      if ((current?.id || null) !== command.expectedPublicationId) return fail('knowledge_conflict', 409);
      let predecessor: KnowledgeRow | undefined;
      if (command.operation === 'replace') {
        predecessor = byId(s, 'kb_publications', command.predecessorPublicationId);
        if (!predecessor || predecessor.state !== 'effective' || predecessor.version !== command.expectedPredecessorVersion) return fail('knowledge_conflict', 409);
        const previousPage = page(s, str(predecessor.page_id), true);
        if (previousPage.id === p.id || previousPage.project_id !== p.project_id) return fail('knowledge_scope_conflict', 409);
        scopeSafe(s, str(previousPage.id), str(p.id)); scopeSafe(s, str(p.id), str(previousPage.id));
        const seen = new Set<string>(); let cursorId: string | null = str(predecessor.id);
        while (cursorId) { if (seen.has(cursorId)) return fail('knowledge_cycle', 409); seen.add(cursorId); const v = byId(s, 'kb_publications', cursorId); if (v?.page_id === p.id) return fail('knowledge_cycle', 409); cursorId = v?.predecessor_id ? str(v.predecessor_id) : null; }
        leasePageIds.push(str(previousPage.id));
      }
      const id = makeId(); preserve(p);
      if (current) mutate('kb_publications', 'update', str(current.id), { state: 'superseded', successor_id: id, version: Number(current.version) + 1 });
      if (predecessor) mutate('kb_publications', 'update', str(predecessor.id), { state: 'superseded', successor_id: id, version: Number(predecessor.version) + 1 });
      mutate('kb_publications', 'insert', id, { page_id: p.id, page_version: p.version, state: 'effective', version: 1,
        predecessor_id: predecessor?.id || current?.id || null, successor_id: null, published_by: a.id, published_at: now }); revise(p, {});
    } else if (command.operation === 'share_draft') {
      if (p.private_draft_owner_id !== a.id) return fail();
      if (command.projectId && !activeProject(s, command.projectId)) return fail('knowledge_unavailable', 404);
      if (command.parentId) { const target = page(s, command.parentId, true); if (target.private_draft_owner_id || (target.project_id || null) !== command.projectId) return fail('knowledge_scope_conflict', 409); }
      for (const link of table(s, 'kb_source_links').filter(r => r.page_id === p.id)) {
        const value = await source(s, link.source_kind as KnowledgeSourceKind, str(link.source_id)); scopeSafe(s, value.aclPageId, command.parentId);
      }
      revise(p, { private_draft_owner_id: null, project_id: command.projectId, parent_id: command.parentId });
    } else {
      const value = await verifiedSource(s, command.source);
      if (value.aclPageId === p.id) return fail('knowledge_cycle', 409);
      if (!p.private_draft_owner_id) scopeSafe(s, value.aclPageId, str(p.id));
      const link = table(s, 'kb_source_links').find(r => r.page_id === p.id && r.source_kind === command.source.kind && r.source_id === command.source.id);
      if (command.operation === 'link_source') {
        if (link) mutate('kb_source_links', 'update', str(link.id), { source_version: command.source.version, source_page_version: sourceRevision(command.source) });
        else mutate('kb_source_links', 'insert', makeId(), { page_id: p.id, source_kind: command.source.kind, source_id: command.source.id, source_version: command.source.version, source_page_version: sourceRevision(command.source), created_by: a.id, created_at: now });
      } else { if (!link) return fail('knowledge_conflict', 409); mutate('kb_source_links', 'delete', str(link.id), {}); }
      revise(p, {});
    }
  }
  const eventId = makeId(), pageId = str(p.id), result: KnowledgeWorkResult = { commandId: command.commandId, replayed: false, eventId, page: await knowledgeDetail(s, pageId) };
  return { actorId: a.id, pageId, generation: state.generation, eventId, command, canonical, mutations, leasePageIds: [...new Set(leasePageIds)], result };
}
