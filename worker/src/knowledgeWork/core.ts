/** Knowledge commands never accept an actor, workspace, ACL, or publication body. */
export type KnowledgeDocumentKind = 'specification' | 'decision' | null;
export type KnowledgeSourceKind = 'knowledge' | 'task' | 'qa' | 'knowledge_file' | 'task_file' | 'qa_file';
export type KnowledgeSourceRef = { kind: KnowledgeSourceKind; id: string; version: string };
export type KnowledgeApplicability = { productVersion: string | null; environment: string | null; summary: string | null };
export type KnowledgeMetadata = { documentKind: KnowledgeDocumentKind; ownerId: string | null; applicability: KnowledgeApplicability };
export type KnowledgePublication = { id: string; page_id: string; page_version: number; state: 'effective' | 'superseded'; version: number; predecessor_id: string | null; successor_id: string | null; published_by: string; published_at: string; title: string; body: string; metadata: KnowledgeMetadata };
export type KnowledgeWorkDetail = {
  pageId: string; pageVersion: number; title: string; body: string; projectId: string | null; parentId: string | null;
  privateDraftOwnerId: string | null; metadata: KnowledgeMetadata; publication: KnowledgePublication | null;
  links: KnowledgeSourceRef[]; linkItems?: KnowledgeSearchItem[]; canEdit: boolean; canShare: boolean;
};
export type KnowledgeSearchItem = { kind: KnowledgeSourceKind; id: string; title: string; version: string; projectId: string | null; effective: boolean; pageId?: string; taskId?: string; taskKey?: string; issueId?: string; publicationId?: string; publicationVersion?: number };
export type KnowledgeCoverage = { complete: boolean; sources: number; unavailable: number; limitations: string[] };
export type KnowledgeSearchResult = { items: KnowledgeSearchItem[]; nextCursor: number | null; coverage: KnowledgeCoverage };
export type KnowledgeDraftInput = { kind: 'meeting' | 'weekly'; title?: string; notes: string; sourceRefs: KnowledgeSourceRef[]; period?: { from: string; to: string } };
export type KnowledgeDraftPreview = { kind: 'meeting' | 'weekly'; title: string; text: string; sourceRefs: KnowledgeSourceRef[]; period: { from: string; to: string } | null; coverage: KnowledgeCoverage; previewFingerprint: string };
type Base = { commandId: string };
type PageBase = { pageId: string; expectedVersion: number };
export type KnowledgeWorkCommand = Base & (
  | (PageBase & { operation: 'set_metadata'; metadata: KnowledgeMetadata })
  | (PageBase & { operation: 'publish'; expectedPublicationId: string | null; confirmed: true })
  | (PageBase & { operation: 'replace'; expectedPublicationId: string | null; predecessorPublicationId: string; expectedPredecessorVersion: number; confirmed: true })
  | (PageBase & { operation: 'link_source' | 'unlink_source'; source: KnowledgeSourceRef })
  | { operation: 'save_draft'; preview: KnowledgeDraftPreview; title: string; text: string; confirmed: true }
  | (PageBase & { operation: 'share_draft'; projectId: string | null; parentId: string | null; confirmed: true })
);
export type KnowledgeWorkResult = { commandId: string; replayed: boolean; eventId: string; page: KnowledgeWorkDetail };
export type KnowledgeWorkQuery =
  | { operation: 'command_result'; commandId: string }
  | { operation: 'detail'; pageId: string }
  | { operation: 'publication'; publicationId: string }
  | { operation: 'drafts'; cursor: number }
  | { operation: 'search'; query: string; types: KnowledgeSourceKind[]; projectIds: string[]; effectiveOnly: boolean; cursor: number }
  | { operation: 'prepare_draft'; input: KnowledgeDraftInput };
export class KnowledgeWorkError extends Error { constructor(public code: string, public status = 400) { super(code); this.name = 'KnowledgeWorkError'; } }
export const KNOWLEDGE_WORK_ERRORS: Record<string, number> = {
  knowledge_invalid_input: 400, knowledge_unauthorized: 401, knowledge_forbidden: 403, knowledge_unavailable: 404,
  knowledge_conflict: 409, knowledge_source_unavailable: 409, knowledge_scope_conflict: 409, knowledge_cycle: 409,
  knowledge_command_reused: 409, knowledge_incomplete_source: 409, knowledge_transport_error: 503,
};
const own = (x: object, k: string) => Object.prototype.hasOwnProperty.call(x, k);
const fail = (): never => { throw new KnowledgeWorkError('knowledge_invalid_input'); };
const obj = (v: unknown): Record<string, unknown> => v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : fail();
const only = (v: Record<string, unknown>, keys: string[]) => { if (Object.keys(v).some(k => !keys.includes(k))) fail(); };
const id = (v: unknown): string => typeof v === 'string' && /^[\w-]{1,200}$/.test(v) ? v : fail();
const nullableId = (v: unknown): string | null => v === null ? null : id(v);
const version = (v: unknown): number => Number.isSafeInteger(v) && Number(v) >= 1 ? Number(v) : fail();
const cursor = (v: unknown): number => Number.isSafeInteger(v) && Number(v) >= 0 && Number(v) <= 1000000 ? Number(v) : fail();
const text = (v: unknown, max: number, empty = false): string => typeof v === 'string' && !v.includes('\0') && [...v].length <= max && (empty || v.trim()) ? v.trim() : fail();
const nullableText = (v: unknown, max: number): string | null => v === null ? null : text(v, max);
const calendar = (v: unknown): string => {
  if (typeof v !== 'string' || !/^(?!0000)\d{4}-\d{2}-\d{2}$/.test(v)) return fail();
  const d = new Date(v + 'T00:00:00Z'); return Number.isFinite(d.getTime()) && d.toISOString().slice(0, 10) === v ? v : fail();
};
export const KNOWLEDGE_SOURCE_KINDS: KnowledgeSourceKind[] = ['knowledge', 'task', 'qa', 'knowledge_file', 'task_file', 'qa_file'];
export function parseKnowledgeSource(input: unknown): KnowledgeSourceRef {
  const p = obj(input); only(p, ['kind', 'id', 'version']);
  if (!KNOWLEDGE_SOURCE_KINDS.includes(p.kind as KnowledgeSourceKind)) fail();
  return { kind: p.kind as KnowledgeSourceKind, id: id(p.id), version: text(p.version, 200) };
}
const sources = (v: unknown): KnowledgeSourceRef[] => {
  if (!Array.isArray(v) || v.length > 50) return fail();
  const result = v.map(parseKnowledgeSource).sort((a, b) => `${a.kind}:${a.id}`.localeCompare(`${b.kind}:${b.id}`));
  if (new Set(result.map(r => `${r.kind}:${r.id}`)).size !== result.length) fail();
  return result;
};
export function parseKnowledgeMetadata(input: unknown): KnowledgeMetadata {
  const p = obj(input), a = obj(p.applicability); only(p, ['documentKind', 'ownerId', 'applicability']); only(a, ['productVersion', 'environment', 'summary']);
  if (p.documentKind !== null && p.documentKind !== 'specification' && p.documentKind !== 'decision') fail();
  return { documentKind: p.documentKind as KnowledgeDocumentKind, ownerId: nullableId(p.ownerId), applicability: {
    productVersion: nullableText(a.productVersion, 200), environment: nullableText(a.environment, 200), summary: nullableText(a.summary, 1000) } };
}
export function parseKnowledgeDraftInput(input: unknown): KnowledgeDraftInput {
  const p = obj(input); only(p, ['kind', 'title', 'notes', 'sourceRefs', 'period']);
  if (p.kind !== 'meeting' && p.kind !== 'weekly') fail();
  let period: KnowledgeDraftInput['period'];
  if (p.period !== undefined) { const a = obj(p.period); only(a, ['from', 'to']); period = { from: calendar(a.from), to: calendar(a.to) }; if (period.from > period.to) fail(); }
  return { kind: p.kind as 'meeting' | 'weekly', ...(p.title === undefined ? {} : { title: text(p.title, 200) }), notes: text(p.notes, 30000, true), sourceRefs: sources(p.sourceRefs), ...(period ? { period } : {}) };
}
/** This is a deterministic freshness token, not an authorization token. Every source is re-read on save. */
export function knowledgePreviewFingerprint(refs: KnowledgeSourceRef[]): string { return JSON.stringify(sources(refs)); }
export function parseKnowledgeDraftPreview(input: unknown): KnowledgeDraftPreview {
  const p = obj(input); only(p, ['kind', 'title', 'text', 'sourceRefs', 'period', 'coverage', 'previewFingerprint']);
  const draft = parseKnowledgeDraftInput({ kind: p.kind, title: p.title, notes: '', sourceRefs: p.sourceRefs, ...(p.period === null ? {} : { period: p.period }) });
  const c = obj(p.coverage); only(c, ['complete', 'sources', 'unavailable', 'limitations']);
  if (c.complete !== true || c.unavailable !== 0 || c.sources !== draft.sourceRefs.length || !Array.isArray(c.limitations) || c.limitations.some(x => typeof x !== 'string' || x.length > 200)) fail();
  const fingerprint = knowledgePreviewFingerprint(draft.sourceRefs); if (p.previewFingerprint !== fingerprint) fail();
  return { kind: draft.kind, title: draft.title!, text: text(p.text, 100000, true), sourceRefs: draft.sourceRefs, period: draft.period || null,
    coverage: { complete: true, sources: draft.sourceRefs.length, unavailable: 0, limitations: c.limitations as string[] }, previewFingerprint: fingerprint };
}
export function parseKnowledgeWorkCommand(input: unknown): KnowledgeWorkCommand {
  const p = obj(input), base = { commandId: id(p.commandId) }; if (base.commandId.length < 8) fail();
  let r: KnowledgeWorkCommand;
  if (p.operation === 'save_draft') r = { ...base, operation: p.operation, preview: parseKnowledgeDraftPreview(p.preview), title: text(p.title, 200), text: text(p.text, 100000), confirmed: p.confirmed === true ? true : fail() };
  else {
    const page = { pageId: id(p.pageId), expectedVersion: version(p.expectedVersion) };
    switch (p.operation) {
      case 'set_metadata': r = { ...base, ...page, operation: p.operation, metadata: parseKnowledgeMetadata(p.metadata) }; break;
      case 'publish': case 'replace': {
        const pub = { ...base, ...page, expectedPublicationId: nullableId(p.expectedPublicationId), confirmed: p.confirmed === true ? true as const : fail() };
        r = p.operation === 'publish' ? { ...pub, operation: p.operation } : { ...pub, operation: p.operation, predecessorPublicationId: id(p.predecessorPublicationId), expectedPredecessorVersion: version(p.expectedPredecessorVersion) }; break;
      }
      case 'link_source': case 'unlink_source': r = { ...base, ...page, operation: p.operation, source: parseKnowledgeSource(p.source) }; break;
      case 'share_draft': r = { ...base, ...page, operation: p.operation, projectId: nullableId(p.projectId), parentId: nullableId(p.parentId), confirmed: p.confirmed === true ? true : fail() }; break;
      default: return fail();
    }
  }
  only(p, Object.keys(r)); return r;
}
export function canonicalKnowledgePayload(command: KnowledgeWorkCommand): string {
  const stable = (v: unknown): unknown => Array.isArray(v) ? v.map(stable) : v && typeof v === 'object'
    ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b)).map(([k, x]) => [k, stable(x)])) : v;
  return JSON.stringify(stable(parseKnowledgeWorkCommand(command)));
}
export function parseKnowledgeWorkQuery(input: unknown): KnowledgeWorkQuery {
  const p = obj(input); let q: KnowledgeWorkQuery;
  switch (p.operation) {
    case 'command_result': q={operation:p.operation,commandId:id(p.commandId)};break;
    case 'detail': q = { operation: p.operation, pageId: id(p.pageId) }; break;
    case 'publication': q = { operation: p.operation, publicationId: id(p.publicationId) }; break;
    case 'drafts': q = { operation: p.operation, cursor: cursor(p.cursor) }; break;
    case 'prepare_draft': q = { operation: p.operation, input: parseKnowledgeDraftInput(p.input) }; break;
    case 'search': {
      if (!Array.isArray(p.types) || !p.types.length || p.types.some(t => !KNOWLEDGE_SOURCE_KINDS.includes(t as KnowledgeSourceKind)) || !Array.isArray(p.projectIds) || p.projectIds.length > 50 || typeof p.effectiveOnly !== 'boolean') fail();
      q = { operation: p.operation, query: text(p.query, 200, true), types: [...new Set(p.types as KnowledgeSourceKind[])].sort(), projectIds: [...new Set((p.projectIds as unknown[]).map(id))].sort(), effectiveOnly: p.effectiveOnly as boolean, cursor: cursor(p.cursor) }; break;
    }
    default: return fail();
  }
  only(p, Object.keys(q)); return q;
}
export function knowledgeWorkError(input: unknown): KnowledgeWorkError {
  if (input instanceof KnowledgeWorkError) return input;
  const message = input instanceof Error ? input.message : typeof input === 'string' ? input : '';
  const code = message.match(/\bknowledge_[a-z_]+\b/)?.[0];
  return code && own(KNOWLEDGE_WORK_ERRORS, code) ? new KnowledgeWorkError(code, KNOWLEDGE_WORK_ERRORS[code]) : new KnowledgeWorkError('knowledge_unavailable', 503);
}
export function knowledgeDraftHtml(text: string): string {
  return '<p>' + text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/\n/g, '<br>') + '</p>';
}
