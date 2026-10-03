import { canQaCommand, QA_STATES, type QaActor, type QaCommand, type QaIssue, type QaState } from './domain';

export interface QaActionDefaults { result?: 'pass' | 'fail'; resolution?: 'fixed' | 'wont_fix' }

export type QaDropIntent =
  | { kind: 'none' }
  | { kind: 'blocked'; reason: 'permission' | 'invalid' }
  | { kind: 'command'; command: Extract<QaCommand, { type: 'set_state' }> };

/** Change the workflow label directly; deployment and test evidence remain separate records. */
export function getQaDropIntent(issue: QaIssue, actor: QaActor, states: readonly QaState[], targetState = states[0]): QaDropIntent {
  if (!states.length || states.some(state => !QA_STATES.includes(state)) || !states.includes(targetState)) return { kind: 'blocked', reason: 'invalid' };
  if (states.includes(issue.state)) return { kind: 'none' };
  return canQaCommand(issue, actor, 'set_state')
    ? { kind: 'command', command: { type: 'set_state', state: targetState } }
    : { kind: 'blocked', reason: 'permission' };
}
