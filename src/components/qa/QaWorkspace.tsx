import QaRecordView from './QaRecordView';
import { Bug, Plus, Settings2, LayoutGrid, List, Search, RefreshCw, SlidersHorizontal, X, MessageSquare } from 'lucide-react';
import QaCreatePanel from './QaCreatePanel';
import QaIssueCard from './QaIssueCard';
import { ProjectSelectOptions } from '@/components/project/ProjectOptions';
import { ColoredStatusSelect } from '@/components/ui/colored-status-select';
import { groupProjectsByLine } from '@/lib/projectGroups';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useUIContext } from '@/context/UIContext';
import { useProjectContext } from '@/context/ProjectContext';
import { useQa } from '@/hooks/useQa';
import { USING_MOCK_BACKEND } from '@/integrations/supabase/client';
import type { QaCommand, QaDetail, QaListInput, QaListResult, QaState } from '@/lib/qa/domain';
import type { QaWorkflow } from '@/lib/qa/workflow';
import { qaId } from '@/lib/qa/client';
import { hasQaNavigationGuard } from '@/lib/qa/navigationGuard';
import { QaField, QaSelect, qaButton, qaPrimary } from './QaFields';
import QaIssueDetail, { QaFailure } from './QaIssueDetail';
import type { QaActionDefaults } from '@/lib/qa/boardInteraction';
import QaKanban from './QaKanban';
import QaSettingsPage from './QaSettingsPage';
import { canManageQaConfiguration } from '@/lib/qa/fields';
import { qaStateColors } from './QaBadges';
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
  const { client, actor } = useQa();
  const { taskDisplayMode = 'modal' } = useUIContext();
  const { allProjects, productLines, selectedProjectId, setSelectedProjectId } = useProjectContext();
  const [issueId, setIssueId] = useState(() => new URLSearchParams(window.location.search).get('qa') || '');
  const [creating, setCreating] = useState(false);
  const background = useRef<HTMLDivElement>(null);
  const [detail, setDetail] = useState<QaDetail | null>(null);
  const [list, setList] = useState<QaListResult>({ issues: [], total: 0, hasMore: false });
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [searchDraft, setSearchDraft] = useState('');
  const [search, setSearch] = useState('');
  const [state, setState] = useState<QaState | ''>('');
  const [owner, setOwner] = useState<QaListInput['mine'] | ''>(mine ? 'testing' : '');
  const [offset, setOffset] = useState(0);
  const [revision, setRevision] = useState(0);
  const [view, setView] = useState<'board' | 'list'>('board');
  const [workflow, setWorkflow] = useState<QaWorkflow | null>(null);
  const [workflowError, setWorkflowError] = useState<unknown>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [initialAction, setInitialAction] = useState<QaCommand['type'] | undefined>();
  const [initialDefaults, setInitialDefaults] = useState<QaActionDefaults | undefined>();
  const modalOpen = creating || (!!issueId && taskDisplayMode === 'modal');
  useEffect(() => { background.current?.toggleAttribute('inert', modalOpen); }, [modalOpen]);
  const canConfigure = canManageQaConfiguration(actor);
  const filters = useMemo(() => ({ projectId: selectedProjectId || undefined, state: state || undefined, mine: owner || undefined, search }), [selectedProjectId, state, owner, search]);
  const createIds = useRef({ id: qaId(), commandId: qaId() });
  const creatingBusy = useRef(false);
  const creatingRef = useRef(false); creatingRef.current = creating;
  const previousProject = useRef(selectedProjectId);
  const currentId = useRef(issueId); currentId.current = issueId;
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
    const controller = new AbortController(); setLoading(true); setError(null);
    void client.list({ projectId: selectedProjectId || undefined, state: state || undefined, mine: owner || undefined, search, offset, limit: 25 }, controller.signal)
      .then(result => { if (!controller.signal.aborted) setList(result); })
      .catch(failure => { if (!controller.signal.aborted) setError(failure); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [client, actor.id, selectedProjectId, state, owner, search, offset, revision, issueId, creating, view]);
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
    const value = await client.get(issueId);
    if (currentId.current === issueId) setDetail(value);
  }, [client, issueId]);
  const beginCreate = () => { if (busy || hasQaNavigationGuard() || creatingRef.current) return; creatingRef.current = true; createIds.current = { id: qaId(), commandId: qaId() }; setError(null); setCreating(true); };
  if (settingsOpen && canConfigure && workflow && !creating && !issueId) return <QaSettingsPage client={client} actor={actor} workflow={workflow} onWorkflowSaved={setWorkflow} onClose={() => setSettingsOpen(false)} />;
  return <div className="min-w-0 flex-1 overflow-y-auto bg-board p-3 md:p-5">
    <div ref={background} aria-hidden={modalOpen || undefined} className="w-full min-w-0 space-y-4" hidden={(!!issueId || creating) && taskDisplayMode === 'page' && !creating}>
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-3"><div className="rounded-xl border border-primary/15 bg-primary/10 p-2.5 text-primary"><Bug size={22} aria-hidden="true" /></div><div><h1 className="text-xl font-bold">{t(mine ? 'qa.myTitle' : 'qa.title')}</h1><p className="mt-0.5 text-xs text-muted-foreground">{t('qa.workspaceIntro')}</p>{USING_MOCK_BACKEND && <p className="mt-1 text-xs text-muted-foreground">{t('qa.demo')}</p>}</div></div>
        {!creating && !issueId && <div className="flex flex-wrap gap-2">{canConfigure && <button className={qaButton} disabled={busy || !workflow} onClick={() => setSettingsOpen(value => !value)}><Settings2 size={15} aria-hidden="true" />{t('qa.settingsTitle')}</button>}<button className={qaPrimary} disabled={busy} onClick={beginCreate}><Plus size={16} aria-hidden="true" />{t('qa.report')}</button></div>}
        {issueId && <button disabled={busy} className={qaButton} onClick={() => openIssue('')}>{t('qa.back')}</button>}
      </header>
      {error !== null && <><QaFailure error={error} />{!creating && <button className={qaButton} onClick={() => setRevision(value => value + 1)}>{t('qa.refresh')}</button>}</>}
      {workflowError !== null && <><QaFailure error={workflowError} /><button className={qaButton} onClick={() => setRevision(value => value + 1)}>{t('qa.refresh')}</button></>}
      {!workflow ? !workflowError && <p role="status">{t('qa.loading')}</p> : <>
        <div className="rounded-xl border border-border/80 bg-card shadow-sm">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border/70 px-3 py-2.5">
          <div className="flex gap-1 rounded-lg bg-muted/70 p-1" role="group" aria-label={t('qa.viewMode')}>{([{ id: 'board', Icon: LayoutGrid }, { id: 'list', Icon: List }] as const).map(({ id, Icon }) => <button key={id} className={`inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium outline-none focus-visible:ring-2 focus-visible:ring-primary ${view === id ? 'bg-background text-primary shadow-sm' : 'text-muted-foreground hover:text-foreground'}`} aria-pressed={view === id} disabled={busy} onClick={() => setView(id)}><Icon size={15} aria-hidden="true" />{t(`qa.${id}`)}</button>)}</div>
          <details className="relative text-sm"><summary className="flex cursor-pointer list-none items-center gap-1.5 rounded-md px-2 py-1.5 text-muted-foreground hover:bg-accent"><MessageSquare size={15} aria-hidden="true" />{t('qa.slackTitle')}</summary><div className="absolute right-0 z-20 mt-2 w-[min(80vw,360px)] rounded-xl border border-border bg-popover p-4 text-sm text-popover-foreground shadow-lg">{t('qa.slackUsage')}</div></details>
        </div>
        <form className="grid items-end gap-3 p-3 sm:grid-cols-2 xl:grid-cols-[minmax(180px,1.5fr)_minmax(150px,1fr)_minmax(140px,1fr)_minmax(140px,1fr)_auto]" onSubmit={event => { event.preventDefault(); if (busy) return; setSearch(searchDraft); setOffset(0); }}>
          <QaField disabled={busy} label={t('qa.search')} placeholder={t('qa.searchPlaceholder')} value={searchDraft} onChange={event => setSearchDraft(event.target.value)} />
          <QaSelect disabled={busy} label={t('qa.project')} value={selectedProjectId || ''} onChange={event => { setSelectedProjectId(event.target.value || null); setOffset(0); }}><option value="">{t('qa.allProjects')}</option><ProjectSelectOptions groups={groupProjectsByLine(productLines, allProjects, { archived: 'all' })} /></QaSelect>
          <ColoredStatusSelect<QaState | ''> label={t('qa.allStates')} disabled={busy} value={state} onValueChange={value => { setState(value); setOffset(0); }}
            options={[{ value: '', label: t('qa.allStates') }, ...workflow.order.map(value => ({ value, label: workflow.labels[value] || t(`qa.state.${value}`), color: qaStateColors[value] }))]} />
          <QaSelect disabled={busy} label={t('qa.myTitle')} value={owner} onChange={event => { setOwner(event.target.value as QaListInput['mine'] | ''); setOffset(0); }}><option value="">{t('qa.everyone')}</option>{['assigned', 'testing', 'reported'].map(value => <option key={value} value={value}>{t(`qa.${value}`)}</option>)}</QaSelect>
          <div className="flex gap-2"><button disabled={busy} className={qaPrimary}><Search size={15} aria-hidden="true" />{t('qa.searchButton')}</button><button type="button" disabled={busy} className={qaButton} onClick={() => setRevision(value => value + 1)} title={t('qa.refresh')} aria-label={t('qa.refresh')}><RefreshCw size={15} aria-hidden="true" /></button></div>
        </form>
        {(search || state || owner) && <div className="flex items-center gap-2 border-t border-border/60 px-3 py-2 text-xs text-muted-foreground"><SlidersHorizontal size={13} aria-hidden="true" />{t('qa.filtersApplied')}<button disabled={busy} className="inline-flex items-center gap-1 rounded px-2 py-1 text-primary hover:bg-primary/5" onClick={() => { setSearch(''); setSearchDraft(''); setState(''); setOwner(''); setOffset(0); }}><X size={12} aria-hidden="true" />{t('qa.clearFilters')}</button></div>}
        </div>
        {view === 'board' ? <QaKanban key={JSON.stringify({ ...filters, revision, actor: actor.id })} client={client} actor={actor} workflow={workflow} filters={filters} onPendingChange={setBusy} onOpen={openIssue} /> : <>
          {loading ? <p role="status" className="py-8 text-center text-sm">{t('qa.loading')}</p> : !list.issues.length ? <p className="py-12 text-center text-muted-foreground">{t('qa.empty')}</p> : <ul className="grid gap-3 lg:grid-cols-2 2xl:grid-cols-3">{list.issues.map(issue => <li key={issue.id}><QaIssueCard list issue={issue} actor={actor} stateLabel={workflow.labels[issue.state] || t(`qa.state.${issue.state}`)} onOpen={openIssue} /></li>)}</ul>}
          <div className="flex flex-wrap items-center justify-between gap-2 text-sm"><span>{t('qa.count', { count: list.total })}</span><div className="flex gap-2"><button className={qaButton} disabled={loading || offset === 0} onClick={() => setOffset(value => Math.max(0, value - 25))}>{t('qa.previous')}</button><button className={qaButton} disabled={loading || !list.hasMore} onClick={() => setOffset(value => value + 25)}>{t('qa.next')}</button></div></div>
        </>}
      </>}
    </div>
    {(creating || !!issueId) && <QaRecordView title={creating ? t('qa.reportTitle') : detail?.issue.title || t('qa.details')} creating={creating} busy={busy} onClose={() => { if (busy || hasQaNavigationGuard()) return; creatingRef.current = false; setCreating(false); openIssue(''); }}>
      {creating ? <div className="h-full min-h-0 p-4 md:p-6"><QaCreatePanel fixedFooter client={client} productLines={productLines} projects={allProjects} projectId={selectedProjectId || undefined} issueId={createIds.current.id} commandId={createIds.current.commandId} onCreated={id => openIssue(id, undefined, undefined, true)} onBusyChange={value => { creatingBusy.current = value; setBusy(value); }} onCancel={() => { if (!busy) { creatingRef.current = false; setCreating(false); setError(null); } }} /></div> : detail && workflow ? <QaIssueDetail key={issueId} detail={detail} client={client} actor={actor} workflow={workflow} initialAction={initialAction} initialDefaults={initialDefaults} onRefresh={refreshDetail} onBusyChange={setBusy} onBack={() => openIssue('')} /> : <div className="p-6">{error !== null ? <><QaFailure error={error} /><button className={qaButton} onClick={() => setRevision(value => value + 1)}>{t('qa.refresh')}</button></> : <p role="status">{t('qa.loading')}</p>}</div>}
    </QaRecordView>}
  </div>;
}
