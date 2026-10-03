import { canQaCommand, isHistoricalQaPass, requiredTargetsPassed, type QaActor, type QaCommand, type QaIssue, type QaState } from './domain';

export interface QaActionDefaults { result?: 'pass' | 'fail'; resolution?: 'fixed' | 'wont_fix' }

export type QaDropIntent =
  | { kind: 'none' }
  | { kind: 'blocked' }
  | { kind: 'command'; command: Extract<QaCommand, { type: 'start_fix' }> }
  | { kind: 'form'; action: QaCommand['type']; result?: 'pass' | 'fail'; resolution?: 'fixed' | 'wont_fix' };

/** A display column can contain several states. A drop must still use a real QA command. */
export function getQaDropIntent(issue: QaIssue, actor: QaActor, states: readonly QaState[]): QaDropIntent {
  if (states.includes(issue.state)) return { kind: 'none' };
  const allowed = (type: QaCommand['type']) => canQaCommand(issue, actor, type);
  if (states.includes('in_progress') && ['triaged', 'failed'].includes(issue.state) && allowed('start_fix')) {
    if (!issue.assigneeId || !issue.qaOwnerId) return allowed('triage') ? { kind: 'form', action: 'triage' } : { kind: 'blocked' };
    return { kind: 'command', command: { type: 'start_fix' } };
  }
  if (states.includes('triaged') && issue.state === 'new' && allowed('triage')) return { kind: 'form', action: 'triage' };
  if (states.includes('verification') && allowed('submit_fix')) return { kind: 'form', action: 'submit_fix' };
  if (issue.targets.some(target => target.deployedAt) && allowed('record_verification')) {
    if (states.includes('verified')) return { kind: 'form', action: 'record_verification', result: 'pass' };
    if (states.includes('failed')) return { kind: 'form', action: 'record_verification', result: 'fail' };
  }
  if (states.includes('closed') && allowed('close') && (isHistoricalQaPass(issue) || (['verified', 'verification'].includes(issue.state) && requiredTargetsPassed(issue)))) return { kind: 'form', action: 'close', resolution: 'fixed' };
  if (states.includes('dismissed') && allowed('close')) return { kind: 'form', action: 'close', resolution: 'wont_fix' };
  if (allowed('reopen') && states.includes(issue.assigneeId ? 'in_progress' : 'new')) return { kind: 'form', action: 'reopen' };
  return { kind: 'blocked' };
}
