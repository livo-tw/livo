/** Shared knowledge execution contract. Source text never carries execution state. */
export type KnowledgeTargetKind = 'task' | 'qa';
export type KnowledgeRelation = 'reference' | 'meeting' | 'decision' | 'verification';
export interface KnowledgeChecklistItem {
  id: string; pageId: string; anchorId: string; text: string; isDone: boolean; version: number;
  updatedBy: string; updatedAt: string; completedBy: string | null; completedAt: string | null; linkedWorkId: string | null;
}
export interface KnowledgeWorkLink {
  id: string; pageId: string; anchorId: string; checklistId: string | null; snapshotId: string | null;
  targetKind: KnowledgeTargetKind; targetId: string; relation: KnowledgeRelation;
  title: string; key: string; status: string; assigneeId: string | null; dueDate: string | null; unavailable: boolean;
}
export interface KnowledgeSourceSnapshot {
  id: string; pageId: string; sourceKind: string; sourceTitle: string; sourceUrl: string | null;
  bodyHash: string; pageVersion: number; createdAt: string; body?: string; provenance?: Record<string, unknown>;
}
export interface KnowledgeWorkflowData { pageVersion: number; checklist: KnowledgeChecklistItem[]; links: KnowledgeWorkLink[]; snapshots: KnowledgeSourceSnapshot[]; }
export interface RelatedKnowledgePage { linkId: string; pageId: string; title: string; category: string; anchorId: string; relation: KnowledgeRelation; }
export class KnowledgeWorkflowError extends Error {
  constructor(public readonly code: string, public readonly status = 400) { super(code); this.name = 'KnowledgeWorkflowError'; }
}
export function workflowFail(code: string, status = 400): never { throw new KnowledgeWorkflowError(code, status); }
export const workflowRecord = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value)
  ? value as Record<string, unknown> : workflowFail('kb_workflow_invalid');
export function workflowId(value: unknown): string {
  return typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(value) ? value : workflowFail('kb_workflow_invalid');
}
export function workflowText(value: unknown, max = 2000, required = true): string {
  if (typeof value !== 'string' || value.length > max || value.includes('\0') || (required && !value.trim())) return workflowFail('kb_workflow_invalid');
  return value.trim();
}
export function workflowVersion(value: unknown): number {
  return Number.isSafeInteger(value) && Number(value) > 0 ? Number(value) : workflowFail('kb_workflow_invalid');
}
export function workflowTarget(value: unknown): KnowledgeTargetKind {
  return value === 'task' || value === 'qa' ? value : workflowFail('kb_workflow_invalid');
}
export function workflowRelation(value: unknown): KnowledgeRelation {
  return ['reference', 'meeting', 'decision', 'verification'].includes(String(value)) ? value as KnowledgeRelation : workflowFail('kb_workflow_invalid');
}
export function canonicalWorkflow(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalWorkflow).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.entries(value).filter(([, v]) => v !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${JSON.stringify(k)}:${canonicalWorkflow(v)}`).join(',')}}`;
  return JSON.stringify(value) ?? 'null';
}
export async function workflowHash(value: string): Promise<string> {
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)))].map(v => v.toString(16).padStart(2, '0')).join('');
}
/** Escape selected plain text before placing it into the task's HTML spec. */
export function workflowDescription(value: unknown): string {
  const text = workflowText(value ?? '', 20000, false);
  return text ? `<p>${text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\n/g, '<br>')}</p>` : '';
}
export function workflowDue(value: unknown): string | null {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value) || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString().slice(0, 10) !== value) return workflowFail('kb_workflow_invalid');
  return value;
}
