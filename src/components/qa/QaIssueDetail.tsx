import { getQaNextAction } from './QaIssueCard';
import RelatedKnowledge from '@/components/knowledge/RelatedKnowledge';
import { useQaNavigationGuard } from '@/hooks/useQaNavigationGuard';
import { useProjectColor } from '@/hooks/useProjectColor';
import { useDeploymentEnvironments } from '@/context/DeploymentEnvironmentContext';
import { ArrowLeft, Bug, RefreshCw, MessageSquare, History, FileText, ClipboardCheck, ExternalLink, MoreHorizontal } from 'lucide-react';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import UserSelect from '@/components/UserSelect';
import { ProjectBadge } from '@/components/ui/badges';
import { QaPriorityBadge, QaSeverityBadge, QaStateBadge, qaPriorities } from './QaBadges';
import QaTargetEditor, { type QaTargetDraft } from './QaTargetEditor';
import QaVerificationPanel from './QaVerificationPanel';
import { QaText } from './QaText';
import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useMemberContext } from '@/context/MemberContext';
import { useProjectContext } from '@/context/ProjectContext';
import { useTaskContext } from '@/context/TaskContext';
import { useUIContext } from '@/context/UIContext';
import { canQaCommand, isHistoricalQaPass, requiredTargetsPassed } from '@/lib/qa/domain';
import type { QaActor, QaCommand, QaDetail, QaResolution, QaSeverity } from '@/lib/qa/domain';
import type { QaClient } from '@/lib/qa/client';
import type { QaWorkflow } from '@/lib/qa/workflow';
import type { QaActionDefaults } from '@/lib/qa/boardInteraction';
import { qaId } from '@/lib/qa/client';
import { QaField, QaSection, QaSelect, qaButton, qaPrimary } from './QaFields';
import QaReportForm from './QaReportForm';
import QaAttachments from './QaAttachments';
import QaLegacyAttachments from './QaLegacyAttachments';
import { useQaVersions } from '@/hooks/useQaVersions';

type ActionType = QaCommand['type'];
const actionLabels: Record<ActionType, string> = { edit: 'edit', triage: 'triage', start_fix: 'startFix', submit_fix: 'submitFix', record_deployment: 'deployment', record_verification: 'verification', close: 'close', reopen: 'reopen', hold: 'hold', link_tasks: 'taskLinks' };
const displayDate = (value: string) => new Date(value).toLocaleString();
export function QaFailure({ error }: { error: unknown }) {
  const { t } = useTranslation();
  const failure = error as { status?: number; code?: string };
  return <div role="alert" className="rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive"><p>{t(failure?.status === 409 ? 'qa.conflict' : 'qa.failed')}</p>{failure?.code && <p className="mt-1 font-mono text-xs">{t('qa.errorCode', { code: failure.code })}</p>}</div>;
}

export default function QaIssueDetail({ detail, client, actor, workflow, initialAction, initialDefaults, onRefresh, onBack }: { detail: QaDetail; client: QaClient; actor: QaActor; workflow?: QaWorkflow; initialAction?: ActionType; initialDefaults?: QaActionDefaults; onRefresh: () => Promise<void>; onBack: () => void }) {
  const { t } = useTranslation();
  const environments = useDeploymentEnvironments();
  const getProjectColor = useProjectColor();
  const { users } = useMemberContext();
  const { allProjects, productLines } = useProjectContext();
  const { allTasks } = useTaskContext();
  const { setSelectedTask } = useUIContext();
  const issue = detail.issue;
  const [action, setAction] = useState<ActionType | null>(() => initialAction && !['record_verification', 'record_deployment'].includes(initialAction) && canQaCommand(issue, actor, initialAction) ? initialAction : null);
  const [commandBusy, setBusy] = useState(false);
  const [attachmentBusy, setAttachmentBusy] = useState(false);
  const busy = commandBusy || attachmentBusy;
  useQaNavigationGuard(busy);
  const [error, setError] = useState<unknown>(null);
  const [notice, setNotice] = useState('');
  const [tab, setTab] = useState<'details' | 'verification' | 'comments' | 'history'>(initialAction === 'record_verification' || initialAction === 'record_deployment' ? 'verification' : 'details');
  const [comment, setComment] = useState('');
  const canResolveFixed = isHistoricalQaPass(issue) || (['verified', 'verification'].includes(issue.state) && requiredTargetsPassed(issue));
  const [resolution, setResolution] = useState<QaResolution | ''>(() => initialDefaults?.resolution === 'wont_fix' ? 'wont_fix' : canResolveFixed ? 'fixed' : '');
  const [taskSearch, setTaskSearch] = useState('');
  const [links, setLinks] = useState(issue.taskIds);
  const projectTasks = allTasks.filter(task => task.projectId === issue.projectId);
  const unavailableLinks = links.filter(id => !projectTasks.some(task => task.id === id));
  const [targets, setTargets] = useState<QaTargetDraft[]>([{ environment: issue.observedEnvironment, component: '', build: '', required: true }]);
  const versions = useQaVersions(client, action === 'submit_fix' ? issue.projectId : '');
  const pendingCommand = useRef<{ signature: string; id: string }>();
  const pendingComment = useRef<{ body: string; id: string }>();
  const visibleEvents = detail.events.filter(event => event.type !== 'legacy_import');
  const source = (issue as unknown as { legacySource?: { recordUrl?: string } }).legacySource;
  const sourceUrl = source?.recordUrl && /^https:\/\/[^/]+\.slack\.com\//i.test(source.recordUrl) ? source.recordUrl : null;
  const nextAction = getQaNextAction(issue, actor);
  const can = (type: ActionType) => canQaCommand(issue, actor, type);
  const member = (id: string | null) => users.find(user => user.id === id)?.name || id || '—';
  const primaryAction = nextAction && can(nextAction.command) ? nextAction : null;
  const moreActions = (['edit', 'triage', 'start_fix', 'submit_fix', 'close', 'reopen', 'hold', 'link_tasks'] as ActionType[])
    .filter(type => can(type) && type !== primaryAction?.command);
  const nextOwner = nextAction && ['start_fix', 'submit_fix'].includes(nextAction.command) ? issue.assigneeId : issue.qaOwnerId;
  const openAction = (type: ActionType) => {
    if (busy || !can(type)) return;
    setError(null);
    if (type === 'record_deployment' || type === 'record_verification') setTab('verification');
    else if (type === 'start_fix') void send({ type: 'start_fix' });
    else setAction(type);
  };
  const send = async (command: QaCommand) => {
    if (busy) return;
    setBusy(true); setError(null); setNotice('');
    const signature = JSON.stringify({ version: issue.version, command });
    if (pendingCommand.current?.signature !== signature) pendingCommand.current = { signature, id: qaId() };
    try { await client.command(issue, command, pendingCommand.current.id); pendingCommand.current = undefined; setAction(null); await onRefresh(); }
    catch (failure) { setError(failure); }
    finally { setBusy(false); }
  };
  const refresh = async () => {
    if (busy) return;
    setBusy(true);
    try { await onRefresh(); setError(null); setNotice(t('qa.refreshKept')); }
    catch (failure) { setError(failure); }
    finally { setBusy(false); }
  };
  const submitAction = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!event.currentTarget.reportValidity()) return;
    const data = new FormData(event.currentTarget), text = (key: string) => String(data.get(key) || '').trim();
    let command: QaCommand | undefined;
    if (action === 'triage') command = { type: action, assigneeId: text('assigneeId'), qaOwnerId: text('qaOwnerId'), severity: text('severity') as QaSeverity, priority: Number(text('priority')), dueDate: text('dueDate') || null };
    if (action === 'start_fix') command = { type: action };
    if (action === 'submit_fix' && environments.ready) command = { type: action, summary: text('summary'), targets };
    if (action === 'close' && resolution) command = { type: action, resolution, reason: text('reason'), ...(isHistoricalQaPass(issue) && resolution === 'fixed' ? { acknowledgeHistoricalPass: data.get('acknowledgeHistoricalPass') === 'on' } : {}), ...(resolution === 'duplicate' ? { duplicateOfId: text('duplicateOfId') } : {}) };
    if (action === 'reopen' || action === 'hold') command = { type: action, reason: text('reason') };
    if (action === 'link_tasks' && unavailableLinks.length === 0) command = { type: action, taskIds: links };
    if (command) void send(command);
  };
  const postComment = async (event: React.FormEvent) => {
    event.preventDefault(); if (busy || !comment.trim()) return;
    setBusy(true); setError(null);
    if (pendingComment.current?.body !== comment) pendingComment.current = { body: comment, id: qaId() };
    try { await client.comment(issue.id, comment, pendingComment.current.id); pendingComment.current = undefined; setComment(''); await onRefresh(); }
    catch (failure) { setError(failure); }
    finally { setBusy(false); }
  };
  return <div className="w-full min-w-0 space-y-4 p-3 md:p-5">
    <div className="flex flex-wrap items-center justify-between gap-2"><button className={qaButton} onClick={onBack} disabled={busy}><ArrowLeft size={15} aria-hidden="true" />{t('qa.back')}</button><button className={qaButton} onClick={() => void refresh()} disabled={busy}><RefreshCw size={15} aria-hidden="true" />{t('qa.refresh')}</button></div>
    <header className="rounded-xl border border-border/80 bg-card p-4 shadow-sm md:p-5">
      <div className="mb-3 flex flex-wrap items-center gap-2"><Bug size={15} className="text-muted-foreground" aria-hidden="true" /><ProjectBadge name={allProjects.find(p => p.id === issue.projectId)?.name} color={getProjectColor(issue.projectId)} /><span title={issue.id} className="font-mono text-xs text-muted-foreground">#{issue.id.slice(-8)}</span>{sourceUrl && <a href={sourceUrl} target="_blank" rel="noopener noreferrer" className="ml-auto inline-flex items-center gap-1 text-xs text-primary hover:underline">{t('qa.slackSource')}<ExternalLink size={12} aria-hidden="true" /></a>}</div>
      <h1 className="break-words text-xl font-bold leading-relaxed md:text-2xl">{issue.title}</h1>
      <div className="mt-3 flex flex-wrap items-center gap-3"><QaStateBadge state={issue.state} label={workflow?.labels[issue.state]} /><QaPriorityBadge priority={issue.priority} issue={issue} /><QaSeverityBadge severity={issue.severity} /><span className="text-xs text-muted-foreground">{t('qa.cycle', { count: issue.fixCycle })}</span></div>
    </header>
    {error !== null && !action && <QaFailure error={error} />}
    {notice && <p role="status" className="text-sm text-muted-foreground">{notice}</p>}
    {busy && <p role="status" className="text-sm">{t('qa.saving')}</p>}
    <div className="grid items-start gap-4 lg:grid-cols-[minmax(0,1fr)_300px] xl:grid-cols-[minmax(0,1fr)_340px]">
      <div className="min-w-0 space-y-4">
        <div role="tablist" aria-label={t('qa.details')} className="flex gap-1 overflow-x-auto rounded-xl border border-border/80 bg-card p-1.5">{([{ id: 'details', label: 'details', Icon: FileText, count: undefined }, { id: 'verification', label: 'verificationTab', Icon: ClipboardCheck, count: issue.targets.length }, { id: 'comments', label: 'comments', Icon: MessageSquare, count: detail.comments.length }, { id: 'history', label: 'history', Icon: History, count: visibleEvents.length }] as const).map(({ id, label, Icon, count }) => <button key={id} role="tab" disabled={busy} tabIndex={tab === id ? 0 : -1} onKeyDown={event => {
          if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
          event.preventDefault();
          const tabs = ['details', 'verification', 'comments', 'history'] as const;
          const index = tabs.indexOf(tab);
          const next = event.key === 'Home' ? 0 : event.key === 'End' ? 3 : (index + (event.key === 'ArrowRight' ? 1 : 3)) % 4;
          setTab(tabs[next]); document.getElementById(`qa-tab-${tabs[next]}`)?.focus();
        }} aria-selected={tab === id} aria-controls={`qa-panel-${id}`} id={`qa-tab-${id}`} className={`inline-flex shrink-0 items-center gap-1.5 rounded-lg px-3 py-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-primary ${tab === id ? 'bg-primary/10 font-medium text-primary' : 'text-muted-foreground hover:bg-accent'}`} onClick={() => setTab(id)}><Icon size={15} aria-hidden="true" />{t(`qa.${label}`)}{count !== undefined && <span className="rounded bg-muted px-1.5 text-xs">{count}</span>}</button>)}</div>
        <div role="tabpanel" id={`qa-panel-${tab}`} aria-labelledby={`qa-tab-${tab}`} className="space-y-4">

        {tab === 'details' && <>
        <QaSection title={t('qa.details')}>
          <section className="min-w-0"><h3 className="mb-2 text-sm font-semibold text-muted-foreground">{t('qa.actual')}</h3><div className="whitespace-pre-wrap break-words text-base leading-7"><QaText text={issue.actual || t('qa.notProvided')} /></div></section>
          {issue.expected && <section className="mt-5 border-t border-border/60 pt-4"><h3 className="mb-2 text-sm font-semibold">{t('qa.expected')}</h3><div className="whitespace-pre-wrap break-words text-sm leading-relaxed"><QaText text={issue.expected} /></div></section>}
          {issue.steps && <section className="mt-5 border-t border-border/60 pt-4"><h3 className="mb-2 text-sm font-semibold">{t('qa.steps')}</h3><div className="whitespace-pre-wrap break-words text-sm leading-relaxed"><QaText text={issue.steps} /></div></section>}
          {issue.holdReason && <p className="mt-4 rounded border border-amber-500/30 bg-amber-500/5 p-3 text-sm">{t('qa.hold')}: {issue.holdReason}</p>}
          {issue.resolution && <p className="mt-4 whitespace-pre-wrap rounded bg-muted p-3 text-sm">{t(`qa.resolution.${issue.resolution}`)} · {issue.resolutionReason}{issue.duplicateOfId && <> · <a className="underline" href={`?qa=${encodeURIComponent(issue.duplicateOfId)}`}>{issue.duplicateOfId}</a></>}</p>}
        </QaSection>
        <QaSection title={t('qa.attachments')}><QaLegacyAttachments issue={issue} /><QaAttachments compact issueId={issue.id} attachments={detail.attachments} client={client} onChanged={onRefresh} onError={setError} onBusyChange={setAttachmentBusy} /></QaSection>
        </>}
        {tab === 'verification' && <>
        <QaSection title={t('qa.targets')}>
          {issue.fixSummary && <p className="mb-3 whitespace-pre-wrap break-words text-sm">{issue.fixSummary}</p>}
          {!issue.targets.length && <p className="text-sm text-muted-foreground">{t('qa.noRuns')}</p>}
          <QaVerificationPanel key={issue.fixCycle} targets={issue.targets} initialResult={initialDefaults?.result} canDeploy={can('record_deployment')} canVerify={can('record_verification')} busy={busy} onCommand={send} />
        </QaSection>
        <QaSection title={t('qa.runs')}>
          {!issue.runs.length && <p className="text-sm text-muted-foreground">{t('qa.noRuns')}</p>}
          <ol className="space-y-3">{[...issue.runs].reverse().map(run => <li key={run.id} className="rounded border border-border p-3 text-sm"><div className="flex flex-wrap justify-between gap-2"><strong>{t(`qa.result.${run.result}`)} · {run.environment} / {run.component} / {run.build}</strong><span className="text-xs text-muted-foreground">{t('qa.cycle', { count: run.fixCycle })} · {member(run.testerId)} · {displayDate(run.createdAt)}</span></div><p className="mt-1 whitespace-pre-wrap break-words">{run.note}</p></li>)}</ol>
        </QaSection>
        </>}
        {tab === 'comments' && <>
        <QaSection title={t('qa.comments')}>
          {!detail.comments.length && <p className="mb-3 text-sm text-muted-foreground">{t('qa.noComments')}</p>}
          <ol className="mb-4 space-y-3">{detail.comments.map(row => <li key={row.id} className="border-b border-border pb-3 text-sm"><div className="mb-1 flex flex-wrap justify-between gap-2"><strong>{member(row.actorId)}</strong><span className="text-xs text-muted-foreground">{displayDate(row.createdAt)}</span></div><p className="whitespace-pre-wrap break-words"><QaText text={row.body} /></p></li>)}</ol>
          <form className="space-y-2" onSubmit={postComment}><QaField label={t('qa.commentBody')} multiline required maxLength={10000} value={comment} onChange={event => setComment(event.target.value)} disabled={busy} /><button className={qaPrimary} disabled={busy || !comment.trim()}>{t('qa.addComment')}</button></form>
        </QaSection>
        </>}
        {tab === 'history' && <>
        <QaSection title={t('qa.history')}><>{!visibleEvents.length && <p className="text-sm text-muted-foreground">{t('qa.noHistory')}</p>}<ol className="space-y-3">{[...visibleEvents].reverse().map(event => <li key={event.id} className="text-sm"><p className="font-medium">{t(`qa.${actionLabels[event.type as ActionType] || 'report'}`)} · {member(event.actorId)}</p><p className="text-xs text-muted-foreground">{displayDate(event.createdAt)}</p>{event.detail && <p className="mt-1 whitespace-pre-wrap break-words text-muted-foreground"><QaText text={event.detail} /></p>}</li>)}</ol></></QaSection>
        </>}
      </div>
      </div>
      <div className="min-w-0 space-y-4">
        <QaSection title={t('qa.actions')}>
          {primaryAction ? <div className="space-y-2"><p className="text-sm text-muted-foreground">{t('qa.yourNextStep')}</p>{tab === 'verification' && ['record_deployment', 'record_verification'].includes(primaryAction.command) ? <p className="text-sm leading-relaxed">{t('qa.completeInPanel')}</p> : <button type="button" className={`${qaPrimary} w-full`} disabled={busy} onClick={() => openAction(primaryAction.command)}>{t(`qa.${primaryAction.label}`)}</button>}</div> : nextAction && <p className="text-sm leading-relaxed text-muted-foreground">{t('qa.waitingForAction', { name: nextOwner ? member(nextOwner) : t('qa.triageTeam'), action: t(`qa.${nextAction.label}`) })}</p>}
          {moreActions.length > 0 && <DropdownMenu><DropdownMenuTrigger asChild><button type="button" className={`${qaButton} mt-3 w-full`} disabled={busy}><MoreHorizontal size={15} aria-hidden="true" />{t('qa.moreActions')}</button></DropdownMenuTrigger><DropdownMenuContent align="end" className="min-w-48">{moreActions.map(type => <DropdownMenuItem key={type} onSelect={() => openAction(type)}>{t(`qa.${actionLabels[type]}`)}</DropdownMenuItem>)}</DropdownMenuContent></DropdownMenu>}
          {!Object.keys(actionLabels).some(type => can(type as ActionType)) && <p className="text-sm text-muted-foreground">{t('qa.noPermission')}</p>}
        </QaSection>
        <QaSection title={t('qa.properties')}>
          <dl className="grid gap-4 sm:grid-cols-2">{[['environment', issue.observedEnvironment], ['observedVersion', issue.observedVersion], ['problemArea', issue.component], ['reporter', member(issue.reporterId)], ['assignee', member(issue.assigneeId)], ['qaOwner', member(issue.qaOwnerId)], ['dueDate', issue.dueDate || '—']].map(([key, value]) => <div key={key}><dt className="text-xs text-muted-foreground">{t(`qa.${key}`)}</dt><dd className="mt-1 break-words text-sm">{value || '—'}</dd></div>)}</dl>
        </QaSection>
        <RelatedKnowledge targetKind="qa" targetId={issue.id} />
        <QaSection title={t('qa.taskLinks')}><p className="mb-2 text-xs text-muted-foreground">{t('qa.taskLinksHint')}</p>{!issue.taskIds.length && <p className="text-sm text-muted-foreground">{t('qa.noTasks')}</p>}<ul className="space-y-2">{issue.taskIds.map(id => { const task = allTasks.find(row => row.id === id); return <li key={id}><button className="text-left text-sm text-primary underline disabled:text-muted-foreground" disabled={busy || !task} onClick={() => task && setSelectedTask(task)}>{task ? `${task.taskKey} · ${task.title}` : id}</button></li>; })}</ul></QaSection>

      </div>
    </div>
    <Dialog open={!!action} onOpenChange={open => { if (!open && !busy) setAction(null); }}>
      <DialogContent aria-describedby={undefined} className="max-h-[90vh] w-[calc(100%-24px)] max-w-4xl overflow-y-auto p-4 sm:p-6" onPointerDownOutside={event => event.preventDefault()} onEscapeKeyDown={event => { if (busy) event.preventDefault(); }}>
        <DialogHeader><DialogTitle>{action ? t(`qa.${actionLabels[action]}`) : ''}</DialogTitle></DialogHeader>
        {error !== null && <div className="space-y-2"><QaFailure error={error} /><button className={qaButton} disabled={busy} onClick={() => void refresh()}>{t('qa.refresh')}</button></div>}
          {action === 'edit' && can('edit') && <div className="mt-4"><QaReportForm initial={issue} projects={allProjects} productLines={productLines} client={client} busy={busy} onCancel={() => setAction(null)} onSubmit={input => void send({ type: 'edit', title: input.title, actual: input.actual, expected: input.expected || '', steps: input.steps || '', observedEnvironment: input.observedEnvironment, observedVersion: input.observedVersion || '', component: input.component || '' })} /></div>}
          {action && action !== 'edit' && can(action) && <form key={action} className="mt-4 space-y-3" onSubmit={submitAction}><fieldset disabled={busy} className="space-y-3">
            {action === 'triage' && <>
              <UserSelect label={t('qa.assignee')} name="assigneeId" required activeOnly disabled={busy} defaultValue={issue.assigneeId || ''} emptyLabel={t('qa.choose')} size="md" />
              <UserSelect label={t('qa.qaOwner')} name="qaOwnerId" required activeOnly disabled={busy} defaultValue={issue.qaOwnerId || ''} emptyLabel={t('qa.choose')} size="md" />
              <QaSelect label={t('qa.severity')} name="severity" required defaultValue={issue.severity === 'untriaged' ? '' : issue.severity}><option value="">{t('qa.choose')}</option>{['low', 'medium', 'high'].map(s => <option value={s} key={s}>{t(`qa.severityNames.${s}`)}</option>)}</QaSelect>
              <details open={!!issue.dueDate || issue.priority !== 3} className="rounded-lg border border-border p-3"><summary className="cursor-pointer text-sm font-medium">{t('qa.additionalDetails')}</summary><div className="mt-3 space-y-3"><QaSelect label={t('qa.priority')} name="priority" required defaultValue={issue.priority}>{qaPriorities.map((value, index) => <option key={value} value={index + 1}>{t(`priority.${value}`)}</option>)}</QaSelect><QaField label={t('qa.dueDate')} name="dueDate" type="date" defaultValue={issue.dueDate || ''} /></div></details>
            </>}
            {action === 'submit_fix' && <><QaField label={t('qa.fixSummary')} name="summary" multiline required maxLength={10000} />
              <QaTargetEditor targets={targets} onChange={setTargets} versions={versions} disabled={busy} />
            </>}
            {action === 'close' && <><QaSelect label={t('qa.resolutionField')} required value={resolution} onChange={event => setResolution(event.target.value as QaResolution | '')}><option value="">{t('qa.choose')}</option>{['fixed', 'duplicate', 'not_bug', 'wont_fix', 'cannot_reproduce'].map(value => <option key={value} value={value} disabled={value === 'fixed' && !canResolveFixed}>{t(`qa.resolution.${value}`)}</option>)}</QaSelect>{resolution === 'duplicate' && <QaField label={t('qa.duplicateId')} name="duplicateOfId" required />}</>}
            {action === 'close' && resolution === 'fixed' && isHistoricalQaPass(issue) && <label className="flex items-start gap-2 rounded-lg border border-border bg-muted/30 p-3 text-sm"><input type="checkbox" name="acknowledgeHistoricalPass" required className="mt-1" /><span>{t('qa.acknowledgeHistoricalPass')}</span></label>}
            {(action === 'close' || action === 'reopen' || action === 'hold') && <QaField label={t('qa.reason')} name="reason" multiline required maxLength={10000} />}
            {action === 'link_tasks' && <><p className="text-sm text-muted-foreground">{t('qa.taskLinksHint')}</p><QaField label={t('qa.taskSearch')} value={taskSearch} onChange={event => setTaskSearch(event.target.value)} />
              {unavailableLinks.length > 0 && <div className="space-y-2 rounded-lg border border-amber-500/30 p-3"><p className="text-sm text-muted-foreground">{t('qa.linkedTaskUnavailable')}</p>{unavailableLinks.map(id => { const task = allTasks.find(row => row.id === id); return <label key={id} className="flex items-start gap-2 text-sm"><input className="mt-1" type="checkbox" checked onChange={() => setLinks(previous => previous.filter(link => link !== id))} /><span>{task ? `${task.taskKey} · ${task.title}` : id}</span></label>; })}</div>}
              <div className="max-h-60 space-y-2 overflow-y-auto">{projectTasks.filter(task => `${task.taskKey} ${task.title}`.toLowerCase().includes(taskSearch.toLowerCase())).slice(0, 100).map(task => <label key={task.id} className="flex items-start gap-2 text-sm"><input className="mt-1" type="checkbox" checked={links.includes(task.id)} onChange={event => setLinks(previous => event.target.checked ? [...previous, task.id] : previous.filter(id => id !== task.id))} /><span>{task.taskKey} · {task.title}</span></label>)}</div></>}
            <p className="text-xs text-muted-foreground">{t('qa.unsent')}</p>
            <div className="flex gap-2"><button className={qaPrimary} type="submit" disabled={(action === 'submit_fix' && !environments.ready) || (action === 'link_tasks' && unavailableLinks.length > 0)}>{t('qa.save')}</button><button className={qaButton} type="button" onClick={() => setAction(null)}>{t('qa.cancel')}</button></div>
          </fieldset></form>}
      </DialogContent>
    </Dialog>
  </div>;
}
