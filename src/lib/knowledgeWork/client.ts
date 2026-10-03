import { randomUUID } from '@/lib/generateId';
import { KnowledgeWorkError, KNOWLEDGE_WORK_ERRORS, canonicalKnowledgePayload, parseKnowledgeWorkCommand, parseKnowledgeWorkQuery, parseKnowledgeSource, parseKnowledgeMetadata, parseKnowledgeDraftPreview } from './core';
import type { KnowledgeWorkCommand, KnowledgeWorkDetail, KnowledgeWorkQuery, KnowledgeWorkResult, KnowledgeDraftInput, KnowledgeDraftPreview, KnowledgeSearchResult, KnowledgePublication } from './core';
export * from './core';
type DB = { functions: { invoke(name: string, options: { body: unknown }): PromiseLike<{ data: unknown; error: unknown }> } };
type Intent<T> = T extends unknown ? Omit<T, 'commandId'> : never;
export type KnowledgeWorkIntent = Intent<KnowledgeWorkCommand>;
type Operation<T extends KnowledgeWorkIntent['operation']> = Omit<Extract<KnowledgeWorkIntent, { operation: T }>, 'operation'>;
const wireFail = (): never => { throw new KnowledgeWorkError('knowledge_transport_error', 503); };
const wireObject = (v: unknown): Record<string, unknown> => v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : wireFail();
const wireString = (v: unknown, nullable = false): boolean => typeof v === 'string' || (nullable && v === null);
function checkItem(input: unknown): void {
  const p = wireObject(input); parseKnowledgeSource({ kind:p.kind, id:p.id, version:p.version });
  if (!wireString(p.title) || !wireString(p.projectId,true) || typeof p.effective !== 'boolean') wireFail();
  for (const k of ['pageId','taskId','taskKey','issueId','publicationId']) if (p[k] !== undefined && !wireString(p[k])) wireFail();
  if(p.publicationVersion!==undefined&&(!Number.isSafeInteger(p.publicationVersion)||Number(p.publicationVersion)<1))wireFail();
}
function checkPublication(input: unknown): void {
  const p=wireObject(input); parseKnowledgeMetadata(p.metadata);
  if (!['id','page_id','published_by','published_at','title','body'].every(k=>wireString(p[k])) || !['effective','superseded'].includes(String(p.state))
    || ![p.page_version,p.version].every(v=>Number.isSafeInteger(v)&&Number(v)>0) || !wireString(p.predecessor_id,true) || !wireString(p.successor_id,true)) wireFail();
}
export function validateKnowledgeDetail(input: unknown): KnowledgeWorkDetail {
  const p=wireObject(input); parseKnowledgeMetadata(p.metadata);
  if (!['pageId','title','body'].every(k=>wireString(p[k])) || !Number.isSafeInteger(p.pageVersion) || Number(p.pageVersion)<1
    || !['projectId','parentId','privateDraftOwnerId'].every(k=>wireString(p[k],true)) || typeof p.canEdit!=='boolean' || typeof p.canShare!=='boolean' || !Array.isArray(p.links)) wireFail();
  (p.links as unknown[]).forEach(parseKnowledgeSource); if(p.linkItems!==undefined){if(!Array.isArray(p.linkItems))wireFail();(p.linkItems as unknown[]).forEach(checkItem);}
  if(p.publication!==null)checkPublication(p.publication); return input as KnowledgeWorkDetail;
}
function validateQueryResult(query:KnowledgeWorkQuery,input:unknown):void {
  try {
    if(query.operation==='command_result'){const p=wireObject(input);if(typeof p.found!=='boolean')wireFail();if(p.found){const r=wireObject(p.result);if(r.commandId!==query.commandId||r.replayed!==true||!wireString(r.eventId))wireFail();validateKnowledgeDetail(r.page);}return;}
    if(query.operation==='detail'){const p=validateKnowledgeDetail(input);if(p.pageId!==query.pageId)wireFail();return;}
    if(query.operation==='publication'){checkPublication(input);if((input as KnowledgePublication).id!==query.publicationId)wireFail();return;}
    if(query.operation==='prepare_draft'){
      const p=wireObject(input),c=wireObject(p.coverage);
      if(typeof c.complete!=='boolean'||![c.sources,c.unavailable].every(n=>Number.isSafeInteger(n)&&Number(n)>=0)||!Array.isArray(c.limitations)||c.limitations.some(v=>typeof v!=='string'||v.length>200))wireFail();
      if(c.complete===true&&c.unavailable!==0)wireFail();
      if(!Array.isArray(p.sourceRefs)||c.sources!==p.sourceRefs.length)wireFail();
      parseKnowledgeDraftPreview({...p,coverage:{...c,complete:true,unavailable:0}});return;
    }
    const p=wireObject(input),c=wireObject(p.coverage);
    if(!Array.isArray(p.items)||p.items.length>20||!(p.nextCursor===null||(Number.isSafeInteger(p.nextCursor)&&Number(p.nextCursor)>query.cursor)))wireFail();
    (p.items as unknown[]).forEach(checkItem);
    if(typeof c.complete!=='boolean'||![c.sources,c.unavailable].every(n=>Number.isSafeInteger(n)&&Number(n)>=0)||!Array.isArray(c.limitations)||c.limitations.some(v=>typeof v!=='string'))wireFail();
  } catch {wireFail();}
}
export function knowledgeWorkErrorCode(value: unknown): string {
  const p = value && typeof value === 'object' ? value as { code?: unknown; message?: unknown } : {};
  const code = typeof value === 'string' ? value : p.code ?? p.message;
  return typeof code === 'string' && Object.prototype.hasOwnProperty.call(KNOWLEDGE_WORK_ERRORS, code) ? code : 'knowledge_unavailable';
}
async function invoke(db: DB, body: unknown): Promise<unknown> {
  const { data, error } = await db.functions.invoke('knowledge-work', { body });
  let code = data && typeof data === 'object' && 'error' in data ? knowledgeWorkErrorCode(data.error) : error ? knowledgeWorkErrorCode(error) : null;
  if (error && typeof error === 'object' && 'context' in error && error.context instanceof Response) {
    const detail = await error.context.clone().json().catch((): null => null);
    if (detail?.error) code = knowledgeWorkErrorCode(detail.error);
  }
  if (code) throw new KnowledgeWorkError(code, KNOWLEDGE_WORK_ERRORS[code]);
  if (error) throw new KnowledgeWorkError('knowledge_transport_error', 503);
  return data;
}
export async function queryKnowledgeWork<T>(db: DB, input: KnowledgeWorkQuery): Promise<T> {
  const query=parseKnowledgeWorkQuery(input),result = await invoke(db, { type: 'query', query });
  if (result === null || result === undefined) throw new KnowledgeWorkError('knowledge_unavailable', 503);
  validateQueryResult(query,result);
  return result as T;
}
export const getKnowledgeWork = (db: DB, pageId: string) => queryKnowledgeWork<KnowledgeWorkDetail>(db, { operation: 'detail', pageId });
export const getKnowledgePublication = (db: DB, publicationId: string) => queryKnowledgeWork<KnowledgePublication>(db, { operation: 'publication', publicationId });
export const prepareKnowledgeDraft = (db: DB, input: KnowledgeDraftInput) => queryKnowledgeWork<KnowledgeDraftPreview>(db, { operation: 'prepare_draft', input });
export const searchKnowledgeWork = (db: DB, input: Omit<Extract<KnowledgeWorkQuery, { operation: 'search' }>, 'operation'>) => queryKnowledgeWork<KnowledgeSearchResult>(db, { operation: 'search', ...input });
export const listKnowledgeDrafts = (db: DB, cursor = 0) => queryKnowledgeWork<KnowledgeSearchResult>(db, { operation: 'drafts', cursor });
export async function executeKnowledgeWorkCommand(db: DB, input: KnowledgeWorkCommand): Promise<KnowledgeWorkResult> {
  const command = parseKnowledgeWorkCommand(input);
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const data = await invoke(db, { type: 'command', command }) as KnowledgeWorkResult;
      if (!data || data.commandId !== command.commandId || typeof data.replayed !== 'boolean' || typeof data.eventId !== 'string'
        || !data.page || typeof data.page.pageId !== 'string' || !Number.isSafeInteger(data.page.pageVersion)
        || ('pageId' in command && data.page.pageId !== command.pageId)) throw new KnowledgeWorkError('knowledge_transport_error', 503);
      try{validateKnowledgeDetail(data.page);}catch{wireFail();}
      return data;
    } catch (error) {
      const code = knowledgeWorkErrorCode(error);
      if (!['knowledge_unavailable', 'knowledge_transport_error'].includes(code)) throw error;
      if (attempt === 1) throw new KnowledgeWorkError('knowledge_transport_error', 503);
    }
  }
  throw new KnowledgeWorkError('knowledge_transport_error', 503);
}
/** Create per account/view scope. Coalesce clicks and retain the ID after uncertain transport. */
export function createKnowledgeWorkClient(db: DB) {
  const pending = new Map<string, KnowledgeWorkCommand>(), flights = new Map<string, Promise<KnowledgeWorkResult>>();
  const command = (intent: KnowledgeWorkIntent): Promise<KnowledgeWorkResult> => {
    const key = canonicalKnowledgePayload({ ...intent, commandId: 'pending-knowledge-intent' });
    const flight = flights.get(key); if (flight) return flight;
    const value = pending.get(key) || parseKnowledgeWorkCommand({ ...intent, commandId: randomUUID() }); pending.set(key, value);
    const promise = executeKnowledgeWorkCommand(db, value).then(result => { pending.delete(key); return result; }, error => {
      if (knowledgeWorkErrorCode(error) !== 'knowledge_transport_error') pending.delete(key); throw error;
    }).finally(() => flights.delete(key)); flights.set(key, promise); return promise;
  };
  return {
    command, get: (pageId: string) => getKnowledgeWork(db, pageId), publication: (id: string) => getKnowledgePublication(db, id),
    search: (input: Omit<Extract<KnowledgeWorkQuery, { operation: 'search' }>, 'operation'>) => searchKnowledgeWork(db, input),
    drafts: (cursor = 0) => listKnowledgeDrafts(db, cursor), prepare: (input: KnowledgeDraftInput) => prepareKnowledgeDraft(db, input),
    metadata: (input: Operation<'set_metadata'>) => command({ ...input, operation: 'set_metadata' }),
    publish: (input: Operation<'publish'>) => command({ ...input, operation: 'publish' }),
    replace: (input: Operation<'replace'>) => command({ ...input, operation: 'replace' }),
    link: (input: Omit<Extract<KnowledgeWorkIntent, { operation: 'link_source' | 'unlink_source' }>, 'operation'>) => command({ ...input, operation: 'link_source' }),
    unlink: (input: Omit<Extract<KnowledgeWorkIntent, { operation: 'link_source' | 'unlink_source' }>, 'operation'>) => command({ ...input, operation: 'unlink_source' }),
    save: (input: Operation<'save_draft'>) => command({ ...input, operation: 'save_draft' }),
    share: (input: Operation<'share_draft'>) => command({ ...input, operation: 'share_draft' }),
  };
}
export type KnowledgeWorkClient = ReturnType<typeof createKnowledgeWorkClient>;
