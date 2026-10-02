import { supabase, USING_MOCK_BACKEND } from '@/integrations/supabase/client';
import { createClient } from '@supabase/supabase-js';
import { fnUrl } from '@/lib/apiBase';
import { SUPABASE_URL } from '@/lib/gatewayUrl';
import { parseQaWorkflow, validateQaWorkflow, type QaWorkflow } from './workflow';
import { qaVersionSuggestions } from './versions';
import { randomUUID } from '@/lib/generateId';
import { applyQaCommand, createQaIssue, QA_MAX_FILE_BYTES, QA_PART_BYTES, QaError } from './domain';
import type { QaAttachment, QaCommand, QaComment, QaContext, QaCreateInput, QaDetail, QaIssue, QaListInput, QaListResult, QaUpload } from './domain';

export class QaClientError extends Error {
  constructor(public readonly code: string, public readonly status: number, message = code) { super(message); this.name = 'QaClientError'; }
}

// Demo data never leaves this tab or enters the real task tables.
const demoIssues = new Map<string, QaDetail>();
const demoFiles = new Map<string, Blob>();
const demoCommands = new Map<string, unknown>();
const demoWorkflows = new Map<string, QaWorkflow>();
const clone = <T,>(value: T): T => structuredClone(value);
export const qaId = randomUUID;

export interface QaClientOptions { enabled: () => boolean; context: () => QaContext; mock?: boolean; }
export function createQaClient(options: QaClientOptions) {
  const mock = options.mock ?? USING_MOCK_BACKEND;
  const ensureEnabled = () => { if (!options.enabled()) throw new QaClientError('qa_disabled', 403); };
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
  const demoOnce = <T,>(commandId: string, work: () => T): T => {
    const key = `${options.context().workspaceId}:${options.context().actor.id}:${commandId}`;
    if (demoCommands.has(key)) return clone(demoCommands.get(key) as T);
    const value = work(); demoCommands.set(key, clone(value)); return clone(value);
  };
  const api = {
    async versions(projectId: string, signal?: AbortSignal): Promise<string[]> {
      ensureEnabled();
      if (!projectId) return [];
      if (!mock) return request('versions', { projectId }, signal);
      const ctx = options.context();
      if (!ctx.projectIds.has(projectId)) throw new QaClientError('qa_project_unavailable', 403);
      return qaVersionSuggestions([...demoIssues.values()].map(value => value.issue), ctx.workspaceId, projectId);
    },
    async getWorkflow(signal?: AbortSignal): Promise<QaWorkflow> {
      ensureEnabled();
      return mock ? parseQaWorkflow(demoWorkflows.get(options.context().workspaceId)) : request('get_workflow', {}, signal);
    },
    async saveWorkflow(input: QaWorkflow): Promise<QaWorkflow> {
      ensureEnabled(); const workflow = validateQaWorkflow(input), ctx = options.context();
      if (!['admin','super_admin'].includes(ctx.actor.role)) throw new QaClientError('qa_forbidden',403);
      if (!mock) return request('save_workflow', { workflow });
      demoWorkflows.set(ctx.workspaceId, clone(workflow)); return clone(workflow);
    },
    async list(input: QaListInput, signal?: AbortSignal): Promise<QaListResult> {
      ensureEnabled();
      if (!mock) return request('list', { input }, signal);
      const context = options.context();
      const issues = [...demoIssues.values()].map(d => d.issue).filter(issue => issue.workspaceId === context.workspaceId &&
        (!input.projectId || issue.projectId === input.projectId) && (!input.state || issue.state === input.state) &&
        (!input.search || `${issue.title} ${issue.id}`.toLowerCase().includes(input.search.toLowerCase())) &&
        (!input.mine || (input.mine === 'assigned' ? issue.assigneeId : input.mine === 'testing' ? issue.qaOwnerId : issue.reporterId) === context.actor.id))
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
      const offset = input.offset || 0, limit = input.limit || 25;
      return clone({ issues: issues.slice(offset, offset + limit), total: issues.length, hasMore: offset + limit < issues.length });
    },
    async get(id: string, signal?: AbortSignal): Promise<QaDetail> {
      ensureEnabled(); return mock ? clone(getDemo(id)) : request('get', { id }, signal);
    },
    async create(input: QaCreateInput, id = qaId(), commandId = qaId()): Promise<QaIssue> {
      ensureEnabled();
      if (!mock) return request('create', { id, commandId, input });
      return demoOnce(commandId, () => {
        if (demoIssues.has(id)) throw new QaClientError('conflict', 409);
        const ctx = options.context(), issue = createQaIssue(input, id, ctx);
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
        const ctx = { ...options.context(), duplicateIssueIds: new Set([...demoIssues.values()].filter(d => d.issue.workspaceId === issue.workspaceId).map(d => d.issue.id)) };
        detail.issue = applyQaCommand(detail.issue, command, ctx);
        detail.events.push({ id: qaId(), issueId: issue.id, actorId: ctx.actor.id, type: command.type, detail: 'reason' in command ? command.reason : '', createdAt: ctx.now, version: detail.issue.version });
        return detail.issue;
      });
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
    async upload(id: string, file: File, onProgress?: (percent: number) => void, signal?: AbortSignal): Promise<QaAttachment> {
      ensureEnabled();
      signal?.throwIfAborted();
      if (!file.size || file.size > QA_MAX_FILE_BYTES) throw new QaClientError('file_size', 400);
      onProgress?.(0);
      if (mock) {
        const ctx = options.context(), attachment = { id: qaId(), issueId: id, fileName: file.name, mimeType: file.type || 'application/octet-stream', size: file.size, uploadedBy: ctx.actor.id, createdAt: ctx.now };
        getDemo(id).attachments.push(attachment); demoFiles.set(attachment.id, file); onProgress?.(100); return clone(attachment);
      }
      const upload = await request<QaUpload>('upload_init', { id, fileName: file.name, mimeType: file.type || 'application/octet-stream', size: file.size }, signal);
      const parts: Array<{ partNumber: number; etag: string }> = [];
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
        signal?.throwIfAborted();
        if (error) throw new QaClientError('upload_failed', 400, error.message);
        onProgress?.(95);
      } else {
        const partSize = upload.partSize || QA_PART_BYTES;
        for (let start = 0, partNumber = 1; start < file.size; start += partSize, partNumber++) {
          const url = `${fnUrl('qa')}?action=upload_part&uploadId=${encodeURIComponent(upload.id)}&partNumber=${partNumber}`;
          const response = await checkResponse(await fetch(url, { method: 'POST', signal, headers: { ...await headers(), 'Content-Type': 'application/octet-stream' }, body: file.slice(start, start + partSize) }));
          const result = await response.json();
          const etag = result.etag || result.ETag;
          if (typeof etag !== 'string') throw new QaClientError('invalid_upload', 500);
          parts.push({ partNumber, etag }); onProgress?.(Math.round(Math.min(start + partSize, file.size) / file.size * 95));
        }
      }
      const result = await request<QaAttachment>('upload_complete', { uploadId: upload.id, ...(parts.length ? { parts } : {}) }, signal);
      onProgress?.(100); return result;
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
