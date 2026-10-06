import { useProjectColor } from '@/hooks/useProjectColor';
import { ArrowRight, CalendarDays, Hand, PauseCircle, Server, UserRound } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { ProjectBadge, UserBadge } from '@/components/ui/badges';
import { useProjectContext } from '@/context/ProjectContext';
import { useMemberContext } from '@/context/MemberContext';
import { canQaCommand, isHistoricalQaPass, isQaTerminal, requiredTargetsPassed, type QaActor, type QaCommand, type QaIssue } from '@/lib/qa/domain';
import { qaShortId } from '@/lib/qa/shortId';
import { QaPriorityBadge, QaSeverityBadge, QaStateBadge } from './QaBadges';

export function qaNextAction(state: string): { command: QaCommand['type']; label: string } | undefined {
  if (state === 'new') return { command: 'triage', label: 'triage' };
  if (state === 'triaged' || state === 'failed') return { command: 'start_fix', label: 'startFix' };
  if (state === 'in_progress') return { command: 'submit_fix', label: 'submitFix' };
  if (state === 'verification') return { command: 'record_verification', label: 'verification' };
  if (state === 'verified') return { command: 'close', label: 'close' };
  if (state === 'closed' || state === 'dismissed') return { command: 'reopen', label: 'reopen' };
}

/**
 * The step that actually moves this bug forward. A status set by hand can skip
 * the evidence a step needs, so the step follows what the bug still lacks:
 * owners first, then a fix to verify, a deployment, and a passing verification.
 */
export function getQaNextAction(issue: QaIssue, actor: QaActor): { command: QaCommand['type']; label: string } | undefined {
  if (isQaTerminal(issue.state)) return qaNextAction(issue.state);
  if (issue.state !== 'new' && (!issue.assigneeId || !issue.qaOwnerId)) return { command: 'triage', label: 'triage' };
  if ((issue.state === 'verification' || issue.state === 'verified') && !issue.targets.length && !isHistoricalQaPass(issue)) return { command: 'submit_fix', label: 'submitFix' };
  if (issue.state === 'verification' && issue.targets.some(target => !target.deployedAt) && canQaCommand(issue, actor, 'record_deployment')) return { command: 'record_deployment', label: 'deployment' };
  if (issue.state === 'verified' && !requiredTargetsPassed(issue) && !isHistoricalQaPass(issue)) return { command: 'record_verification', label: 'verification' };
  return qaNextAction(issue.state);
}

const localDay = () => { const now = new Date(); return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`; };

export default function QaIssueCard({ issue, actor, onOpen, stateLabel, list = false }: {
  issue: QaIssue; actor: QaActor; onOpen: (id: string, action?: QaCommand['type']) => void;
  stateLabel?: string; list?: boolean;
}) {
  const { t } = useTranslation();
  const getProjectColor = useProjectColor();
  const { allProjects } = useProjectContext();
  const { users } = useMemberContext();
  const project = allProjects.find(row => row.id === issue.projectId);
  const assignee = users.find(row => row.id === issue.assigneeId);
  const qaOwner = users.find(row => row.id === issue.qaOwnerId);
  const next = getQaNextAction(issue, actor);
  const open = !isQaTerminal(issue.state);
  const blocked = open && !!issue.holdReason;
  const handoff = open && !!issue.handoff && !issue.handoff.resolvedAt;
  const overdue = open && !!issue.dueDate && issue.dueDate < localDay();
  return <article className="group min-w-0 rounded-lg border border-border/80 bg-card shadow-sm transition hover:border-primary/20 hover:shadow-md">
    <button type="button" data-drag-surface onClick={() => onOpen(issue.id)} className={`block w-full rounded-lg p-3 text-left outline-none focus-visible:ring-2 focus-visible:ring-primary ${list ? 'md:grid md:grid-cols-[minmax(0,1fr)_minmax(220px,0.7fr)] md:gap-x-6' : ''}`}>
      <div className="min-w-0">
        <div className="mb-2 flex min-w-0 items-center justify-between gap-2">
          <ProjectBadge name={project?.name || '—'} color={getProjectColor(project)} size="xs" />
        </div>
        <h3 className="line-clamp-3 break-words text-sm font-semibold leading-relaxed group-hover:text-primary">{issue.title}</h3>
        <p className="mt-1 text-xs text-muted-foreground" title={issue.id}>{qaShortId(issue.id)}</p>
        {stateLabel && <div className="mt-2"><QaStateBadge state={issue.state} label={stateLabel} /></div>}
      </div>
      <div className="min-w-0">
        <div className="mt-2 flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground"><Server size={12} className="shrink-0" aria-hidden="true" /><span className="truncate">{issue.observedEnvironment || '—'}{issue.observedVersion && ` · ${issue.observedVersion}`}</span></div>
        <div className="mt-2 flex flex-wrap items-center gap-2"><QaPriorityBadge priority={issue.priority} issue={issue} />{issue.severity !== 'untriaged' && <QaSeverityBadge severity={issue.severity} />}</div>
        {(issue.dueDate || blocked || handoff) && <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
          {issue.dueDate && <span className={`inline-flex items-center gap-1 ${overdue ? 'font-medium text-destructive' : 'text-muted-foreground'}`} title={t('qa.dueDate')}><CalendarDays size={12} aria-hidden="true" />{overdue ? t('qa.overdue', { date: issue.dueDate }) : issue.dueDate}</span>}
          {blocked && <span className="inline-flex items-center gap-1 text-amber-700 dark:text-amber-400" title={issue.holdReason}><PauseCircle size={12} aria-hidden="true" />{t('qa.blocked')}</span>}
          {handoff && <span className="inline-flex items-center gap-1 text-primary"><Hand size={12} aria-hidden="true" />{t('qa.handoffOpen')}</span>}
        </div>}
        <div className="mt-2 grid grid-cols-2 gap-2 pt-1">
          {[{ label: 'assignee', user: assignee }, { label: 'qaOwner', user: qaOwner }].map(({ label, user }) => <div key={label} className="min-w-0"><span className="mb-1 block text-[10px] text-muted-foreground">{t(`qa.${label}`)}</span>{user ? <UserBadge user={user} /> : <span className="inline-flex items-center gap-1 text-xs text-muted-foreground"><UserRound size={12} aria-hidden="true" />{t('qa.unassigned')}</span>}</div>)}
        </div>
      </div>
    </button>
    {next && canQaCommand(issue, actor, next.command) && <div className="border-t border-border/60 px-3 py-1.5"><button type="button" className="inline-flex min-h-11 w-full items-center justify-between rounded px-1 py-1 text-xs font-medium text-primary outline-none hover:bg-primary/5 focus-visible:ring-2 focus-visible:ring-primary" onClick={() => onOpen(issue.id, next.command)}>{t(`qa.${next.label}`)}<ArrowRight size={13} aria-hidden="true" /></button></div>}
  </article>;
}
