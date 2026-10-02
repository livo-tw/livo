import { getQaNextAction } from './QaIssueCard';
import { useQaNavigationGuard } from '@/hooks/useQaNavigationGuard';
import { useDeploymentEnvironments } from '@/context/DeploymentEnvironmentContext';
import { ArrowLeft, Bug, RefreshCw, MessageSquare, History, FileText, ClipboardCheck, ExternalLink } from 'lucide-react';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { ProjectBadge } from '@/components/ui/badges';
import { QaPriorityBadge, QaSeverityBadge, QaStateBadge, qaPriorities } from './QaBadges';
import QaEnvironmentField from './QaEnvironmentField';
import { QaText } from './QaText';
import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useMemberContext } from '@/context/MemberContext';
import { useProjectContext } from '@/context/ProjectContext';
import { useTaskContext } from '@/context/TaskContext';
import { useUIContext } from '@/context/UIContext';
import { canQaCommand, isHistoricalQaPass, requiredTargetsPassed } from '@/lib/qa/domain';
import type { QaActor, QaCommand, QaDetail, QaResolution, QaResult, QaSeverity, QaTarget } from '@/lib/qa/domain';
import type { QaClient } from '@/lib/qa/client';
import type { QaWorkflow } from '@/lib/qa/workflow';
import { qaId } from '@/lib/qa/client';
import { QaField, QaSection, QaSelect, qaButton, qaPrimary } from './QaFields';
import QaReportForm from './QaReportForm';
import QaAttachments from './QaAttachments';
import QaLegacyAttachments from './QaLegacyAttachments';
import { QaVersionField } from './QaVersionField';
import { useQaVersions } from '@/hooks/useQaVersions';

type ActionType = QaCommand['type'];
const actionLabels: Record<ActionType, string> = { edit: 'edit', triage: 'triage', start_fix: 'startFix', submit_fix: 'submitFix', record_deployment: 'deployment', record_verification: 'verification', close: 'close', reopen: 'reopen', hold: 'hold', link_tasks: 'taskLinks' };
const displayDate = (value: string) => new Date(value).toLocaleString();
export function QaFailure({ error }: { error: unknown }) {
  const { t } = useTranslation();
  const failure = error as { status?: number; code?: string };
  return <div role="alert" className="rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive"><p>{t(failure?.status === 409 ? 'qa.conflict' : 'qa.failed')}</p>{failure?.code && <p className="mt-1 font-mono text-xs">{t('qa.errorCode', { code: failure.code })}</p>}</div>;
}

export default function QaIssueDetail({ detail, client, actor, workflow, initialAction, onRefresh, onBack }: { detail: QaDetail; client: QaClient; actor: QaActor; workflow?: QaWorkflow; initialAction?: ActionType; onRefresh: () => Promise<void>; onBack: () => void }) {
  const { t } = useTranslation();
  const environments = useDeploymentEnvironments();
  const { users } = useMemberContext();
  const { allProjects, productLines } = useProjectContext();
  const { allTasks } = useTaskContext();
  const { setSelectedTask } = useUIContext();
  const issue = detail.issue;
  const [action, setAction] = useState<ActionType | null>(() => initialAction && !['record_verification', 'record_deployment'].includes(initialAction) && canQaCommand(issue, actor, initialAction) ? initialAction : null);
  const [commandBusy, setBusy] = useState(false);
  const [attachmentBusy, setAttachmentBusy] = useState(false);
  const busy = commandBusy || attachmentBusy;
  useQaNavigationGuard(attachmentBusy);
  const [error, setError] = useState<unknown>(null);
  const [notice, setNotice] = useState('');
  const [tab, setTab] = useState<'details' | 'verification' | 'comments' | 'history'>(initialAction === 'record_verification' || initialAction === 'record_deployment' ? 'verification' : 'details');
  const [comment, setComment] = useState('');
  const canResolveFixed = isHistoricalQaPass(issue) || (['verified', 'verification'].includes(issue.state) && requiredTargetsPassed(issue));
  const [resolution, setResolution] = useState<QaResolution | ''>(() => canResolveFixed ? 'fixed' : '');
  const [taskSearch, setTaskSearch] = useState('');
  const [links, setLinks] = useState(issue.taskIds);
  const [targets, setTargets] = useState<Array<Pick<QaTarget, 'environment' | 'component' | 'build' | 'required'>>>([{ environment: issue.observedEnvironment, component: '', build: '', required: true }]);
  const versions = useQaVersions(client, action === 'submit_fix' ? issue.projectId : '');
  const pendingCommand = useRef<{ signature: string; id: string }>();
  const pendingComment = useRef<{ body: string; id: string }>();
  const visibleEvents = detail.events.filter(event => event.type !== 'legacy_import');
  const source = (issue as unknown as { legacySource?: { recordUrl?: string } }).legacySource;
  const sourceUrl = source?.recordUrl && /^https:\/\/[^/]+\.slack\.com\//i.test(source.recordUrl) ? source.recordUrl : null;
  const nextAction = getQaNextAction(issue, actor);
  const can = (type: ActionType) => canQaCommand(issue, actor, type);
  const member = (id: string | null) => users.find(user => user.id === id)?.name || id || '—';
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
    event.preventDefault(); const data = new FormData(event.currentTarget), text = (key: string) => String(data.get(key) || '').trim();
    let command: QaCommand | undefined;
    if (action === 'triage') command = { type: action, assigneeId: text('assigneeId'), qaOwnerId: text('qaOwnerId'), severity: text('severity') as QaSeverity, priority: Number(text('priority')), dueDate: text('dueDate') || null };
    if (action === 'start_fix') command = { type: action };
    if (action === 'submit_fix' && environments.ready) command = { type: action, summary: text('summary'), targets };
    if (action === 'close' && resolution) command = { type: action, resolution, reason: text('reason'), ...(isHistoricalQaPass(issue) && resolution === 'fixed' ? { acknowledgeHistoricalPass: data.get('acknowledgeHistoricalPass') === 'on' } : {}), ...(resolution === 'duplicate' ? { duplicateOfId: text('duplicateOfId') } : {}) };
    if (action === 'reopen' || action === 'hold') command = { type: action, reason: text('reason') };
    if (action === 'link_tasks') command = { type: action, taskIds: links };
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
      <div className="mb-3 flex flex-wrap items-center gap-2"><Bug size={15} className="text-muted-foreground" aria-hidden="true" /><ProjectBadge name={allProjects.find(p => p.id === issue.projectId)?.name} color={allProjects.find(p => p.id === issue.projectId)?.color || '#6B778C'} /><span title={issue.id} className="font-mono text-xs text-muted-foreground">#{issue.id.slice(-8)}</span>{sourceUrl && <a href={sourceUrl} target="_blank" rel="noopener noreferrer" className="ml-auto inline-flex items-center gap-1 text-xs text-primary hover:underline">{t('qa.slackSource')}<ExternalLink size={12} aria-hidden="true" /></a>}</div>
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
          <div className="grid gap-4 xl:grid-cols-2">{(['actual', 'expected'] as const).map(key => <section key={key} className="min-w-0 rounded-lg border border-border/70 bg-muted/20 p-4"><h3 className="mb-2 text-sm font-semibold">{t(`qa.${key}`)}</h3><p className="whitespace-pre-wrap break-words text-sm leading-relaxed"><QaText text={issue[key] || t('qa.notProvided')} /></p></section>)}</div>
          <section className="mt-5"><h3 className="mb-2 text-sm font-semibold">{t('qa.steps')}</h3><p className="whitespace-pre-wrap break-words rounded-lg bg-muted/30 p-4 text-sm leading-relaxed"><QaText text={issue.steps || t('qa.notProvided')} /></p></section>
          {issue.holdReason && <p className="mt-4 rounded border border-amber-500/30 bg-amber-500/5 p-3 text-sm">{t('qa.hold')}: {issue.holdReason}</p>}
          {issue.resolution && <p className="mt-4 whitespace-pre-wrap rounded bg-muted p-3 text-sm">{t(`qa.resolution.${issue.resolution}`)} · {issue.resolutionReason}{issue.duplicateOfId && <> · <a className="underline" href={`?qa=${encodeURIComponent(issue.duplicateOfId)}`}>{issue.duplicateOfId}</a></>}</p>}
        </QaSection>
        <QaSection title={t('qa.attachments')}><QaAttachments issueId={issue.id} attachments={detail.attachments} client={client} onChanged={onRefresh} onError={setError} onBusyChange={setAttachmentBusy} /><QaLegacyAttachments issue={issue} /></QaSection>
        </>}
        {tab === 'verification' && <>
        <QaSection title={t('qa.targets')}>
          {issue.fixSummary && <p className="mb-3 whitespace-pre-wrap break-words text-sm">{issue.fixSummary}</p>}
          {!issue.targets.length && <p className="text-sm text-muted-foreground">{t('qa.noRuns')}</p>}
          <div className="space-y-3">{issue.targets.map(target => <QaTargetCard key={`${issue.fixCycle}:${target.id}`} target={target} canDeploy={can('record_deployment')} canVerify={can('record_verification')} busy={busy} onCommand={send} />)}</div>
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
          <div className="flex flex-wrap gap-2">{(['edit', 'triage', 'start_fix', 'submit_fix', 'close', 'reopen', 'hold', 'link_tasks'] as ActionType[]).filter(can).map(type => <button key={type} className={action === type || nextAction?.command === type ? qaPrimary : qaButton} disabled={busy} onClick={() => { setAction(type); setError(null); }}>{t(`qa.${actionLabels[type]}`)}</button>)}</div>
          {!Object.keys(actionLabels).some(type => can(type as ActionType)) && <p className="text-sm text-muted-foreground">{t('qa.noPermission')}</p>}
        </QaSection>
        <QaSection title={t('qa.properties')}>
          <dl className="grid gap-4 sm:grid-cols-2">{[['environment', issue.observedEnvironment], ['observedVersion', issue.observedVersion], ['problemArea', issue.component], ['reporter', member(issue.reporterId)], ['assignee', member(issue.assigneeId)], ['qaOwner', member(issue.qaOwnerId)], ['dueDate', issue.dueDate || '—']].map(([key, value]) => <div key={key}><dt className="text-xs text-muted-foreground">{t(`qa.${key}`)}</dt><dd className="mt-1 break-words text-sm">{value || '—'}</dd></div>)}</dl>
        </QaSection>
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
              <QaSelect label={t('qa.assignee')} name="assigneeId" required defaultValue={issue.assigneeId || ''}><option value="">{t('qa.choose')}</option>{users.filter(u => u.isActive).map(u => <option key={u.id} value={u.id}>{u.name}</option>)}</QaSelect>
              <QaSelect label={t('qa.qaOwner')} name="qaOwnerId" required defaultValue={issue.qaOwnerId || ''}><option value="">{t('qa.choose')}</option>{users.filter(u => u.isActive).map(u => <option key={u.id} value={u.id}>{u.name}</option>)}</QaSelect>
              <QaSelect label={t('qa.severity')} name="severity" required defaultValue={issue.severity === 'untriaged' ? '' : issue.severity}><option value="">{t('qa.choose')}</option>{['low', 'medium', 'high'].map(s => <option value={s} key={s}>{t(`qa.severityNames.${s}`)}</option>)}</QaSelect>
              <QaSelect label={t('qa.priority')} name="priority" required defaultValue={issue.priority}>{qaPriorities.map((value, index) => <option key={value} value={index + 1}>{t(`priority.${value}`)}</option>)}</QaSelect><QaField label={t('qa.dueDate')} name="dueDate" type="date" defaultValue={issue.dueDate || ''} />
            </>}
            {action === 'submit_fix' && <><QaField label={t('qa.fixSummary')} name="summary" multiline required maxLength={10000} />
              {targets.map((target, index) => <div key={index} className="space-y-2 rounded border border-border p-2"><QaEnvironmentField label={t('qa.environment')} required value={target.environment} onChange={environment => setTargets(previous => previous.map((item, i) => i === index ? { ...item, environment } : item))} />{(['component'] as const).map(key => <QaField key={key} label={t('qa.fixComponent')} hint={t('qa.fixComponentHint')} value={target[key]} onChange={event => setTargets(previous => previous.map((item, i) => i === index ? { ...item, [key]: event.target.value } : item))} />)}<QaVersionField label={t('qa.build')} required value={target.build} suggestions={versions} onChange={build => setTargets(previous => previous.map((item, i) => i === index ? { ...item, build } : item))} /><label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={target.required} onChange={event => setTargets(previous => previous.map((item, i) => i === index ? { ...item, required: event.target.checked } : item))} />{t('qa.required')}</label>{targets.length > 1 && <button type="button" className={qaButton} onClick={() => setTargets(previous => previous.filter((_, i) => i !== index))}>{t('qa.remove')}</button>}</div>)}
              <button type="button" className={qaButton} onClick={() => setTargets(previous => [...previous, { environment: '', component: '', build: '', required: true }])}>{t('qa.addTarget')}</button>
            </>}
            {action === 'close' && <><QaSelect label={t('qa.resolutionField')} required value={resolution} onChange={event => setResolution(event.target.value as QaResolution | '')}><option value="">{t('qa.choose')}</option>{['fixed', 'duplicate', 'not_bug', 'wont_fix', 'cannot_reproduce'].map(value => <option key={value} value={value} disabled={value === 'fixed' && !canResolveFixed}>{t(`qa.resolution.${value}`)}</option>)}</QaSelect>{resolution === 'duplicate' && <QaField label={t('qa.duplicateId')} name="duplicateOfId" required />}</>}
            {action === 'close' && resolution === 'fixed' && isHistoricalQaPass(issue) && <label className="flex items-start gap-2 rounded-lg border border-border bg-muted/30 p-3 text-sm"><input type="checkbox" name="acknowledgeHistoricalPass" required className="mt-1" /><span>{t('qa.acknowledgeHistoricalPass')}</span></label>}
            {(action === 'close' || action === 'reopen' || action === 'hold') && <QaField label={t('qa.reason')} name="reason" multiline required maxLength={10000} />}
            {action === 'link_tasks' && <><p className="text-sm text-muted-foreground">{t('qa.taskLinksHint')}</p><QaField label={t('qa.taskSearch')} value={taskSearch} onChange={event => setTaskSearch(event.target.value)} /><div className="max-h-60 space-y-2 overflow-y-auto">{allTasks.filter(task => `${task.taskKey} ${task.title}`.toLowerCase().includes(taskSearch.toLowerCase())).slice(0, 100).map(task => <label key={task.id} className="flex items-start gap-2 text-sm"><input className="mt-1" type="checkbox" checked={links.includes(task.id)} onChange={event => setLinks(previous => event.target.checked ? [...previous, task.id] : previous.filter(id => id !== task.id))} /><span>{task.taskKey} · {task.title}</span></label>)}</div></>}
            <p className="text-xs text-muted-foreground">{t('qa.unsent')}</p>
            <div className="flex gap-2"><button className={qaPrimary} type="submit" disabled={action === 'submit_fix' && !environments.ready}>{t('qa.save')}</button><button className={qaButton} type="button" onClick={() => setAction(null)}>{t('qa.cancel')}</button></div>
          </fieldset></form>}
      </DialogContent>
    </Dialog>
  </div>;
}

function QaTargetCard({ target, canDeploy, canVerify, busy, onCommand }: { target: QaTarget; canDeploy: boolean; canVerify: boolean; busy: boolean; onCommand: (command: QaCommand) => Promise<void> }) {
  const { t } = useTranslation();
  const [evidence, setEvidence] = useState('');
  const [result, setResult] = useState<QaResult>('pass');
  const [note, setNote] = useState('');
  return <article className="space-y-3 rounded-lg border border-border p-3">
    <div><h3 className="break-words text-sm font-semibold">{[target.environment, target.component, target.build].filter(Boolean).join(' / ')}</h3><p className="mt-1 text-xs text-muted-foreground">{t(target.deployedAt ? 'qa.deployed' : 'qa.notDeployed')}{target.deployedAt && ` · ${displayDate(target.deployedAt)}`}{target.required && ` · ${t('qa.required')}`}</p>{target.deploymentEvidence && <p className="mt-1 whitespace-pre-wrap break-words text-sm">{target.deploymentEvidence}</p>}</div>
    {canDeploy && !target.deployedAt && <form className="space-y-2" onSubmit={event => { event.preventDefault(); void onCommand({ type: 'record_deployment', targetId: target.id, build: target.build, evidence }); }}><QaField label={t('qa.deploymentEvidence')} required value={evidence} onChange={event => setEvidence(event.target.value)} disabled={busy} /><button className={qaButton} disabled={busy}>{t('qa.deployment')}</button></form>}
    {canVerify && target.deployedAt && <form className="space-y-2 border-t border-border pt-3" onSubmit={event => { event.preventDefault(); void onCommand({ type: 'record_verification', targetId: target.id, build: target.build, result, note }); }}><QaSelect label={t('qa.resultField')} value={result} onChange={event => setResult(event.target.value as QaResult)} disabled={busy}>{['pass', 'fail', 'blocked'].map(value => <option key={value} value={value}>{t(`qa.result.${value}`)}</option>)}</QaSelect><QaField label={t('qa.note')} multiline required value={note} onChange={event => setNote(event.target.value)} disabled={busy} /><button className={qaButton} disabled={busy}>{t('qa.verification')}</button></form>}
  </article>;
}
