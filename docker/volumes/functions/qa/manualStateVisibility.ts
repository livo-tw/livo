import { QA_STATES, QaError, type QaState } from './domain.ts';
import type { QaWorkflow } from './workflow.ts';

export const QA_MANUAL_STATE_VISIBILITY_KEY = 'qa_manual_state_visibility';
/** Choice visibility is presentation only; it never changes workflow or command permission. */
export interface QaManualStateVisibility { version: 1; hiddenStates: QaState[]; }
export function defaultQaManualStateVisibility(): QaManualStateVisibility { return { version: 1, hiddenStates: [] }; }
export function validateQaManualStateVisibility(value: unknown): QaManualStateVisibility {
  const fail = (): never => { throw new QaError('qa_invalid_manual_state_visibility'); };
  if (!value || typeof value !== 'object' || Array.isArray(value)) return fail();
  const raw = value as Record<string, unknown>;
  if (raw.version !== 1 || Object.keys(raw).length !== 2 || Object.keys(raw).some(key => !['version', 'hiddenStates'].includes(key))
    || !Array.isArray(raw.hiddenStates) || raw.hiddenStates.length > QA_STATES.length
    || new Set(raw.hiddenStates).size !== raw.hiddenStates.length
    || raw.hiddenStates.some(state => !QA_STATES.includes(state))) return fail();
  return { version: 1, hiddenStates: QA_STATES.filter(state => (raw.hiddenStates as unknown[]).includes(state)) };
}
/** Malformed display preferences restore all choices; authorization remains in canQaCommand. */
export function parseQaManualStateVisibility(value: unknown): QaManualStateVisibility {
  try { return validateQaManualStateVisibility(typeof value === 'string' ? JSON.parse(value) : value); }
  catch { return defaultQaManualStateVisibility(); }
}
export function getQaManualStateChoices(workflow: QaWorkflow, configuration: QaManualStateVisibility): QaState[] {
  const hidden = new Set(configuration.hiddenStates);
  return workflow.order.filter(state => !hidden.has(state));
}
