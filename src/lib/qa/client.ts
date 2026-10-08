import { supabase, USING_MOCK_BACKEND } from '@/integrations/supabase/client';
import { createClient } from '@supabase/supabase-js';
import { fnUrl } from '@/lib/apiBase';
import { SUPABASE_URL } from '@/lib/gatewayUrl';
import { parseQaWorkflow, validateQaWorkflow, type QaWorkflow } from './workflow';
import { parseQaManualStateVisibility, validateQaManualStateVisibility, type QaManualStateVisibility } from './manualStateVisibility';
import { defaultQaDisplaySettings, validateQaDisplaySettings, type QaDisplaySettings } from './displaySettings';
import { canManageQaConfiguration, parseQaFieldConfiguration, validateQaFieldConfiguration, type QaFieldConfiguration } from './fields';
import { qaVersionSuggestions } from './versions';
import { randomUUID } from '@/lib/generateId';
import { applyQaCommand, canQaDelete, compareQaIssues, createQaIssue, matchesQaListFilters, normalizeQaListFilters, qaEventDetail, qaIdSearch, QA_MAX_FILE_BYTES, QA_PART_BYTES, QA_STATES, QaError } from './domain';
import type { QaAttachment, QaCommand, QaComment, QaContext, QaCreateInput, QaDetail, QaIssue, QaListInput, QaListResult, QaUpload, QaCoordination } from './domain';

export class QaClientError extends Error {
  constructor(public readonly code: string, public readonly status: number, message = code) { super(message); this.name = 'QaClientError'; }
}
const qaInvalidFilter = (): never => { throw new QaError('qa_invalid_filter'); };

// Demo data never leaves this tab or enters the real task tables.
const demoIssues = new Map<string, QaDetail>();
const demoFiles = new Map<string, Blob>();
const demoCommands = new Map<string, unknown>();
const demoCommandPayloads = new Map<string,string>();
const demoCoordination = new Map<string, QaCoordination>();
const demoCoordinationReceipts = new Map<string, {hash:string; result:QaCoordination}>();
const demoWorkflows = new Map<string, QaWorkflow>();
const demoDisplaySettings = new Map<string, QaDisplaySettings>();
const demoManualStateVisibility = new Map<string, QaManualStateVisibility>();
const demoFieldConfigurations = new Map<string, QaFieldConfiguration>();
const clone = <T,>(value: T): T => structuredClone(value);
export const qaId = randomUUID;
export function qaThrowIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw signal.reason ?? new DOMException('Aborted', 'AbortError');
}

/** A draft keeps this in memory across retries; never persist signed capabilities. */
export interface QaUploadResume {
  issueId?: string; file?: File; upload?: QaUpload; attachment?: QaAttachment;
  parts?: Array<{ partNumber: number; etag: string }>;
}
const commonFileTypes: Record<string, string[]> = {
  'image/png': ['png'], 'image/jpeg': ['jpg', 'jpeg'], 'image/webp': ['webp'], 'image/gif': ['gif'],
  'video/mp4': ['mp4'], 'application/pdf': ['pdf'], 'text/plain': ['txt', 'log'],
};
export function qaUploadFileTypes(): Record<string, string[]> {
  return import.meta.env.VITE_API_URL
    ? { ...commonFileTypes, 'text/csv': ['csv'], 'application/json': ['json'] }
    : { ...commonFileTypes, 'video/webm': ['webm'] };
}
export function qaValidateUploadFile(file: File): 'file_size' | 'file_type' | 'file_name' | undefined {
  if (!file.size || file.size > QA_MAX_FILE_BYTES) return 'file_size';
  const cloud = !!import.meta.env.VITE_API_URL;
  if (!file.name.trim() || file.name.length > (cloud ? 180 : 255) || /[\x00-\x1f\\/]/.test(file.name)) return 'file_name';
  const extensions = qaUploadFileTypes()[file.type.toLowerCase()];
  if (!extensions || (cloud && !extensions.includes(file.name.split('.').pop()!.toLowerCase()))) return 'file_type';
}

export interface QaClientOptions { enabled: () => boolean; context: () => QaContext; mock?: boolean; }
export function createQaClient(options: QaClientOptions) {
  const mock = options.mock ?? USING_MOCK_BACKEND;
  const ensureEnabled = () => { if (!options.enabled()) throw new QaClientError('qa_disabled', 403);
    if(mock){const ctx=options.context();if(!ctx.memberIds.has(ctx.actor.id))throw new QaClientError('qa_forbidden',403);} };
  const getDemo = (id: string) => {
    const detail = demoIssues.get(id);
    if (!detail || detail.issue.workspaceId !== options.context().workspaceId) throw new QaClientError('not_found', 404);
    return detail;
  };
  const headers = async () => {
    ensureEnabled();
    const { data: { session } } = await supabase.auth.getSession();
    if (!session?.access_token) throw new QaClientError('unauthorized', 401);
    ensureEnabled();
    return { Authorization: `Bearer ${session.access_token}`, ...(import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY ? { apikey: String(import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY) } : {}) };
  };
  const checkResponse = async (response: Response) => {
    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      throw new QaClientError(body.error?.code || `http_${response.status}`, response.status, body.error?.message);
    }
    return response;
  };
  const request = async <T,>(action: string, body: Record<string, unknown>, signal?: AbortSignal): Promise<T> => {
    const authHeaders = await headers();
    const response = await checkResponse(await fetch(fnUrl('qa'), { method: 'POST', signal, headers: { ...authHeaders, 'Content-Type': 'application/json' }, body: JSON.stringify({ action, ...body }) }));
    return response.json();
  };
  const demoOnce = <T,>(commandId: string, work: () => T, payload?:unknown): T => {
    const key = `${options.context().workspaceId}:${options.context().actor.id}:${commandId}`;
    const hash=payload===undefined?undefined:JSON.stringify(payload);
    if (demoCommands.has(key)) {if(hash!==undefined&&demoCommandPayloads.get(key)!==hash)throw new QaClientError('qa_command_id_reused',409);return clone(demoCommands.get(key) as T);}
    const value = work(); if(hash!==undefined)demoCommandPayloads.set(key,hash); demoCommands.set(key, clone(value)); return clone(value);
  };
  const demoConfig = (projectId:string):QaCoordination => {
    const ctx = options.context();
    if (!ctx.memberIds.has(ctx.actor.id) || !ctx.projectIds.has(projectId)) throw new QaClientError('qa_forbidden',403);
    return clone(demoCoordination.get(`${ctx.workspaceId}:${projectId}`) ?? {projectId,coordinatorId:null,version:0});
  };
  const api = {
    async getCoordination(projectId:string, signal?:AbortSignal):Promise<QaCoordination> {
      ensureEnabled(); return mock ? demoConfig(projectId) : request('get_coordination',{projectId},signal);
    },
    /** Projects whose QA the signed-in member coordinates. */
    async myCoordination(signal?:AbortSignal):Promise<{projectIds:string[]}> {
      ensureEnabled();
      if (!mock) return request('my_coordination',{},signal);
      const ctx = options.context();
      return {projectIds:[...demoCoordination.entries()].filter(([key,row])=>key===`${ctx.workspaceId}:${row.projectId}`&&row.coordinatorId===ctx.actor.id&&ctx.projectIds.has(row.projectId)).map(([,row])=>row.projectId).sort()};
    },
    async saveCoordination(projectId:string, coordinatorId:string|null, expectedVersion:number, commandId=qaId()):Promise<QaCoordination> {
      ensureEnabled();
      if (!mock) return request('save_coordination',{projectId,coordinatorId,expectedVersion,commandId});
      const ctx=options.context(), current=demoConfig(projectId);
      if (!['admin','super_admin'].includes(ctx.actor.role)) throw new QaClientError('qa_forbidden',403);
      if (coordinatorId!==null&&!ctx.memberIds.has(coordinatorId)) throw new QaClientError('qa_member_unavailable',400);
      const key=`${ctx.workspaceId}:${ctx.actor.id}:${commandId}`,hash=JSON.stringify({projectId,coordinatorId,expectedVersion});
      const prior=demoCoordinationReceipts.get(key);
      if(prior){if(prior.hash!==hash)throw new QaClientError('qa_command_id_reused',409);return clone(prior.result);}
      if(!Number.isSafeInteger(expectedVersion)||expectedVersion!==current.version)throw new QaClientError('qa_version_conflict',409);
      const next={projectId,coordinatorId,version:current.version+1};
      demoCoordination.set(`${ctx.workspaceId}:${projectId}`,next);demoCoordinationReceipts.set(key,{hash,result:clone(next)});return clone(next);
    },
    async versions(projectId: string, signal?: AbortSignal): Promise<string[]> {
      ensureEnabled();
      if (!projectId) return [];
      if (!mock) return request('versions', { projectId }, signal);
      const ctx = options.context();
      if (!ctx.projectIds.has(projectId)) throw new QaClientError('qa_project_unavailable', 403);
      return qaVersionSuggestions([...demoIssues.values()].map(value => value.issue), ctx.workspaceId, projectId);
    },
    async getDisplaySettings(signal?: AbortSignal): Promise<QaDisplaySettings> {
      ensureEnabled();
      return mock ? clone(demoDisplaySettings.get(options.context().workspaceId) || defaultQaDisplaySettings())
        : validateQaDisplaySettings(await request('get_display_settings', {}, signal));
    },
    async saveDisplaySettings(input: QaDisplaySettings): Promise<QaDisplaySettings> {
      ensureEnabled(); const ctx = options.context();
      if (ctx.actor.role !== 'super_admin') throw new QaClientError('qa_forbidden', 403);
      const configuration = validateQaDisplaySettings(input);
      if (!mock) return validateQaDisplaySettings(await request('save_display_settings', { configuration }));
      demoDisplaySettings.set(ctx.workspaceId, clone(configuration)); return clone(configuration);
    },
    async getManualStateVisibility(signal?: AbortSignal): Promise<QaManualStateVisibility> {
      ensureEnabled();
      return mock ? parseQaManualStateVisibility(demoManualStateVisibility.get(options.context().workspaceId))
        : request('get_manual_state_visibility', {}, signal);
    },
    async saveManualStateVisibility(input: QaManualStateVisibility): Promise<QaManualStateVisibility> {
      ensureEnabled(); const ctx = options.context();
      if (!canManageQaConfiguration(ctx.actor)) throw new QaClientError('qa_forbidden', 403);
      const configuration = validateQaManualStateVisibility(input);
      if (!mock) return request('save_manual_state_visibility', { configuration });
      demoManualStateVisibility.set(ctx.workspaceId, clone(configuration)); return clone(configuration);
    },
    async getWorkflow(signal?: AbortSignal): Promise<QaWorkflow> {
      ensureEnabled();
      return mock ? parseQaWorkflow(demoWorkflows.get(options.context().workspaceId)) : request('get_workflow', {}, signal);
    },
    async saveWorkflow(input: QaWorkflow): Promise<QaWorkflow> {
      ensureEnabled(); const workflow = validateQaWorkflow(input), ctx = options.context();
      if (!canManageQaConfiguration(ctx.actor)) throw new QaClientError('qa_forbidden',403);
      if (!mock) return request('save_workflow', { workflow });
      demoWorkflows.set(ctx.workspaceId, clone(workflow)); return clone(workflow);
    },
    async getFieldConfiguration(signal?: AbortSignal): Promise<QaFieldConfiguration> {
      ensureEnabled();
      return mock ? parseQaFieldConfiguration(demoFieldConfigurations.get(options.context().workspaceId)) : request('get_field_configuration', {}, signal);
    },
    async saveFieldConfiguration(input: QaFieldConfiguration): Promise<QaFieldConfiguration> {
      ensureEnabled(); const ctx = options.context();
      if (!canManageQaConfiguration(ctx.actor)) throw new QaClientError('qa_forbidden',403);
      if (!mock) return request('save_field_configuration', { configuration: validateQaFieldConfiguration(input) });
      const configuration = validateQaFieldConfiguration(input, parseQaFieldConfiguration(demoFieldConfigurations.get(ctx.workspaceId)));
      demoFieldConfigurations.set(ctx.workspaceId, clone(configuration)); return clone(configuration);
    },
    async list(input: QaListInput, signal?: AbortSignal): Promise<QaListResult> {
      ensureEnabled();
      qaThrowIfAborted(signal);
      if (!mock) return request('list', { input }, signal);
      if (input.state && !QA_STATES.includes(input.state)) throw new QaClientError('qa_invalid_state', 400);
      if (input.states !== undefined && (input.state || !Array.isArray(input.states) || !input.states.length || input.states.length > QA_STATES.length ||
        new Set(input.states).size !== input.states.length || input.states.some(state => !QA_STATES.includes(state)))) throw new QaClientError('qa_invalid_state', 400);
      const offset = input.offset ?? 0, limit = input.limit ?? 50;
      if (!Number.isInteger(offset) || offset < 0 || offset > 100000 || !Number.isInteger(limit) || limit < 1 || limit > 100) throw new QaClientError('qa_invalid_page', 400);
      let filters: ReturnType<typeof normalizeQaListFilters>;
      try { filters = normalizeQaListFilters(input, value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(value) ? value : qaInvalidFilter()); }
      catch (error) { throw new QaClientError(error instanceof QaError ? error.code : 'qa_invalid_filter', 400); }
      const context = options.context();
      const issues = [...demoIssues.values()].map(d => d.issue).filter(issue => issue.workspaceId === context.workspaceId && matchesQaListFilters(issue, filters) &&
        (!input.projectId || issue.projectId === input.projectId) && (!input.state || issue.state === input.state) &&
        (!input.states || input.states.includes(issue.state)) &&
        (!input.search || (qaIdSearch(input.search) ? issue.id.toLowerCase().includes(qaIdSearch(input.search)!.toLowerCase()) : issue.title.toLowerCase().includes(input.search.toLowerCase()))) &&
        (!input.mine || (input.mine === 'involved' ? [issue.assigneeId, issue.qaOwnerId, issue.reporterId].includes(context.actor.id)
          : input.mine === 'handoff' ? !!issue.handoff && !issue.handoff.resolvedAt && issue.handoff.nextOwnerId === context.actor.id
          : (input.mine === 'assigned' ? issue.assigneeId : input.mine === 'testing' ? issue.qaOwnerId : issue.reporterId) === context.actor.id)))
        .sort((a, b) => compareQaIssues(a, b, filters.sort, filters.direction));
      return clone({ issues: issues.slice(offset, offset + limit), total: issues.length, hasMore: offset + limit < issues.length });
    },
    async get(id: string, signal?: AbortSignal): Promise<QaDetail> {
      ensureEnabled(); if (!mock) return request('get', { id }, signal);
      const detail=clone(getDemo(id)); detail.coordination=clone(demoCoordination.get(`${options.context().workspaceId}:${detail.issue.projectId}`)??{projectId:detail.issue.projectId,coordinatorId:null,version:0}); return detail;
    },
    async create(input: QaCreateInput, id = qaId(), commandId = qaId(), signal?: AbortSignal): Promise<QaIssue> {
      ensureEnabled();
      qaThrowIfAborted(signal);
      if (!mock) return request('create', { id, commandId, input }, signal);
      return demoOnce(commandId, () => {
        if (demoIssues.has(id)) throw new QaClientError('conflict', 409);
        const base = options.context(), ctx = { ...base, fieldConfiguration: parseQaFieldConfiguration(demoFieldConfigurations.get(base.workspaceId)) }, issue = createQaIssue(input, id, ctx);
        demoIssues.set(id, { issue, comments: [], attachments: [], events: [{ id: qaId(), issueId: id, actorId: ctx.actor.id, type: 'created', detail: '', createdAt: ctx.now, version: issue.version }] });
        return issue;
      });
    },
    async command(issue: QaIssue, command: QaCommand, commandId = qaId()): Promise<QaIssue> {
      ensureEnabled();
      if (!mock) return request('command', { id: issue.id, expectedVersion: issue.version, commandId, command });
      return demoOnce(commandId, () => {
        const detail = getDemo(issue.id);
        if (detail.issue.version !== issue.version) throw new QaClientError('conflict', 409);
        const ctx = { ...options.context(), fieldConfiguration: parseQaFieldConfiguration(demoFieldConfigurations.get(options.context().workspaceId)), duplicateIssueIds: new Set([...demoIssues.values()].filter(d => d.issue.workspaceId === issue.workspaceId).map(d => d.issue.id)) };
        const coordinator=demoConfig(issue.projectId);
        ctx.actor={...ctx.actor,qaCoordinatorProjectIds:coordinator.coordinatorId===ctx.actor.id?[issue.projectId]:[]};
        const before = detail.issue;
        detail.issue = applyQaCommand(before, command, ctx);
        detail.events.push({ id: qaId(), issueId: issue.id, actorId: ctx.actor.id, type: command.type, detail: qaEventDetail(detail.issue, command.type, before), createdAt: ctx.now, version: detail.issue.version });
        return detail.issue;
      },{id:issue.id,version:issue.version,command});
    },
    /** Permanent. The servers re-check the version and canQaDelete before removing anything. */
    async delete(issue: QaIssue): Promise<void> {
      ensureEnabled();
      if (!mock) { await request('delete', { id: issue.id, expectedVersion: issue.version }); return; }
      const detail = getDemo(issue.id);
      if (detail.issue.version !== issue.version) throw new QaClientError('conflict', 409);
      if (!canQaDelete(detail.issue, options.context().actor)) throw new QaClientError('qa_forbidden', 403);
      demoIssues.delete(issue.id);
    },
    async comment(id: string, body: string, commandId = qaId()): Promise<QaComment> {
      ensureEnabled();
      if (!mock) return request('comment', { id, commandId, body });
      return demoOnce(commandId, () => {
        const ctx = options.context();
        if (!body.trim() || body.length > 10000) throw new QaError('invalid_comment');
        const comment = { id: qaId(), issueId: id, body: body.trim(), actorId: ctx.actor.id, createdAt: ctx.now };
        getDemo(id).comments.push(comment); return comment;
      });
    },
    async upload(id: string, file: File, onProgress?: (percent: number) => void, signal?: AbortSignal, resume: QaUploadResume = {}): Promise<QaAttachment> {
      ensureEnabled();
      qaThrowIfAborted(signal);
      const fileError = qaValidateUploadFile(file);
      if (fileError) throw new QaClientError(fileError, 400);
      if ((resume.file && resume.file !== file) || (resume.issueId && resume.issueId !== id)) throw new QaClientError('invalid_upload', 400);
      resume.file = file; resume.issueId = id;
      if (resume.attachment) { onProgress?.(100); return resume.attachment; }
      onProgress?.(0);
      if (mock) {
        const ctx = options.context(), attachment = { id: qaId(), issueId: id, fileName: file.name, mimeType: file.type || 'application/octet-stream', size: file.size, uploadedBy: ctx.actor.id, createdAt: ctx.now };
        getDemo(id).attachments.push(attachment); demoFiles.set(attachment.id, file); resume.attachment = clone(attachment); onProgress?.(100); return clone(attachment);
      }
      const complete = async () => {
        const result = await request<QaAttachment>('upload_complete', { uploadId: resume.upload!.id,
          ...(resume.parts?.length ? { parts: resume.parts } : {}) }, signal);
        resume.attachment = result; onProgress?.(100); return result;
      };
      if (resume.upload) {
        // A lost upload/finalize response must not allocate another attachment.
        try { return await complete(); }
        catch (error) {
          qaThrowIfAborted(signal); ensureEnabled();
          const code = (error as QaClientError)?.code;
          if (['qa_upload_expired', 'qa_upload_not_found', 'upload_expired', 'upload_not_found'].includes(code)) {
            // Exact reservation ID only: matching a filename could merge distinct files.
            const detail = await api.get(id, signal);
            const prior = detail.attachments.find(item => item.id === resume.upload!.id);
            if (prior) { resume.attachment = prior; onProgress?.(100); return prior; }
            resume.upload = undefined; resume.parts = [];
          } else if (code !== 'qa_upload_incomplete' && code !== 'upload_incomplete') throw error;
        }
      }
      if (!resume.upload) resume.upload = await request<QaUpload>('upload_init', { id, fileName: file.name, mimeType: file.type, size: file.size }, signal);
      const upload = resume.upload;
      const parts = resume.parts ??= [];
      if (upload.provider === 'supabase') {
        if (!upload.bucket || !upload.path || !upload.token) throw new QaClientError('invalid_upload', 500);
        ensureEnabled();
        const key = String(import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY || '');
        if (!SUPABASE_URL || !key) throw new QaClientError('storage_not_configured', 500);
        // The SDK upload API has no per-call abort option. A non-persistent client
        // preserves its signed-upload protocol while allowing this request to abort.
        const storageClient = createClient(SUPABASE_URL, key, {
          auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
          global: { headers: await headers(), fetch: (url, init) => fetch(url, { ...init, signal }) },
        });
        const { error } = await storageClient.storage.from(upload.bucket).uploadToSignedUrl(upload.path, upload.token, file, { contentType: file.type || 'application/octet-stream' });
        qaThrowIfAborted(signal);
        if (error) throw new QaClientError('upload_failed', 400, error.message);
        onProgress?.(95);
      } else {
        const partSize = upload.partSize || QA_PART_BYTES;
        for (let start = 0, partNumber = 1; start < file.size; start += partSize, partNumber++) {
          ensureEnabled(); qaThrowIfAborted(signal);
          if (parts.some(part => part.partNumber === partNumber)) continue;
          const url = `${fnUrl('qa')}?action=upload_part&uploadId=${encodeURIComponent(upload.id)}&partNumber=${partNumber}`;
          const response = await checkResponse(await fetch(url, { method: 'POST', signal, headers: { ...await headers(), 'Content-Type': 'application/octet-stream' }, body: file.slice(start, start + partSize) }));
          const result = await response.json();
          const etag = result.etag || result.ETag;
          if (typeof etag !== 'string') throw new QaClientError('invalid_upload', 500);
          parts.push({ partNumber, etag }); onProgress?.(Math.round(Math.min(start + partSize, file.size) / file.size * 95));
        }
      }
      return complete();
    },
    async download(attachmentId: string, signal?: AbortSignal): Promise<Blob> {
      ensureEnabled();
      if (mock) {
        const file = demoFiles.get(attachmentId);
        if (!file) throw new QaClientError('not_found', 404);
        return file;
      }
      const response = await checkResponse(await fetch(fnUrl('qa'), { method: 'POST', signal, headers: { ...await headers(), 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'download', attachmentId }) }));
      return response.blob();
    },
  };
  return api;
}
export type QaClient = ReturnType<typeof createQaClient>;
