import { useProjectColor } from '@/hooks/useProjectColor';
import { ArrowRight, Server, UserRound } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { ProjectBadge, UserBadge } from '@/components/ui/badges';
import { useProjectContext } from '@/context/ProjectContext';
import { useMemberContext } from '@/context/MemberContext';
import { canQaCommand, type QaActor, type QaCommand, type QaIssue } from '@/lib/qa/domain';
import { QaPriorityBadge, QaSeverityBadge, QaStateBadge } from './QaBadges';

export function qaNextAction(state: string): { command: QaCommand['type']; label: string } | undefined {
  if (state === 'new') return { command: 'triage', label: 'triage' };
  if (state === 'triaged' || state === 'failed') return { command: 'start_fix', label: 'startFix' };
  if (state === 'in_progress') return { command: 'submit_fix', label: 'submitFix' };
  if (state === 'verification') return { command: 'record_verification', label: 'verification' };
  if (state === 'verified') return { command: 'close', label: 'close' };
  if (state === 'closed' || state === 'dismissed') return { command: 'reopen', label: 'reopen' };
}

export function getQaNextAction(issue: QaIssue, actor: QaActor) {
  return issue.state === 'triaged' && (!issue.assigneeId || !issue.qaOwnerId)
    ? { command: 'triage' as const, label: 'triage' }
    : issue.state === 'verification' && issue.targets.some(target => !target.deployedAt) && canQaCommand(issue, actor, 'record_deployment')
      ? { command: 'record_deployment' as const, label: 'deployment' } : qaNextAction(issue.state);
}

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
  return <article className="group min-w-0 rounded-lg border border-border/80 bg-card shadow-sm transition hover:border-primary/20 hover:shadow-md">
    <button type="button" onClick={() => onOpen(issue.id)} className={`block w-full rounded-lg p-3 text-left outline-none focus-visible:ring-2 focus-visible:ring-primary ${list ? 'md:grid md:grid-cols-[minmax(0,1fr)_minmax(220px,0.7fr)] md:gap-x-6' : ''}`}>
      <div className="min-w-0">
        <div className="mb-2 flex min-w-0 items-center justify-between gap-2">
          <ProjectBadge name={project?.name || '—'} color={getProjectColor(project)} size="xs" />
        </div>
        <h3 className="line-clamp-3 break-words text-sm font-semibold leading-relaxed group-hover:text-primary">{issue.title}</h3>
        <p className="mt-1 text-xs text-muted-foreground" title={issue.id}>#{issue.id.slice(-8)}</p>
        {stateLabel && <div className="mt-2"><QaStateBadge state={issue.state} label={stateLabel} /></div>}
      </div>
      <div className="min-w-0">
        <div className="mt-2 flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground"><Server size={12} className="shrink-0" aria-hidden="true" /><span className="truncate">{issue.observedEnvironment || '—'}{issue.observedVersion && ` · ${issue.observedVersion}`}</span></div>
        <div className="mt-2 flex flex-wrap items-center gap-2"><QaPriorityBadge priority={issue.priority} issue={issue} /><QaSeverityBadge severity={issue.severity} /></div>
        <div className="mt-2 grid grid-cols-2 gap-2 pt-1">
          {[{ label: 'assignee', user: assignee }, { label: 'qaOwner', user: qaOwner }].map(({ label, user }) => <div key={label} className="min-w-0"><span className="mb-1 block text-[10px] text-muted-foreground">{t(`qa.${label}`)}</span>{user ? <UserBadge user={user} /> : <span className="inline-flex items-center gap-1 text-xs text-muted-foreground"><UserRound size={12} aria-hidden="true" />{t('qa.unassigned')}</span>}</div>)}
        </div>
      </div>
    </button>
    {next && canQaCommand(issue, actor, next.command) && <div className="border-t border-border/60 px-3 py-1.5"><button type="button" className="inline-flex w-full items-center justify-between rounded px-1 py-1 text-xs font-medium text-primary outline-none hover:bg-primary/5 focus-visible:ring-2 focus-visible:ring-primary" onClick={() => onOpen(issue.id, next.command)}>{t(`qa.${next.label}`)}<ArrowRight size={13} aria-hidden="true" /></button></div>}
  </article>;
}
