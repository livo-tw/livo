import QaRecordView from './QaRecordView';
import { Bug, Settings2, LayoutGrid, List, Search, RefreshCw, MessageSquare } from 'lucide-react';
import QaCreatePanel from './QaCreatePanel';
import QaIssueCard from './QaIssueCard';
import BoardFilterChips from '@/components/board/BoardFilterChips';
import BoardSortMenu from '@/components/board/BoardSortMenu';
import MultiSelectDropdown from '@/components/MultiSelectDropdown';
import { useBoardFilters } from '@/hooks/useBoardFilters';
import { useProjectScope, useScopedProjectFilter } from '@/hooks/useProjectScope';
import { useIsMobile } from '@/hooks/use-mobile';
import { useMemberContext } from '@/context/MemberContext';
import { getDepartment, sortUsersByDept, type Department } from '@/lib/department';
import { qaBoardSort, readBoardSort, writeBoardSort, type BoardSort } from '@/lib/boardSort';
import type { Priority } from '@/types';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useUIContext } from '@/context/UIContext';
import { useProjectContext } from '@/context/ProjectContext';
import { useQa } from '@/hooks/useQa';
import { USING_MOCK_BACKEND } from '@/integrations/supabase/client';
import { QA_SEVERITIES, type QaCommand, type QaCoordination, type QaDetail, type QaListInput, type QaListResult, type QaSeverity, type QaState } from '@/lib/qa/domain';
import type { QaWorkflow } from '@/lib/qa/workflow';
import { qaId } from '@/lib/qa/client';
import { hasQaNavigationGuard } from '@/lib/qa/navigationGuard';
import { QaSelect, qaButton } from './QaFields';
import QaIssueDetail, { QaFailure } from './QaIssueDetail';
import type { QaActionDefaults } from '@/lib/qa/boardInteraction';
import QaKanban from './QaKanban';
import QaSettingsPage from './QaSettingsPage';
import { canManageQaConfiguration } from '@/lib/qa/fields';
import { qaPriorities, qaStateColors } from './QaBadges';
import { toast } from 'sonner';

export default function QaWorkspace({ mine = false }: { mine?: boolean }) {
  const { t } = useTranslation();
  const { featureToggles, featureTogglesReady } = useUIContext();
  // Unmount all data hooks and private media immediately when the capability is disabled.
  if (!featureTogglesReady || !featureToggles.qa) return <p className="p-6 text-sm text-muted-foreground">{t('qa.disabled')}</p>;
  return <QaWorkspaceContent key={mine ? 'mine' : 'all'} mine={mine} />;
}

function QaWorkspaceContent({ mine }: { mine: boolean }) {
  const { t } = useTranslation();
  const { client, actor: baseActor } = useQa();
  const { taskDisplayMode = 'modal', selectedTask } = useUIContext();
  const isMobile = useIsMobile();
  const { allProjects, productLines, selectedProjectId } = useProjectContext();
  const { users } = useMemberContext();
  const scope = useProjectScope();
  const [issueId, setIssueId] = useState(() => new URLSearchParams(window.location.search).get('qa') || '');
  const [creating, setCreating] = useState(false);
  const background = useRef<HTMLDivElement>(null);
  const [detail, setDetail] = useState<QaDetail | null>(null);
  const [list, setList] = useState<QaListResult>({ issues: [], total: 0, hasMore: false });
  const [loading, setLoading] = useState(false);
  // The open bug or report form, and the board's own drops and reloads, report work separately.
  const [recordBusy, setRecordBusy] = useState(false);
  const [boardBusy, setBoardBusy] = useState(false);
  const busy = recordBusy || boardBusy;
  const [error, setError] = useState<unknown>(null);
  const [searchDraft, setSearchDraft] = useState('');
  const [search, setSearch] = useState('');
  // Same filters and sort as the task board; the QA server applies them per column.
  const boardFilters = useBoardFilters();
  useScopedProjectFilter(boardFilters.setFilterProjects);
  const [severities, setSeverities] = useState<string[]>([]);
  const [reporters, setReporters] = useState<string[]>([]);
  const [sort, setSortState] = useState<BoardSort>(() => readBoardSort('qa'));
  const setSort = useCallback((next: BoardSort) => { setSortState(next); setOffset(0); writeBoardSort('qa', next); }, []);
  // My QA starts with everything I fix, verify or reported; the project QA page shows everyone's bugs.
  const [owner, setOwner] = useState<QaListInput['mine'] | ''>(mine ? 'involved' : '');
  const [offset, setOffset] = useState(0);
  const [revision, setRevision] = useState(0);
  // Bumped when the detail or create view changed something, so the board behind it reloads.
  const [boardRevision, setBoardRevision] = useState(0);
  const [view, setView] = useState<'board' | 'list'>('board');
  const [workflow, setWorkflow] = useState<QaWorkflow | null>(null);
  const [workflowError, setWorkflowError] = useState<unknown>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [coordination, setCoordination] = useState<QaCoordination | null>(null);
  const [coordinationError, setCoordinationError] = useState(false);
  const [initialAction, setInitialAction] = useState<QaCommand['type'] | undefined>();
  const [initialDefaults, setInitialDefaults] = useState<QaActionDefaults | undefined>();
  // Projects whose QA I coordinate, so cards in any project offer the steps a coordinator can take.
  const [coordinated, setCoordinated] = useState<string[]>([]);
  const actor = useMemo(() => {
    const ids = new Set(coordinated);
    if (coordination?.projectId === selectedProjectId && coordination.coordinatorId === baseActor.id) ids.add(coordination.projectId);
    else if (coordination?.projectId === selectedProjectId) ids.delete(coordination.projectId);
    return ids.size ? { ...baseActor, qaCoordinatorProjectIds: [...ids] } : baseActor;
  }, [baseActor, coordinated, coordination, selectedProjectId]);
  // Same rule as QaRecordView: on a phone a bug opens full screen as a dialog.
  const recordMode = isMobile ? 'modal' : taskDisplayMode;
  // One floating record at a time: a task opened on top of a bug dialog or side panel
  // (a linked task, Ctrl+K, a notification) hides it until the task closes.
  const recordSuspended = !!selectedTask && (creating || recordMode !== 'page');
  const modalOpen = !recordSuspended && (creating || (!!issueId && recordMode === 'modal'));
  useEffect(() => { background.current?.toggleAttribute('inert', modalOpen); }, [modalOpen]);
  const canConfigure = canManageQaConfiguration(actor);
  const { filterDept, filterAssignees, filterStatuses, filterPriorities, filterReviewers, filterProjects } = boardFilters;
  const { filters, noMatch } = useMemo(() => {
    // Department narrows the fix assignee, as it narrows the assignee on the task board.
    let assigneeIds: string[] | undefined = filterAssignees.length ? filterAssignees : undefined;
    if (filterDept.length) {
      const departments = new Set<Department>(filterDept);
      const members = new Set(users.filter(user => departments.has(getDepartment(user) as Department)).map(user => user.id));
      assigneeIds = assigneeIds ? assigneeIds.filter(id => members.has(id)) : [...members];
    }
    // A sidebar product line limits the projects; a project chip narrows it further.
    let projectIds: string[] | undefined = filterProjects.length ? filterProjects : undefined;
    if (!selectedProjectId && scope.projectIds) projectIds = projectIds ? projectIds.filter(id => scope.projectIds!.has(id)) : [...scope.projectIds];
    const input: QaListInput = {
      projectId: selectedProjectId || undefined, mine: owner || undefined, search,
      ...(filterStatuses.length ? { states: filterStatuses as QaState[] } : {}),
      ...(assigneeIds?.length ? { assigneeIds } : {}),
      ...(filterReviewers.length ? { qaOwnerIds: filterReviewers } : {}),
      ...(reporters.length ? { reporterIds: reporters } : {}),
      ...(projectIds?.length ? { projectIds } : {}),
      ...(filterPriorities.length ? { priorities: filterPriorities.map(name => qaPriorities.indexOf(name as Priority) + 1) } : {}),
      ...(severities.length ? { severities: severities as QaSeverity[] } : {}),
      ...qaBoardSort(sort),
    };
    return { filters: input, noMatch: (assigneeIds !== undefined && !assigneeIds.length) || (projectIds !== undefined && !projectIds.length) };
  }, [selectedProjectId, scope.projectIds, owner, search, users, filterDept, filterAssignees, filterStatuses, filterPriorities, filterReviewers, filterProjects, reporters, severities, sort]);
  const filterKey = JSON.stringify(filters);
  useEffect(() => { setOffset(0); }, [filterKey]);
  const memberOptions = useMemo(() => sortUsersByDept(users.filter(user => user.isActive)).map(user => ({ id: user.id, label: user.name, avatar: user.avatar, avatarColor: user.color, subtitle: user.jobTitle })), [users]);
  const toggleIn = (setter: React.Dispatch<React.SetStateAction<string[]>>) => (id: string) => setter(previous => previous.includes(id) ? previous.filter(value => value !== id) : [...previous, id]);
  const clearAll = () => { boardFilters.clearFilters(); setSeverities([]); setReporters([]); setSearch(''); setSearchDraft(''); };
  const createIds = useRef({ id: qaId(), commandId: qaId() });
  const creatingBusy = useRef(false);
  const creatingRef = useRef(false); creatingRef.current = creating;
  const previousProject = useRef(selectedProjectId);
  const currentId = useRef(issueId); currentId.current = issueId;
  useEffect(() => {
    let current = true;
    setCoordination(null); setCoordinationError(false);
    if (selectedProjectId) void client.getCoordination(selectedProjectId).then(value => { if (current) setCoordination(value); }).catch(() => { if (current) setCoordinationError(true); });
    return () => { current = false; };
  }, [client, baseActor.id, selectedProjectId, revision]);
  useEffect(() => {
    const controller = new AbortController();
    // Only widens what the cards offer; the server checks every command again.
    // Keep the same list when nothing changed, so the board does not reload for it.
    const update = (next: string[]) => setCoordinated(previous => previous.length === next.length && previous.every((id, index) => id === next[index]) ? previous : next);
    void Promise.resolve().then(() => client.myCoordination(controller.signal)).then(value => { if (!controller.signal.aborted) update(Array.isArray(value?.projectIds) ? value.projectIds.filter(id => typeof id === 'string').sort() : []); })
      .catch(() => { if (!controller.signal.aborted) update([]); });
    return () => controller.abort();
  }, [client, baseActor.id, revision]);
  const openIssue = useCallback((id: string, action?: QaCommand['type'], defaults?: QaActionDefaults, completedCreate = false) => {
    if (!completedCreate && hasQaNavigationGuard()) { toast.info(t('qa.finishPending')); return; }
    const url = new URL(window.location.href);
    if (id) url.searchParams.set('qa', id); else url.searchParams.delete('qa');
    window.history.replaceState({}, '', url.toString()); setError(null); setIssueId(id); creatingRef.current = false; setCreating(false); setInitialAction(action); setInitialDefaults(defaults);
  }, [t]);
  useEffect(() => {
    if (creatingRef.current || hasQaNavigationGuard()) { previousProject.current = selectedProjectId; return; }
    if (previousProject.current !== selectedProjectId) { previousProject.current = selectedProjectId; setOffset(0); openIssue(''); }
  }, [selectedProjectId, openIssue]);
  useEffect(() => {
    const pop = () => { if (creatingRef.current || hasQaNavigationGuard()) return; setIssueId(new URLSearchParams(window.location.search).get('qa') || ''); setCreating(false); setInitialAction(undefined); setInitialDefaults(undefined); };
    const createFromToolbar = () => {
      if (creatingBusy.current || creatingRef.current || hasQaNavigationGuard()) return;
      const url = new URL(window.location.href); url.searchParams.delete('qa'); url.searchParams.delete('qaCreate'); window.history.replaceState({}, '', url.toString());
      createIds.current = { id: qaId(), commandId: qaId() }; setIssueId(''); setError(null); creatingRef.current = true; setCreating(true);
    };
    if (new URLSearchParams(window.location.search).has('qaCreate')) createFromToolbar();
    window.addEventListener('popstate', pop); window.addEventListener('livo:qa-navigation', pop);
    window.addEventListener('livo:qa-create', createFromToolbar);
    return () => { window.removeEventListener('popstate', pop); window.removeEventListener('livo:qa-navigation', pop); window.removeEventListener('livo:qa-create', createFromToolbar); };
  }, []);
  useEffect(() => {
    const controller = new AbortController(); setWorkflowError(null);
    void client.getWorkflow(controller.signal)
      .then(value => { if (!controller.signal.aborted) setWorkflow(value); })
      .catch(failure => { if (!controller.signal.aborted) setWorkflowError(failure); });
    return () => controller.abort();
  }, [client, actor.id, revision]);
  useEffect(() => {
    if (issueId || creating || view !== 'list') return;
    if (noMatch) { setList({ issues: [], total: 0, hasMore: false }); setLoading(false); return; }
    const controller = new AbortController(); setLoading(true); setError(null);
    void client.list({ ...filters, offset, limit: 25 }, controller.signal)
      .then(result => { if (!controller.signal.aborted) setList(result); })
      .catch(failure => { if (!controller.signal.aborted) setError(failure); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
    // filterKey stands for the filters object.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client, actor.id, filterKey, noMatch, offset, revision, boardRevision, issueId, creating, view]);
  useEffect(() => {
    if (!issueId) { setDetail(null); return; }
    const controller = new AbortController(); setDetail(null); setLoading(true); setError(null);
    void client.get(issueId, controller.signal).then(result => { if (!controller.signal.aborted) setDetail(result); })
      .catch(failure => { if (!controller.signal.aborted) setError(failure); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [client, issueId, revision]);
  const refreshDetail = useCallback(async () => {
    if (!issueId) return;
    setBoardRevision(value => value + 1);
    const value = await client.get(issueId);
    if (currentId.current === issueId) setDetail(value);
  }, [client, issueId]);
  // Closing a bug or the report form shows the board again with what was just saved.
  const recordOpen = !!issueId || creating;
  const wasRecordOpen = useRef(recordOpen);
  useEffect(() => {
    if (wasRecordOpen.current && !recordOpen) setBoardRevision(value => value + 1);
    wasRecordOpen.current = recordOpen;
  }, [recordOpen]);
  if (settingsOpen && canConfigure && workflow && !creating && !issueId) return <QaSettingsPage client={client} actor={actor} workflow={workflow} onWorkflowSaved={setWorkflow} onCoordinationSaved={() => setRevision(value => value + 1)} onClose={() => setSettingsOpen(false)} />;
  return <div className="min-w-0 flex-1 overflow-y-auto bg-board p-3 md:p-5">
    <div ref={background} aria-hidden={modalOpen || undefined} className="w-full min-w-0 space-y-4" hidden={!!issueId && !creating && recordMode === 'page'}>
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-3"><div className="rounded-xl border border-primary/15 bg-primary/10 p-2.5 text-primary"><Bug size={22} aria-hidden="true" /></div><div><h1 className="text-xl font-bold">{t(mine ? 'qa.myTitle' : 'qa.title')}</h1><p className="mt-0.5 text-xs text-muted-foreground">{t('qa.workspaceIntro')}</p>{USING_MOCK_BACKEND && <p className="mt-1 text-xs text-muted-foreground">{t('qa.demo')}</p>}</div></div>
        {/* Reporting a bug uses the top bar's create button (it reads 「+ 回報 Bug」 here), so there is one entry. */}
        {!creating && !issueId && canConfigure && <div className="flex flex-wrap gap-2"><button className={qaButton} disabled={busy || !workflow} onClick={() => setSettingsOpen(value => !value)}><Settings2 size={15} aria-hidden="true" />{t('qa.settingsTitle')}</button></div>}
        {issueId && <button disabled={recordBusy} className={qaButton} onClick={() => openIssue('')}>{t('qa.back')}</button>}
      </header>
      {error !== null && <><QaFailure error={error} />{!creating && <button className={qaButton} onClick={() => setRevision(value => value + 1)}>{t('qa.refresh')}</button>}</>}
      {workflowError !== null && <><QaFailure error={workflowError} /><button className={qaButton} onClick={() => setRevision(value => value + 1)}>{t('qa.refresh')}</button></>}
      {coordinationError && <p role="alert" className="text-sm text-destructive">{t('qaHandoff.loadFailed')}</p>}
      {!workflow ? !workflowError && <p role="status">{t('qa.loading')}</p> : <>
        <div className="rounded-xl border border-border/80 bg-card shadow-sm">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border/70 px-3 py-2.5">
          <div className="flex gap-1 rounded-lg bg-muted/70 p-1" role="group" aria-label={t('qa.viewMode')}>{([{ id: 'board', Icon: LayoutGrid }, { id: 'list', Icon: List }] as const).map(({ id, Icon }) => <button key={id} className={`inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium outline-none focus-visible:ring-2 focus-visible:ring-primary ${view === id ? 'bg-background text-primary shadow-sm' : 'text-muted-foreground hover:text-foreground'}`} aria-pressed={view === id} disabled={busy} onClick={() => setView(id)}><Icon size={15} aria-hidden="true" />{t(`qa.${id}`)}</button>)}</div>
          <details className="relative text-sm"><summary className="flex cursor-pointer list-none items-center gap-1.5 rounded-md px-2 py-1.5 text-muted-foreground hover:bg-accent"><MessageSquare size={15} aria-hidden="true" />{t('qa.slackTitle')}</summary><div className="absolute right-0 z-20 mt-2 w-[min(80vw,360px)] rounded-xl border border-border bg-popover p-4 text-sm text-popover-foreground shadow-lg">{t('qa.slackUsage')}</div></details>
        </div>
        <div className="space-y-3 p-3">
          <form className="flex flex-wrap items-center gap-2" role="search" onSubmit={event => { event.preventDefault(); if (busy) return; setSearch(searchDraft.trim()); setOffset(0); }}>
            <div className="relative min-w-[200px] flex-1 sm:max-w-sm"><Search size={15} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
              <input disabled={busy} aria-label={t('qa.search')} placeholder={t('qa.searchPlaceholder')} value={searchDraft} maxLength={100} onChange={event => setSearchDraft(event.target.value)} className="h-9 w-full rounded-md border border-input bg-background pl-8 pr-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-primary" /></div>
            <button disabled={busy} className={qaButton}>{t('qa.searchButton')}</button>
            {mine && <QaSelect disabled={busy} label={t('qa.myTitle')} value={owner} onChange={event => { setOwner(event.target.value as QaListInput['mine'] | ''); setOffset(0); }}>{['involved', 'assigned', 'testing', 'reported'].map(value => <option key={value} value={value}>{t(`qa.${value}`)}</option>)}</QaSelect>}
          </form>
          <BoardFilterChips users={users} allProjects={scope.projectIds ? allProjects.filter(project => scope.projectIds!.has(project.id)) : allProjects} showProjects={!selectedProjectId} filters={boardFilters}
            statusOptions={workflow.order.map(value => ({ id: value, label: workflow.labels[value] || t(`qa.state.${value}`), color: qaStateColors[value] }))}
            assigneeLabel={t('qa.assignee')} reviewerLabel={t('qa.qaOwner')}
            extra={<>
              <MultiSelectDropdown label={t('qa.severity')} options={QA_SEVERITIES.map(value => ({ id: value, label: t(`qa.severityNames.${value}`) }))} selected={severities} onToggle={toggleIn(setSeverities)} />
              <MultiSelectDropdown label={t('qa.reporter')} options={memberOptions} selected={reporters} onToggle={toggleIn(setReporters)} />
            </>}
            extraActive={severities.length > 0 || reporters.length > 0 || !!search} onClear={clearAll}
            trailing={<>
              <BoardSortMenu value={sort} onChange={setSort} defaultLabel={t('qa.sortDefault')} disabled={busy} />
              <button type="button" disabled={busy} className="flex items-center rounded-md border border-border p-1.5 text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-50" onClick={() => setRevision(value => value + 1)} title={t('qa.refresh')} aria-label={t('qa.refresh')}><RefreshCw size={14} aria-hidden="true" /></button>
            </>} />
        </div>
        </div>
        {noMatch ? <div className="py-12 text-center text-sm text-muted-foreground">{t('qa.empty')} <button type="button" className="text-primary hover:underline" onClick={clearAll}>{t('qa.clearFilters')}</button></div>
        : view === 'board' ? <QaKanban key={JSON.stringify({ ...filters, revision, actor: actor.id })} client={client} actor={actor} workflow={workflow} filters={filters} reloadToken={boardRevision} onPendingChange={setBoardBusy} onOpen={openIssue} /> : <>
          {loading ? <p role="status" className="py-8 text-center text-sm">{t('qa.loading')}</p> : !list.issues.length ? <p className="py-12 text-center text-muted-foreground">{t('qa.empty')}</p> : <ul className="grid gap-3 lg:grid-cols-2 2xl:grid-cols-3">{list.issues.map(issue => <li key={issue.id}><QaIssueCard list issue={issue} actor={actor} stateLabel={workflow.labels[issue.state] || t(`qa.state.${issue.state}`)} onOpen={openIssue} /></li>)}</ul>}
          <div className="flex flex-wrap items-center justify-between gap-2 text-sm"><span>{t('qa.count', { count: list.total })}</span><div className="flex gap-2"><button className={qaButton} disabled={loading || offset === 0} onClick={() => setOffset(value => Math.max(0, value - 25))}>{t('qa.previous')}</button><button className={qaButton} disabled={loading || !list.hasMore} onClick={() => setOffset(value => value + 25)}>{t('qa.next')}</button></div></div>
        </>}
      </>}
    </div>
    {(creating || !!issueId) && <QaRecordView title={creating ? t('qa.reportTitle') : detail?.issue.title || t('qa.details')} creating={creating} busy={busy} suspended={recordSuspended} onClose={() => { if (recordBusy || hasQaNavigationGuard()) return; creatingRef.current = false; setCreating(false); openIssue(''); }}>
      {creating ? <div className="h-full min-h-0 p-4 md:p-6"><QaCreatePanel fixedFooter client={client} productLines={productLines} projects={allProjects} projectId={selectedProjectId || undefined} issueId={createIds.current.id} commandId={createIds.current.commandId} onCreated={id => { setBoardRevision(value => value + 1); openIssue(id, undefined, undefined, true); }} onBusyChange={value => { creatingBusy.current = value; setRecordBusy(value); }} onCancel={() => { if (!recordBusy) { creatingRef.current = false; setCreating(false); setError(null); } }} /></div> : detail && workflow ? <QaIssueDetail key={issueId} detail={detail} client={client} actor={actor} workflow={workflow} initialAction={initialAction} initialDefaults={initialDefaults} onRefresh={refreshDetail} onBusyChange={setRecordBusy} onBack={() => openIssue('')} /> : <div className="p-6">{error !== null ? <><QaFailure error={error} /><button className={qaButton} onClick={() => setRevision(value => value + 1)}>{t('qa.refresh')}</button></> : <p role="status">{t('qa.loading')}</p>}</div>}
    </QaRecordView>}
  </div>;
}
