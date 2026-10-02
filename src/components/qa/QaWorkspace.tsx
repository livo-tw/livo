import { ProjectSelectOptions } from '@/components/project/ProjectOptions';
import { groupProjectsByLine } from '@/lib/projectGroups';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useUIContext } from '@/context/UIContext';
import { useProjectContext } from '@/context/ProjectContext';
import { useMemberContext } from '@/context/MemberContext';
import { useQa } from '@/hooks/useQa';
import { USING_MOCK_BACKEND } from '@/integrations/supabase/client';
import type { QaCommand, QaCreateInput, QaDetail, QaListInput, QaListResult, QaState } from '@/lib/qa/domain';
import type { QaWorkflow } from '@/lib/qa/workflow';
import { qaId } from '@/lib/qa/client';
import { QaField, QaSelect, qaButton, qaPrimary } from './QaFields';
import QaReportForm from './QaReportForm';
import QaIssueDetail, { QaFailure } from './QaIssueDetail';
import QaKanban from './QaKanban';
import QaWorkflowSettings from './QaWorkflowSettings';

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
  const { allProjects, productLines, selectedProjectId, setSelectedProjectId } = useProjectContext();
  const { users } = useMemberContext();
  const [issueId, setIssueId] = useState(() => new URLSearchParams(window.location.search).get('qa') || '');
  const [creating, setCreating] = useState(false);
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
  const canConfigure = actor.role === 'admin' || actor.role === 'super_admin';
  const filters = useMemo(() => ({ projectId: selectedProjectId || undefined, state: state || undefined, mine: owner || undefined, search }), [selectedProjectId, state, owner, search]);
  const createIds = useRef({ id: qaId(), commandId: qaId() });
  const previousProject = useRef(selectedProjectId);
  const currentId = useRef(issueId); currentId.current = issueId;
  const openIssue = useCallback((id: string, action?: QaCommand['type']) => {
    const url = new URL(window.location.href);
    if (id) url.searchParams.set('qa', id); else url.searchParams.delete('qa');
    window.history.replaceState({}, '', url.toString()); setError(null); setIssueId(id); setCreating(false); setInitialAction(action);
  }, []);
  useEffect(() => {
    if (previousProject.current !== selectedProjectId) { previousProject.current = selectedProjectId; setOffset(0); openIssue(''); }
  }, [selectedProjectId, openIssue]);
  useEffect(() => {
    const pop = () => { setIssueId(new URLSearchParams(window.location.search).get('qa') || ''); setCreating(false); setInitialAction(undefined); };
    const createFromToolbar = () => {
      const url = new URL(window.location.href); url.searchParams.delete('qa'); url.searchParams.delete('qaCreate'); window.history.replaceState({}, '', url.toString());
      createIds.current = { id: qaId(), commandId: qaId() }; setIssueId(''); setError(null); setCreating(true);
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
  const create = async (input: QaCreateInput) => {
    if (busy) return; setBusy(true); setError(null);
    try { const result = await client.create(input, createIds.current.id, createIds.current.commandId); openIssue(result.id); }
    catch (failure) { setError(failure); }
    finally { setBusy(false); }
  };
  const beginCreate = () => { createIds.current = { id: qaId(), commandId: qaId() }; setError(null); setCreating(true); };
  if (detail && issueId && workflow) return <div className="flex-1 overflow-y-auto bg-board"><QaIssueDetail key={issueId} detail={detail} client={client} actor={actor} workflow={workflow} initialAction={initialAction} onRefresh={refreshDetail} onBack={() => openIssue('')} /></div>;
  return <div className="flex-1 overflow-y-auto bg-board p-3 md:p-6">
    <div className="mx-auto max-w-6xl space-y-4">
      <header className="flex flex-wrap items-center justify-between gap-3"><div><h1 className="text-xl font-bold">{t(creating ? 'qa.reportTitle' : mine ? 'qa.myTitle' : 'qa.title')}</h1>{USING_MOCK_BACKEND && <p className="mt-1 text-xs text-muted-foreground">{t('qa.demo')}</p>}</div>{!creating && !issueId && <div className="flex flex-wrap gap-2">{canConfigure && <button className={qaButton} disabled={!workflow} onClick={() => setSettingsOpen(value => !value)}>{t('qa.workflowTitle')}</button>}<button className={qaPrimary} onClick={beginCreate}>{t('qa.report')}</button></div>}{issueId && <button className={qaButton} onClick={() => openIssue('')}>{t('qa.back')}</button>}</header>
      {error !== null && <><QaFailure error={error} />{!creating && <button className={qaButton} onClick={() => setRevision(value => value + 1)}>{t('qa.refresh')}</button>}</>}
      {workflowError !== null && <><QaFailure error={workflowError} /><button className={qaButton} onClick={() => setRevision(value => value + 1)}>{t('qa.refresh')}</button></>}
      {settingsOpen && canConfigure && workflow && !creating && !issueId && <QaWorkflowSettings workflow={workflow} client={client} onSaved={setWorkflow} onClose={() => setSettingsOpen(false)} />}
      {!issueId && <details className="rounded-lg border border-border bg-card p-3 text-sm"><summary className="cursor-pointer font-medium">{t('qa.slackTitle')}</summary><p className="mt-2 text-muted-foreground">{t('qa.slackUsage')}</p><p className="mt-2 text-xs text-muted-foreground">{t('qa.slackGate')}</p></details>}
      {creating ? <div className="mx-auto max-w-2xl rounded-xl border border-border bg-card p-4 md:p-6"><QaReportForm client={client} productLines={productLines} projects={allProjects} projectId={selectedProjectId || undefined} busy={busy} onSubmit={input => void create(input)} onCancel={() => { setCreating(false); setError(null); }} /></div> : issueId ? (loading || !workflow) && !workflowError && <p role="status">{t('qa.loading')}</p> : !workflow ? !workflowError && <p role="status">{t('qa.loading')}</p> : <>
        <div className="flex gap-2" role="group" aria-label={t('qa.viewMode')}><button className={view === 'board' ? qaPrimary : qaButton} aria-pressed={view === 'board'} onClick={() => setView('board')}>{t('qa.board')}</button><button className={view === 'list' ? qaPrimary : qaButton} aria-pressed={view === 'list'} onClick={() => setView('list')}>{t('qa.list')}</button></div>
        <form className="grid items-end gap-3 rounded-xl border border-border bg-card p-3 sm:grid-cols-2 lg:grid-cols-5" onSubmit={event => { event.preventDefault(); setSearch(searchDraft); setOffset(0); }}>
          <QaField label={t('qa.search')} value={searchDraft} onChange={event => setSearchDraft(event.target.value)} />
          <QaSelect label={t('qa.project')} value={selectedProjectId || ''} onChange={event => { setSelectedProjectId(event.target.value || null); setOffset(0); }}><option value="">{t('qa.allProjects')}</option><ProjectSelectOptions groups={groupProjectsByLine(productLines, allProjects, { archived: 'all' })} /></QaSelect>
          <QaSelect label={t('qa.allStates')} value={state} onChange={event => { setState(event.target.value as QaState | ''); setOffset(0); }}><option value="">{t('qa.allStates')}</option>{workflow.order.map(value => <option key={value} value={value}>{workflow.labels[value] || t(`qa.state.${value}`)}</option>)}</QaSelect>
          <QaSelect label={t('qa.myTitle')} value={owner} onChange={event => { setOwner(event.target.value as QaListInput['mine'] | ''); setOffset(0); }}><option value="">{t('qa.everyone')}</option>{['assigned', 'testing', 'reported'].map(value => <option key={value} value={value}>{t(`qa.${value}`)}</option>)}</QaSelect>
          <div className="flex gap-2"><button className={qaPrimary}>{t('qa.searchButton')}</button><button type="button" className={qaButton} onClick={() => setRevision(value => value + 1)}>{t('qa.refresh')}</button></div>
        </form>
        {view === 'board' ? <QaKanban key={JSON.stringify({ ...filters, revision, actor: actor.id })} client={client} actor={actor} workflow={workflow} filters={filters} onOpen={openIssue} projectName={id => allProjects.find(project => project.id === id)?.name || '—'} memberName={id => users.find(user => user.id === id)?.name || '—'} /> : <>
          {loading ? <p role="status" className="py-8 text-center text-sm">{t('qa.loading')}</p> : !list.issues.length ? <p className="py-12 text-center text-muted-foreground">{t('qa.empty')}</p> : <ul className="space-y-2">{list.issues.map(issue => <li key={issue.id}><button className="w-full rounded-xl border border-border bg-card p-4 text-left shadow-sm transition hover:border-primary focus:outline-none focus:ring-2 focus:ring-primary" onClick={() => openIssue(issue.id)}><div className="flex flex-wrap justify-between gap-2"><h2 className="min-w-0 break-words font-semibold">{issue.title}</h2><span className="rounded-full bg-primary/10 px-2 py-1 text-xs text-primary">{workflow.labels[issue.state] || t(`qa.state.${issue.state}`)}</span></div><div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground"><span>{allProjects.find(project => project.id === issue.projectId)?.name}</span><span>{issue.observedEnvironment} · {issue.observedVersion || '—'}</span><span>{t(`qa.severityNames.${issue.severity}`)}</span><span>{t('qa.assignee')}: {users.find(user => user.id === issue.assigneeId)?.name || '—'}</span><span>{t('qa.qaOwner')}: {users.find(user => user.id === issue.qaOwnerId)?.name || '—'}</span></div></button></li>)}</ul>}
          <div className="flex flex-wrap items-center justify-between gap-2 text-sm"><span>{t('qa.count', { count: list.total })}</span><div className="flex gap-2"><button className={qaButton} disabled={loading || offset === 0} onClick={() => setOffset(value => Math.max(0, value - 25))}>{t('qa.previous')}</button><button className={qaButton} disabled={loading || !list.hasMore} onClick={() => setOffset(value => value + 25)}>{t('qa.next')}</button></div></div>
        </>}
      </>}
    </div>
  </div>;
}
