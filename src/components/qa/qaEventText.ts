import type { TFunction } from 'i18next';
import { qaShortId } from '@/lib/qa/shortId';
import { qaPriorities } from './QaBadges';

/**
 * Readable history entries. The servers store each event as an audit snapshot
 * (qaEventDetail in lib/qa/domain.ts) with member ids, codes and JSON; stored
 * events are never rewritten, so the history page translates them here.
 * Anything unrecognised is shown as stored, with member ids replaced by names.
 */
export interface QaEventTextContext {
  t: TFunction;
  /** Member name for an id; unknown ids come back unchanged. */
  member: (id: string) => string;
  /** Task key and title for an id; unknown ids come back unchanged. */
  task: (id: string) => string;
  stateLabel: (state: string) => string;
  date: (iso: string) => string;
}

const RESOLUTIONS = ['fixed', 'duplicate', 'not_bug', 'wont_fix', 'cannot_reproduce'];
const SEVERITIES = ['untriaged', 'low', 'medium', 'high'];
const RESULTS: Record<string, string> = { PASS: 'pass', FAIL: 'fail', BLOCKED: 'blocked' };
const ISO = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z/g;

/** Event types the history lists under their own name. */
export const QA_EVENT_TYPES = ['create', 'created', 'edit', 'triage', 'start_fix', 'submit_fix', 'record_deployment', 'record_verification',
  'set_state', 'close', 'reopen', 'hold', 'link_tasks', 'request_handoff', 'accept_handoff', 'resolve_handoff'] as const;

export function qaEventTitle(event: { type: string; detail: string }, t: TFunction): string {
  if (event.type === 'hold' && !event.detail.trim()) return t('qa.historyEvent.holdCleared');
  const type = event.type === 'created' ? 'create' : event.type;
  return (QA_EVENT_TYPES as readonly string[]).includes(type) ? t(`qa.historyEvent.${type}`) : t('qa.historyEvent.update');
}

function names(text: string, ctx: QaEventTextContext): string {
  return text.replace(/[A-Za-z0-9][A-Za-z0-9_-]{2,}/g, token => ctx.member(token)).replace(ISO, value => ctx.date(value));
}

function handoff(type: string, detail: string, ctx: QaEventTextContext): string | null {
  let value: Record<string, unknown>;
  try { value = JSON.parse(detail); } catch { return null; }
  if (!value || typeof value !== 'object') return null;
  const text = (key: string) => typeof value[key] === 'string' ? String(value[key]) : '';
  const { t } = ctx;
  if (type === 'request_handoff') return [
    t('qa.historyHandoffTo', { name: ctx.member(text('nextOwnerId')) }),
    text('reason'),
    text('replyBy') && `${t('qaHandoff.replyBy')}：${ctx.date(text('replyBy'))}`,
    text('externalDependency') && `${t('qaHandoff.externalDependency')}：${text('externalDependency')}`,
  ].filter(Boolean).join('\n');
  if (type === 'accept_handoff') return t('qa.historyHandoffAccepted', { name: ctx.member(text('acceptedBy') || text('nextOwnerId')) });
  return [t('qaHandoff.evidence') + '：', text('resolutionEvidence')].join('\n');
}

export function qaEventText(event: { type: string; detail: string }, ctx: QaEventTextContext): string {
  const { t } = ctx, detail = event.detail || '';
  if (!detail) return '';
  if (event.type === 'set_state') {
    try { const value = JSON.parse(detail); return t('qa.stateHistory', { from: ctx.stateLabel(value.from), to: ctx.stateLabel(value.to) }); }
    catch { return detail; }
  }
  if (event.type === 'triage') {
    const match = /^RD: (\S+) · QA: (\S+)\n(\w+) · P(\d)(?:\n(\S+))?$/.exec(detail);
    if (match && SEVERITIES.includes(match[3])) return [
      `${t('qa.assignee')}：${ctx.member(match[1])} · ${t('qa.qaOwner')}：${ctx.member(match[2])}`,
      `${t('qa.severity')}：${t(`qa.severityNames.${match[3]}`)} · ${t('qa.priority')}：${t(`priority.${qaPriorities[Number(match[4]) - 1] ?? 'medium'}`)}`,
      match[5] ? `${t('qa.dueDate')}：${match[5]}` : '',
    ].filter(Boolean).join('\n');
  }
  if (event.type === 'close') {
    const [code, ...rest] = detail.split('\n');
    if (RESOLUTIONS.includes(code)) {
      const lines = [...rest];
      if (code === 'duplicate' && lines.length && /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(lines[lines.length - 1])) {
        lines[lines.length - 1] = t('qa.duplicateOf', { id: qaShortId(lines[lines.length - 1]) });
      }
      return [t(`qa.resolution.${code}`), ...lines].filter(Boolean).join('\n');
    }
  }
  if (['request_handoff', 'accept_handoff', 'resolve_handoff'].includes(event.type)) {
    const text = handoff(event.type, detail, ctx);
    if (text !== null) return text;
  }
  if (event.type === 'link_tasks') return detail.split('\n').filter(Boolean).map(ctx.task).join('\n');
  if (event.type === 'record_verification') {
    return names(detail.split('\n').map(line => RESULTS[line] ? t(`qa.result.${RESULTS[line]}`) : line).join('\n'), ctx);
  }
  return names(detail, ctx);
}
