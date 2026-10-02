import { QA_STATES, QaError, type QaState } from './domain.ts';

/** Display configuration only. State IDs and domain transitions stay fixed. */
export interface QaWorkflow { version: 1; order: QaState[]; labels: Record<QaState, string>; }
export const DEFAULT_QA_WORKFLOW: QaWorkflow = { version: 1, order: [...QA_STATES], labels: { new:'',triaged:'',in_progress:'',verification:'',closed:'' } };
export function validateQaWorkflow(value: unknown): QaWorkflow {
  const fail = (): never => { throw new QaError('qa_invalid_workflow'); };
  if (!value || typeof value !== 'object' || Array.isArray(value)) return fail();
  const raw = value as Record<string,unknown>;
  if (raw.version !== 1 || Object.keys(raw).some(key => !['version','order','labels'].includes(key))) return fail();
  if (!Array.isArray(raw.order) || raw.order.length !== QA_STATES.length || new Set(raw.order).size !== QA_STATES.length || raw.order.some(state => !QA_STATES.includes(state))) return fail();
  if (!raw.labels || typeof raw.labels !== 'object' || Array.isArray(raw.labels)) return fail();
  const input = raw.labels as Record<string,unknown>;
  if (Object.keys(input).length !== QA_STATES.length || Object.keys(input).some(key => !QA_STATES.includes(key as QaState))) return fail();
  const labels = { ...DEFAULT_QA_WORKFLOW.labels }, used = new Set<string>();
  for (const state of QA_STATES) {
    if (typeof input[state] !== 'string') return fail();
    const label = (input[state] as string).trim();
    if (label.length > 40 || /[\x00-\x1f\x7f]/.test(label)) return fail();
    if (label && used.has(label.toLowerCase())) return fail();
    if (label) used.add(label.toLowerCase());
    labels[state] = label;
  }
  return {version:1,order:[...raw.order] as QaState[],labels};
}
export function parseQaWorkflow(value: unknown): QaWorkflow {
  try { return validateQaWorkflow(typeof value === 'string' ? JSON.parse(value) : value); }
  catch { return {version:1,order:[...DEFAULT_QA_WORKFLOW.order],labels:{...DEFAULT_QA_WORKFLOW.labels}}; }
}
