import { getQaNextAction } from './QaIssueCard';
import RelatedKnowledge from '@/components/knowledge/RelatedKnowledge';
import { useQaNavigationGuard } from '@/hooks/useQaNavigationGuard';
import { useProjectColor } from '@/hooks/useProjectColor';
import { useDeploymentEnvironments } from '@/context/DeploymentEnvironmentContext';
import { ArrowLeft, Bug, RefreshCw, MessageSquare, History, FileText, ClipboardCheck, ExternalLink, MoreHorizontal, Trash2 } from 'lucide-react';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import UserSelect from '@/components/UserSelect';
import { getDepartmentPreferenceIds, getProjectDeveloperPreferenceIds } from '@/lib/memberSelection';
import { ProjectBadge } from '@/components/ui/badges';
import { QaPriorityBadge, QaSeverityBadge, QaStateBadge, qaPriorities, qaStateColors } from './QaBadges';
import QaTargetEditor, { type QaTargetDraft } from './QaTargetEditor';
import QaVerificationPanel from './QaVerificationPanel';
import QaIssueSidebarFields from './QaIssueSidebarFields';
import { QaText } from './QaText';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useMemberContext } from '@/context/MemberContext';
import { useProjectContext } from '@/context/ProjectContext';
import { useTaskContext } from '@/context/TaskContext';
import { useUIContext } from '@/context/UIContext';
import { canQaComment, canQaCommand, canQaDelete, isHistoricalQaPass, isQaTerminal, qaIdSearch, requiredTargetsPassed } from '@/lib/qa/domain';
import type { QaActor, QaCommand, QaDetail, QaResolution, QaSeverity } from '@/lib/qa/domain';
import type { QaClient } from '@/lib/qa/client';
import type { QaWorkflow } from '@/lib/qa/workflow';
import type { QaActionDefaults } from '@/lib/qa/boardInteraction';
import { qaId } from '@/lib/qa/client';
import { QaField, QaSection, QaSelect, qaButton, qaPrimary } from './QaFields';
import QaReportForm from './QaReportForm';
import QaAttachments from './QaAttachments';
import QaLegacyAttachments from './QaLegacyAttachments';
import QaHandoffPanel from './QaHandoffPanel';
import { useIsMobile } from '@/hooks/use-mobile';
import { useQaVersions } from '@/hooks/useQaVersions';
import { ColoredStatusSelect } from '@/components/ui/colored-status-select';
import { DEFAULT_QA_WORKFLOW } from '@/lib/qa/workflow';
import { useQaFieldConfiguration } from '@/hooks/useQaFieldConfiguration';
import { QaCustomFieldDisplay } from './QaCustomFieldInputs';
import { qaErrorText } from './qaErrorText';
import { qaShortId } from '@/lib/qa/shortId';
import { qaEventText, qaEventTitle } from './qaEventText';
import { useConfirmDialog } from '@/components/ConfirmDialog';
import { toast } from 'sonner';

type ActionType = QaCommand['type'];
const actionLabels: Record<ActionType, string> = { update_fields: 'properties', edit: 'edit', triage: 'triage', start_fix: 'startFix', submit_fix: 'submitFix', record_deployment: 'deployment', record_verification: 'verification', set_state: 'changeState', close: 'close', reopen: 'reopen', hold: 'hold', link_tasks: 'taskLinks', request_handoff: 'actions', accept_handoff: 'actions', resolve_handoff: 'actions' };
const displayDate = (value: string) => new Date(value).toLocaleString();
export function QaFailure({ error }: { error: unknown }) {
  const { t } = useTranslation();
  const { message, code } = qaErrorText(t, error);
  return <div role="alert" className="rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive"><p>{message}</p>{code && <p className="mt-1 font-mono text-xs">{t('qa.errorCode', { code })}</p>}</div>
}

export default function QaIssueDetail({ detail, client, actor: baseActor, workflow, initialAction, initialDefaults, onRefresh, onBack, onDeleted, onBusyChange }: { detail: QaDetail; client: QaClient; actor: QaActor; workflow?: QaWorkflow; initialAction?: ActionType; initialDefaults?: QaActionDefaults; onRefresh: () => Promise<void>; onBack: () => void; onDeleted?: () => void; onBusyChange?: (busy: boolean) => void }) {
  const { t } = useTranslation();
  const environments = useDeploymentEnvironments();
  const isMobile = useIsMobile();
  const getProjectColor = useProjectColor();
  const { users } = useMemberContext();
  const { allProjects, productLines } = useProjectContext();
  const { allTasks } = useTaskContext();
  const { setSelectedTask } = useUIContext();
  const { confirm, ConfirmDialog } = useConfirmDialog();
  const [acknowledgedIssue, setAcknowledgedIssue] = useState<QaDetail['issue'] | null>(null);
  const issue = acknowledgedIssue && acknowledgedIssue.version > detail.issue.version ? acknowledgedIssue : detail.issue;
  const actor = detail.coordination?.coordinatorId === baseActor.id ? { ...baseActor, qaCoordinatorProjectIds: [...new Set([...(baseActor.qaCoordinatorProjectIds || []), detail.issue.projectId])] } : baseActor;
  const fields = useQaFieldConfiguration(client);
  const [action, setAction] = useState<ActionType | null>(() => initialAction && !['update_fields', 'start_fix', 'record_verification', 'record_deployment', 'request_handoff', 'accept_handoff', 'resolve_handoff'].includes(initialAction) && canQaCommand(issue, actor, initialAction) ? initialAction : null);
  const [commandBusy, setBusy] = useState(false);
  const [attachmentBusy, setAttachmentBusy] = useState(false);
  const [unknownCommand, setUnknownCommand] = useState(false);
  const busy = commandBusy || attachmentBusy || unknownCommand;
  useEffect(() => { onBusyChange?.(busy); return () => onBusyChange?.(false); }, [busy, onBusyChange]);
  useQaNavigationGuard(busy);
  const [error, setError] = useState<unknown>(null);
  const [notice, setNotice] = useState('');
  const [tab, setTab] = useState<'details' | 'verification' | 'comments' | 'history'>(initialAction === 'record_verification' || initialAction === 'record_deployment' ? 'verification' : 'details');
  const [comment, setComment] = useState('');
  const canResolveFixed = isHistoricalQaPass(issue) || (['verified', 'verification'].includes(issue.state) && requiredTargetsPassed(issue));
  const [resolution, setResolution] = useState<QaResolution | ''>(() => initialDefaults?.resolution === 'wont_fix' ? 'wont_fix' : canResolveFixed ? 'fixed' : '');
  const sidebarRef = useRef<HTMLDivElement>(null);
  const [handoffOpen, setHandoffOpen] = useState(false);
  const [taskSearch, setTaskSearch] = useState('');
  const [links, setLinks] = useState(issue.taskIds);
  const projectTasks = allTasks.filter(task => task.projectId === issue.projectId);
  const unavailableLinks = links.filter(id => !projectTasks.some(task => task.id === id));
  const [targets, setTargets] = useState<QaTargetDraft[]>(() => issue.targets.length ? issue.targets.map(target => ({ environment: target.environment, component: target.component, build: target.build, required: target.required })) : [{ environment: issue.observedEnvironment, component: '', build: '', required: true }]);
  const versions = useQaVersions(client, action === 'submit_fix' ? issue.projectId : '');
  const pendingCommand = useRef<{ signature: string; id: string; command: QaCommand; issue: QaDetail['issue'] }>();
  const commandSending = useRef(false);
  const pendingComment = useRef<{ body: string; id: string }>();
  // Comments have their own tab; the cloud also logs them as events.
  const visibleEvents = detail.events.filter(event => event.type !== 'legacy_import' && event.type !== 'comment');
  const source = (issue as unknown as { legacySource?: { recordUrl?: string } }).legacySource;
  const sourceUrl = source?.recordUrl && /^https:\/\/[^/]+\.slack\.com\//i.test(source.recordUrl) ? source.recordUrl : null;
  const nextAction = getQaNextAction(issue, actor);
  const can = (type: ActionType) => canQaCommand(issue, actor, type);
  const member = (id: string | null) => users.find(user => user.id === id)?.name || id || '—';
  const memberNames = new Map(users.map(user => [user.id, user.name]));
  const eventText = { t, member: (id: string) => memberNames.get(id) ?? id, date: displayDate,
    task: (id: string) => { const task = allTasks.find(row => row.id === id); return task ? `${task.taskKey} · ${task.title}` : id; },
    project: (id: string) => allProjects.find(project => project.id === id)?.name || id,
    stateLabel: (state: string) => workflow?.labels[state as keyof QaWorkflow['labels']] || t(`qa.state.${state}`) };
  const primaryAction = nextAction && can(nextAction.command) ? nextAction : null;
  const moreActions = (['edit', 'triage', 'start_fix', 'submit_fix', 'close', 'reopen', 'hold', 'link_tasks'] as ActionType[])
    .filter(type => can(type) && type !== primaryAction?.command && !(type === 'start_fix' && issue.state === 'in_progress'));
  const nextOwner = nextAction && ['start_fix', 'submit_fix'].includes(nextAction.command) ? issue.assigneeId : issue.qaOwnerId;
  const canDelete = canQaDelete(issue, actor);
  const canOpenHandoff = !!issue.handoff || ['request_handoff', 'accept_handoff', 'resolve_handoff'].some(type => can(type as ActionType));
  // Permanent, so one confirmation that says so. A bug already gone counts as deleted.
  const removeIssue = async () => {
    if (busy || !canDelete) return;
    if (!(await confirm({ title: t('qa.deleteTitle'), description: t('qa.deleteConfirm', { title: issue.title }), destructive: true }))) return;
    setBusy(true); setError(null);
    try {
      try { await client.delete(issue); }
      catch (failure) { if ((failure as { status?: number })?.status !== 404) throw failure; }
      toast.success(t('qa.deleted', { id: qaShortId(issue.id) }));
      (onDeleted ?? onBack)();
    } catch (failure) { setError(failure); toast.error(t('qa.deleteFailed')); }
    finally { setBusy(false); }
  };
  const focusOwners = () => {
    sidebarRef.current?.scrollIntoView?.({ behavior: 'smooth', block: 'nearest' });
    const label = t(!issue.assigneeId ? 'qa.assignee' : 'qa.qaOwner');
    const control = Array.from(sidebarRef.current?.querySelectorAll<HTMLButtonElement>('button[role="combobox"]') || []).find(button => button.getAttribute('aria-label') === label);
    control?.focus();
  };
  useEffect(() => { if (initialAction === 'update_fields') focusOwners(); }, []); // Focus the owner fields when opened from a card.
  const openAction = (type: ActionType) => {
    if (busy || !can(type)) return;
    setError(null);
    if (type === 'update_fields') focusOwners();
    else if (type === 'record_deployment' || type === 'record_verification') setTab('verification');
    else if (type === 'start_fix') void send({ type: 'start_fix' });
    else {
      // The close form starts from what the current evidence allows.
      if (type === 'close') setResolution(canResolveFixed ? 'fixed' : '');
      setAction(type);
    }
  };
  const send = async (command: QaCommand, expectedVersion = issue.version, retry = false): Promise<boolean> => {
    if (commandBusy || attachmentBusy || commandSending.current || (unknownCommand && !retry)) return false;
    commandSending.current = true;
    setBusy(true); setError(null); setNotice('');
    const signature = JSON.stringify({ version: expectedVersion, command });
    if (!retry && pendingCommand.current?.signature !== signature) pendingCommand.current = { signature, id: qaId(), command, issue: { ...issue, version: expectedVersion } };
    const pending = pendingCommand.current;
    if (!pending) { commandSending.current = false; setBusy(false); return false; }
    let saved = false;
    try {
      const updated = await client.command(pending.issue, pending.command, pending.id);
      saved = true; setAcknowledgedIssue(updated); pendingCommand.current = undefined; setUnknownCommand(false); setAction(null);
      if (pending.command.type === 'set_state') toast.success(t('qa.stateChanged'));
      await onRefresh();
    } catch (failure) {
      if (saved) setNotice(t('qaHandoff.savedRefreshFailed'));
      else {
        const status = (failure as { status?: number })?.status;
        const unknown = !status || status >= 500;
        setUnknownCommand(unknown);
        if (!unknown) pendingCommand.current = undefined;
        setError(failure); toast.error(t(status === 409 ? 'qa.conflict' : 'qa.failed'));
      }
    } finally { commandSending.current = false; setBusy(false); }
    return saved;
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
    if (action === 'close' && resolution) {
      const close = { type: action, resolution, reason: text('reason'), ...(isHistoricalQaPass(issue) && resolution === 'fixed' ? { acknowledgeHistoricalPass: data.get('acknowledgeHistoricalPass') === 'on' } : {}) } as const;
      if (resolution === 'duplicate') { void findDuplicate(text('duplicateOfId')).then(duplicateOfId => { if (duplicateOfId) void send({ ...close, duplicateOfId }); }); return; }
      command = close;
    }
    if (action === 'reopen' || action === 'hold') command = { type: action, reason: text('reason') };
    if (action === 'link_tasks' && unavailableLinks.length === 0) command = { type: action, taskIds: links };
    if (command) void send(command);
  };
  // The card's 「開始修復」 starts the repair in one click, the same as the button here.
  const startedFromCard = useRef(false);
  useEffect(() => {
    if (initialAction !== 'start_fix' || startedFromCard.current) return;
    startedFromCard.current = true;
    if (can('start_fix') && issue.state !== 'in_progress') void send({ type: 'start_fix' });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  // The original bug can be given by the short id shown on cards (#1a2b3c4d) or its full id.
  const findDuplicate = async (value: string): Promise<string | null> => {
    const term = qaIdSearch(value) ?? qaIdSearch(`#${value}`);
    const unavailable = (): null => { setError({ code: 'qa_duplicate_unavailable', status: 400 }); return null; };
    if (!term) return unavailable();
    setBusy(true); setError(null);
    try {
      const found = await client.list({ projectId: issue.projectId, search: `#${term}`, limit: 2 });
      const matches = found.issues.filter(row => row.id !== issue.id);
      return matches.length === 1 ? matches[0].id : unavailable();
    } catch (failure) { setError(failure); return null; }
    finally { setBusy(false); }
  };
  // Clearing a hold needs no reason; the history records who cleared it.
  const clearHold = (): void => void send({ type: 'hold', reason: '' });
  // Done and Won't fix by status only skip the recorded verification and reason, so ask first.
  const changeState = async (state: QaDetail['issue']['state']) => {
    if (state === issue.state) return;
    if (isQaTerminal(state) && !(await confirm({ title: t('qa.terminalConfirmTitle', { status: workflow?.labels[state] || t(`qa.state.${state}`) }), description: t('qa.terminalConfirmDesc') }))) return;
    void send({ type: 'set_state', state });
  };
  const postComment = async (event: React.FormEvent) => {
    event.preventDefault(); if (commandBusy || attachmentBusy || (unknownCommand && !pendingComment.current) || !comment.trim()) return;
    setBusy(true); setError(null);
    if (pendingComment.current?.body !== comment) pendingComment.current = { body: comment, id: qaId() };
    try { await client.comment(issue.id, comment, pendingComment.current.id); pendingComment.current = undefined; setUnknownCommand(false); setComment(''); await onRefresh(); }
    catch (failure) { const status = (failure as { status?: number })?.status; if (pendingComment.current) { const unknown = !status || status >= 500; setUnknownCommand(unknown); if (!unknown) pendingComment.current = undefined; } setError(failure); toast.error(t('qa.failed')); }
    finally { setBusy(false); }
  };
  const commandRetryNotice = unknownCommand ? <div role="alert" className="flex flex-wrap items-center gap-3 rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 text-sm"><span>{t('qa.commandRetryHint')}</span><button type="button" className={qaPrimary} disabled={commandBusy || attachmentBusy} onClick={() => { if (pendingCommand.current) void send(pendingCommand.current.command, pendingCommand.current.issue.version, true); else if (pendingComment.current) void postComment({ preventDefault() {} } as React.FormEvent); }}>{t('qa.retryCommand')}</button></div> : null;
  const stateControl = <div className="mb-4"><ColoredStatusSelect label={t('qa.changeState')} value={issue.state} disabled={busy || !can('set_state')}
            options={(workflow || DEFAULT_QA_WORKFLOW).order.map(state => ({ value: state, label: workflow?.labels[state] || t(`qa.state.${state}`), color: qaStateColors[state] }))}
            onValueChange={state => void changeState(state)} /></div>;
  const actionSection = <QaSection title={t('qa.actions')}>
          {!isQaTerminal(issue.state) && (!issue.assigneeId || !issue.qaOwnerId) && <p className="mb-3 text-sm text-muted-foreground">{t('qa.assignOwnersHint')}</p>}
          {isMobile && stateControl}
          {primaryAction ? <div className="space-y-2"><p className="text-sm text-muted-foreground">{t('qa.yourNextStep')}</p>{tab === 'verification' && ['record_deployment', 'record_verification'].includes(primaryAction.command) ? <p className="text-sm leading-relaxed">{t('qa.completeInPanel')}</p> : <button type="button" className={`${qaPrimary} w-full`} disabled={busy} onClick={() => openAction(primaryAction.command)}>{t(`qa.${primaryAction.label}`)}</button>}</div> : nextAction && <p className="text-sm leading-relaxed text-muted-foreground">{t('qa.waitingForAction', { name: nextOwner ? member(nextOwner) : t('qa.triageTeam'), action: t(`qa.${nextAction.label}`) })}</p>}
          {(moreActions.length > 0 || canDelete || canOpenHandoff) && <DropdownMenu><DropdownMenuTrigger asChild><button type="button" className={`${qaButton} mt-3 w-full`} disabled={busy}><MoreHorizontal size={15} aria-hidden="true" />{t('qa.moreActions')}</button></DropdownMenuTrigger><DropdownMenuContent align="end" className="min-w-48">{moreActions.map(type => <DropdownMenuItem key={type} onSelect={() => openAction(type)}>{t(`qa.${actionLabels[type]}`)}</DropdownMenuItem>)}{canOpenHandoff && <DropdownMenuItem onSelect={() => setHandoffOpen(true)}>{t('qaHandoff.title')}</DropdownMenuItem>}{canDelete && <>{moreActions.length > 0 && <div role="separator" className="my-1 h-px bg-border" />}<DropdownMenuItem className="text-destructive focus:text-destructive" onSelect={() => void removeIssue()}><Trash2 size={15} aria-hidden="true" />{t('qa.delete')}</DropdownMenuItem></>}</DropdownMenuContent></DropdownMenu>}
          {!canDelete && !Object.keys(actionLabels).some(type => can(type as ActionType)) && <p className="text-sm text-muted-foreground">{t('qa.noPermission')}</p>}
        </QaSection>;
  return <div className="w-full min-w-0 space-y-4 p-3 md:p-5">
    <div className="flex flex-wrap items-center justify-between gap-2"><button className={qaButton} onClick={onBack} disabled={busy}><ArrowLeft size={15} aria-hidden="true" />{t('qa.back')}</button><button className={qaButton} onClick={() => void refresh()} disabled={busy}><RefreshCw size={15} aria-hidden="true" />{t('qa.refresh')}</button></div>
    <header className="rounded-xl border border-border/80 bg-card p-4 shadow-sm md:p-5">
      <div className="mb-3 flex flex-wrap items-center gap-2"><Bug size={15} className="text-muted-foreground" aria-hidden="true" /><ProjectBadge name={allProjects.find(p => p.id === issue.projectId)?.name} color={getProjectColor(issue.projectId)} /><span title={issue.id} className="font-mono text-xs text-muted-foreground">{qaShortId(issue.id)}</span>{sourceUrl && <a href={sourceUrl} target="_blank" rel="noopener noreferrer" className="ml-auto inline-flex items-center gap-1 text-xs text-primary hover:underline">{t('qa.slackSource')}<ExternalLink size={12} aria-hidden="true" /></a>}</div>
      <h1 className="break-words text-xl font-bold leading-relaxed md:text-2xl">{issue.title}</h1>
      <div className="mt-3 flex flex-wrap items-center gap-3"><QaStateBadge state={issue.state} label={workflow?.labels[issue.state]} /><QaPriorityBadge priority={issue.priority} issue={issue} /><QaSeverityBadge severity={issue.severity} /><span className="text-xs text-muted-foreground">{t('qa.cycle', { count: issue.fixCycle })}</span></div>
    </header>
    {error !== null && !action && !handoffOpen && <QaFailure error={error} />}
    {!handoffOpen && !action && commandRetryNotice}
    {notice && !handoffOpen && !action && <p role="status" className="text-sm text-muted-foreground">{notice}</p>}
    {busy && <p role="status" className="text-sm">{t('qa.saving')}</p>}
    {isMobile && actionSection}
    <div className="grid items-start gap-4 lg:grid-cols-[minmax(0,1fr)_300px] xl:grid-cols-[minmax(0,1fr)_340px]">
      <div className="min-w-0 space-y-4">
        <div role="tablist" aria-label={t('qa.details')} className="grid grid-cols-4 gap-1 rounded-xl border border-border/80 bg-card p-1.5 sm:flex">{([{ id: 'details', label: 'details', Icon: FileText, count: undefined }, { id: 'verification', label: 'verificationTab', Icon: ClipboardCheck, count: issue.targets.length }, { id: 'comments', label: 'comments', Icon: MessageSquare, count: detail.comments.length }, { id: 'history', label: 'history', Icon: History, count: visibleEvents.length }] as const).map(({ id, label, Icon, count }) => <button key={id} role="tab" disabled={busy} tabIndex={tab === id ? 0 : -1} onKeyDown={event => {
          if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
          event.preventDefault();
          const tabs = ['details', 'verification', 'comments', 'history'] as const;
          const index = tabs.indexOf(tab);
          const next = event.key === 'Home' ? 0 : event.key === 'End' ? 3 : (index + (event.key === 'ArrowRight' ? 1 : 3)) % 4;
          setTab(tabs[next]); document.getElementById(`qa-tab-${tabs[next]}`)?.focus();
        }} aria-selected={tab === id} aria-controls={`qa-panel-${id}`} id={`qa-tab-${id}`} className={`flex min-w-0 shrink-0 flex-col items-center justify-center gap-0.5 rounded-lg px-1 py-1.5 text-center text-xs outline-none focus-visible:ring-2 focus-visible:ring-primary sm:inline-flex sm:flex-row sm:gap-1.5 sm:px-3 sm:py-2 sm:text-sm ${tab === id ? 'bg-primary/10 font-medium text-primary' : 'text-muted-foreground hover:bg-accent'}`} onClick={() => setTab(id)}><Icon size={15} aria-hidden="true" />{t(`qa.${label}`)}{count !== undefined && <span className="rounded bg-muted px-1.5 text-xs">{count}</span>}</button>)}</div>
        <div role="tabpanel" id={`qa-panel-${tab}`} aria-labelledby={`qa-tab-${tab}`} className="space-y-4">

        {tab === 'details' && <>
        <QaSection title={t('qa.details')}>
          <section className="min-w-0"><h3 className="mb-2 text-sm font-semibold text-muted-foreground">{t('qa.actual')}</h3><div className="whitespace-pre-wrap break-words text-base leading-7"><QaText text={issue.actual || t('qa.notProvided')} /></div></section>
          {issue.expected && <section className="mt-5 border-t border-border/60 pt-4"><h3 className="mb-2 text-sm font-semibold">{t('qa.expected')}</h3><div className="whitespace-pre-wrap break-words text-sm leading-relaxed"><QaText text={issue.expected} /></div></section>}
          {issue.steps && <section className="mt-5 border-t border-border/60 pt-4"><h3 className="mb-2 text-sm font-semibold">{t('qa.steps')}</h3><div className="whitespace-pre-wrap break-words text-sm leading-relaxed"><QaText text={issue.steps} /></div></section>}
          {issue.holdReason && !isQaTerminal(issue.state) && <div className="mt-4 rounded border border-amber-500/30 bg-amber-500/5 p-3 text-sm"><p className="font-medium">{t('qa.holdCurrent')}</p><p className="mt-1 whitespace-pre-wrap break-words"><QaText text={issue.holdReason} /></p>{can('hold') && <button type="button" className={`${qaButton} mt-2`} disabled={busy} onClick={clearHold}>{t('qa.clearHold')}</button>}</div>}
          {issue.reopenReason && !isQaTerminal(issue.state) && <div className="mt-4 rounded border border-border bg-muted/40 p-3 text-sm"><p className="font-medium">{t('qa.reopenReason')}</p><p className="mt-1 whitespace-pre-wrap break-words"><QaText text={issue.reopenReason} /></p></div>}
          {issue.resolution && <p className="mt-4 whitespace-pre-wrap rounded bg-muted p-3 text-sm">{t(`qa.resolution.${issue.resolution}`)} · {issue.resolutionReason}{issue.duplicateOfId && <> · <a className="underline" href={`?qa=${encodeURIComponent(issue.duplicateOfId)}`}>{issue.duplicateOfId}</a></>}</p>}
        </QaSection>
        <QaSection title={t('qa.attachments')}><QaLegacyAttachments issue={issue} /><QaAttachments compact issueId={issue.id} attachments={detail.attachments} client={client} onChanged={onRefresh} onError={setError} onBusyChange={setAttachmentBusy} /></QaSection>
        </>}
        {tab === 'verification' && <>
        <QaSection title={t('qa.targets')}>
          {issue.fixSummary && <p className="mb-3 whitespace-pre-wrap break-words text-sm">{issue.fixSummary}</p>}
          {!issue.targets.length && <p className="text-sm text-muted-foreground">{t('qa.noTargets')}</p>}
          <QaVerificationPanel key={issue.fixCycle} targets={issue.targets} initialResult={initialDefaults?.result} canDeploy={can('record_deployment')} canVerify={can('record_verification')} busy={busy} onCommand={command => send(command).then(() => {})} />
        </QaSection>
        <QaSection title={t('qa.runs')}>
          {!issue.runs.length && <p className="text-sm text-muted-foreground">{t('qa.noRuns')}</p>}
          <ol className="space-y-3">{[...issue.runs].reverse().map(run => <li key={run.id} className="rounded border border-border p-3 text-sm"><div className="flex flex-wrap justify-between gap-2"><strong>{t(`qa.result.${run.result}`)} · {[run.environment, run.component, run.build].filter(Boolean).join(' / ')}</strong><span className="text-xs text-muted-foreground">{t('qa.cycle', { count: run.fixCycle })} · {member(run.testerId)} · {displayDate(run.createdAt)}</span></div><p className="mt-1 whitespace-pre-wrap break-words">{run.note}</p></li>)}</ol>
        </QaSection>
        </>}
        {tab === 'comments' && <>
        <QaSection title={t('qa.comments')}>
          {!detail.comments.length && <p className="mb-3 text-sm text-muted-foreground">{t('qa.noComments')}</p>}
          <ol className="mb-4 space-y-3">{detail.comments.map(row => <li key={row.id} className="border-b border-border pb-3 text-sm"><div className="mb-1 flex flex-wrap justify-between gap-2"><strong>{member(row.actorId)}</strong><span className="text-xs text-muted-foreground">{displayDate(row.createdAt)}</span></div><p className="whitespace-pre-wrap break-words"><QaText text={row.body} /></p></li>)}</ol>
          {canQaComment(issue, actor) && <form className="space-y-2" onSubmit={postComment}><QaField label={t('qa.commentBody')} multiline required maxLength={10000} value={comment} onChange={event => setComment(event.target.value)} disabled={busy} /><button className={qaPrimary} disabled={busy || !comment.trim()}>{t('qa.addComment')}</button></form>}
        </QaSection>
        </>}
        {tab === 'history' && <>
        <QaSection title={t('qa.history')}><>{!visibleEvents.length && <p className="text-sm text-muted-foreground">{t('qa.noHistory')}</p>}<ol className="space-y-3">{[...visibleEvents].reverse().map(event => { const text = qaEventText(event, eventText); return <li key={event.id} className="text-sm"><p className="font-medium">{qaEventTitle(event, t)} · {member(event.actorId)}</p><p className="text-xs text-muted-foreground">{displayDate(event.createdAt)}</p>{text && <p className="mt-1 whitespace-pre-wrap break-words text-muted-foreground"><QaText text={text} /></p>}</li>; })}</ol></></QaSection>
        </>}
      </div>
      </div>
      <div ref={sidebarRef} className="min-w-0 space-y-4">
        {!isMobile && actionSection}
        <QaSection title={t('qa.properties')}>
          {!isMobile && stateControl}
          <QaIssueSidebarFields issue={issue} disabled={busy || !can('update_fields')} onCommand={send} />
          <dl className="mt-4 grid gap-4 sm:grid-cols-2">{[['environment', issue.observedEnvironment], ['observedVersion', issue.observedVersion], ['problemArea', issue.component], ['reporter', member(issue.reporterId)]].map(([key, value]) => <div key={key}><dt className="text-xs text-muted-foreground">{t(`qa.${key}`)}</dt><dd className="mt-1 break-words text-sm">{value || '—'}</dd></div>)}</dl>
        </QaSection>
        {fields.configuration && (fields.configuration.fields.length > 0) && <QaSection title={t('qa.customFields.title')}><QaCustomFieldDisplay fields={fields.configuration.fields} values={issue.customFields || {}} /></QaSection>}
        {fields.error !== null && <div role="alert" className="text-sm text-destructive">{t('qa.failed')} <button type="button" className={qaButton} onClick={fields.retry}>{t('qa.refresh')}</button></div>}
        <RelatedKnowledge targetKind="qa" targetId={issue.id} />
        <QaSection title={t('qa.taskLinks')}><p className="mb-2 text-xs text-muted-foreground">{t('qa.taskLinksHint')}</p>{!issue.taskIds.length && <p className="text-sm text-muted-foreground">{t('qa.noTasks')}</p>}<ul className="space-y-2">{issue.taskIds.map(id => { const task = allTasks.find(row => row.id === id); return <li key={id}><button className="text-left text-sm text-primary underline disabled:text-muted-foreground" disabled={busy || !task} onClick={() => task && setSelectedTask(task)}>{task ? `${task.taskKey} · ${task.title}` : id}</button></li>; })}</ul></QaSection>

      </div>
    </div>
    <Dialog open={!!action} onOpenChange={open => { if (!open && !busy) setAction(null); }}>
      <DialogContent aria-describedby={undefined} className="flex max-h-[calc(100dvh-24px)] w-[calc(100%-24px)] max-w-4xl flex-col overflow-hidden p-4 sm:p-6" onPointerDownOutside={event => event.preventDefault()} onEscapeKeyDown={event => { if (busy) event.preventDefault(); }}>
        <DialogHeader><DialogTitle>{action ? t(`qa.${actionLabels[action]}`) : ''}</DialogTitle></DialogHeader>
        {error !== null && <div className="space-y-2"><QaFailure error={error} /><button className={qaButton} disabled={busy} onClick={() => void refresh()}>{t('qa.refresh')}</button></div>}
        {commandRetryNotice}
        {notice && <div className="space-y-2"><p role="status" className="text-sm text-muted-foreground">{notice}</p><button type="button" className={qaButton} disabled={busy} onClick={() => void refresh()}>{t('qa.refresh')}</button></div>}
          {action === 'edit' && can('edit') && <div className="mt-4 flex min-h-0 flex-1 overflow-hidden"><QaReportForm fixedFooter initial={issue} projects={allProjects} productLines={productLines} client={client} busy={busy} onCancel={() => setAction(null)} onSubmit={input => void send({ type: 'edit', title: input.title, actual: input.actual, expected: input.expected || '', steps: input.steps || '', observedEnvironment: input.observedEnvironment, observedVersion: input.observedVersion || '', component: input.component || '', customFields: input.customFields })} /></div>}
          {action && action !== 'edit' && can(action) && <form key={action} className="mt-4 min-h-0 space-y-3 overflow-y-auto overscroll-contain" onSubmit={submitAction}><fieldset disabled={busy} className="space-y-3">
            {action === 'triage' && <>
              <UserSelect label={t('qa.assignee')} name="assigneeId" required activeOnly disabled={busy} preferredUserIds={getProjectDeveloperPreferenceIds(users, allTasks, issue.projectId, issue.assigneeId)} defaultValue={issue.assigneeId || ''} emptyLabel={t('qa.choose')} size="md" />
              <UserSelect label={t('qa.qaOwner')} name="qaOwnerId" required activeOnly disabled={busy} preferredUserIds={getDepartmentPreferenceIds(users, ['QA'])} defaultValue={issue.qaOwnerId || ''} emptyLabel={t('qa.choose')} size="md" />
              <QaSelect label={t('qa.severity')} name="severity" required defaultValue={issue.severity === 'untriaged' ? '' : issue.severity}><option value="">{t('qa.choose')}</option>{['low', 'medium', 'high'].map(s => <option value={s} key={s}>{t(`qa.severityNames.${s}`)}</option>)}</QaSelect>
              <section className="rounded-lg border border-border p-3"><h3 className="text-sm font-medium">{t('qa.additionalDetails')}</h3><div className="mt-3 space-y-3"><QaSelect label={t('qa.priority')} name="priority" required defaultValue={issue.priority}>{qaPriorities.map((value, index) => <option key={value} value={index + 1}>{t(`priority.${value}`)}</option>)}</QaSelect><QaField label={t('qa.dueDate')} name="dueDate" type="date" defaultValue={issue.dueDate || ''} /></div></section>
            </>}
            {action === 'submit_fix' && <><QaField label={t('qa.fixSummary')} name="summary" multiline maxLength={8000} />
              <QaTargetEditor targets={targets} onChange={setTargets} versions={versions} disabled={busy} />
            </>}
            {action === 'close' && <><QaSelect label={t('qa.resolutionField')} required value={resolution} onChange={event => setResolution(event.target.value as QaResolution | '')}><option value="">{t('qa.choose')}</option>{['fixed', 'duplicate', 'not_bug', 'wont_fix', 'cannot_reproduce'].map(value => <option key={value} value={value} disabled={value === 'fixed' && !canResolveFixed}>{t(`qa.resolution.${value}`)}</option>)}</QaSelect>{!canResolveFixed && <p className="text-xs text-muted-foreground">{t('qa.fixedNeedsVerification')}</p>}{resolution === 'duplicate' && <QaField label={t('qa.duplicateId')} name="duplicateOfId" required placeholder="#1a2b3c4d" maxLength={130} />}</>}
            {action === 'close' && resolution === 'fixed' && isHistoricalQaPass(issue) && <label className="flex items-start gap-2 rounded-lg border border-border bg-muted/30 p-3 text-sm"><input type="checkbox" name="acknowledgeHistoricalPass" required className="mt-1" /><span>{t('qa.acknowledgeHistoricalPass')}</span></label>}
            {(action === 'close' || action === 'reopen' || action === 'hold') && <QaField label={action === 'close' && resolution === 'fixed' && !isHistoricalQaPass(issue) ? t('qa.reasonOptional') : t('qa.reason')} name="reason" multiline required={!(action === 'close' && resolution === 'fixed' && !isHistoricalQaPass(issue))} maxLength={8000} />}
            {action === 'hold' && issue.holdReason && <p className="text-xs text-muted-foreground">{t('qa.holdReplaceHint')}</p>}
            {action === 'link_tasks' && <><p className="text-sm text-muted-foreground">{t('qa.taskLinksHint')}</p><QaField label={t('qa.taskSearch')} value={taskSearch} onChange={event => setTaskSearch(event.target.value)} />
              {unavailableLinks.length > 0 && <div className="space-y-2 rounded-lg border border-amber-500/30 p-3"><p className="text-sm text-muted-foreground">{t('qa.linkedTaskUnavailable')}</p>{unavailableLinks.map(id => { const task = allTasks.find(row => row.id === id); return <label key={id} className="flex items-start gap-2 text-sm"><input className="mt-1" type="checkbox" checked onChange={() => setLinks(previous => previous.filter(link => link !== id))} /><span>{task ? `${task.taskKey} · ${task.title}` : id}</span></label>; })}</div>}
              <div className="max-h-60 space-y-2 overflow-y-auto">{projectTasks.filter(task => `${task.taskKey} ${task.title}`.toLowerCase().includes(taskSearch.toLowerCase())).slice(0, 100).map(task => <label key={task.id} className="flex items-start gap-2 text-sm"><input className="mt-1" type="checkbox" checked={links.includes(task.id)} onChange={event => setLinks(previous => event.target.checked ? [...previous, task.id] : previous.filter(id => id !== task.id))} /><span>{task.taskKey} · {task.title}</span></label>)}</div></>}
            <p className="text-xs text-muted-foreground">{t('qa.unsent')}</p>
            <div className="sticky bottom-0 flex flex-wrap gap-2 border-t border-border bg-card py-3 pb-[max(12px,env(safe-area-inset-bottom))]"><button className={qaPrimary} type="submit" disabled={(action === 'submit_fix' && !environments.ready) || (action === 'link_tasks' && unavailableLinks.length > 0)}>{t('qa.save')}</button><button className={qaButton} type="button" onClick={() => setAction(null)}>{t('qa.cancel')}</button></div>
          </fieldset></form>}
      </DialogContent>
    </Dialog>
    <Dialog open={handoffOpen} onOpenChange={open => { if (!busy) setHandoffOpen(open); }}>
      <DialogContent aria-describedby={undefined} className="max-h-[90vh] overflow-y-auto" onPointerDownOutside={event => event.preventDefault()} onEscapeKeyDown={event => { if (busy) event.preventDefault(); }}>
        <DialogHeader><DialogTitle>{t('qaHandoff.title')}</DialogTitle></DialogHeader>
        {error !== null && <QaFailure error={error} />}
        {commandRetryNotice}
        {notice && <div className="space-y-2"><p role="status" className="text-sm text-muted-foreground">{notice}</p><button type="button" className={qaButton} disabled={busy} onClick={() => void refresh()}>{t('qa.refresh')}</button></div>}
        <QaHandoffPanel key={`${actor.id}:${issue.id}`} issue={issue} actor={actor} busy={busy} onCommand={send} />
      </DialogContent>
    </Dialog>
    {ConfirmDialog}
  </div>;
}
