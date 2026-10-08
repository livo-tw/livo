import { QA_STATES, QaError, type QaState } from './domain.ts';

export const QA_DISPLAY_SETTINGS_KEY = 'qa_display_settings';
/** Display preferences do not change issue data, workflow or command permissions. */
export interface QaDisplaySettings {
  version: 1;
  showSeverity: boolean;
  hiddenPriorityChoices: number[];
  hiddenBoardStates: QaState[];
}
export function defaultQaDisplaySettings(): QaDisplaySettings {
  return { version: 1, showSeverity: true, hiddenPriorityChoices: [], hiddenBoardStates: [] };
}
export function validateQaDisplaySettings(value: unknown): QaDisplaySettings {
  const fail = (): never => { throw new QaError('qa_invalid_display_settings'); };
  if (!value || typeof value !== 'object' || Array.isArray(value)) return fail();
  const raw = value as Record<string, unknown>;
  const keys = ['version', 'showSeverity', 'hiddenPriorityChoices', 'hiddenBoardStates'];
  if (Object.keys(raw).length !== keys.length || Object.keys(raw).some(key => !keys.includes(key))
    || raw.version !== 1 || typeof raw.showSeverity !== 'boolean'
    || !Array.isArray(raw.hiddenPriorityChoices) || raw.hiddenPriorityChoices.length >= 5
    || raw.hiddenPriorityChoices.some(priority => !Number.isInteger(priority) || priority < 1 || priority > 5)
    || new Set(raw.hiddenPriorityChoices).size !== raw.hiddenPriorityChoices.length
    || !Array.isArray(raw.hiddenBoardStates) || raw.hiddenBoardStates.length >= QA_STATES.length
    || raw.hiddenBoardStates.some(state => !QA_STATES.includes(state))
    || new Set(raw.hiddenBoardStates).size !== raw.hiddenBoardStates.length) return fail();
  return { version: 1, showSeverity: raw.showSeverity,
    hiddenPriorityChoices: [1, 2, 3, 4, 5].filter(value => (raw.hiddenPriorityChoices as unknown[]).includes(value)),
    hiddenBoardStates: QA_STATES.filter(state => (raw.hiddenBoardStates as unknown[]).includes(state)) };
}
/** Missing or malformed stored preferences restore the public default; transport failures remain errors. */
export function parseQaDisplaySettings(value: unknown): QaDisplaySettings {
  try { return validateQaDisplaySettings(typeof value === 'string' ? JSON.parse(value) : value); }
  catch { return defaultQaDisplaySettings(); }
}
export function getQaPriorityChoices(configuration: QaDisplaySettings, currentPriority?: number): number[] {
  return [1, 2, 3, 4, 5].filter(priority => !configuration.hiddenPriorityChoices.includes(priority) || priority === currentPriority);
}
/** Explicit historical status filters can reveal otherwise hidden board states. */
export function getQaBoardStates(configuration: QaDisplaySettings, states: QaState[], selected?: QaState[] | null): QaState[] {
  return states.filter(state => selected ? selected.includes(state) : !configuration.hiddenBoardStates.includes(state));
}
