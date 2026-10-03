import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Package, Plus, RefreshCw } from 'lucide-react';
import { useAuthContext } from '@/context/AuthContext';
import { useProjectContext } from '@/context/ProjectContext';
import { useMemberContext } from '@/context/MemberContext';
import { useTaskContext } from '@/context/TaskContext';
import { useDeploymentEnvironments } from '@/context/DeploymentEnvironmentContext';
import { useQa } from '@/hooks/useQa';
import { randomUUID } from '@/lib/generateId';
import { createReleaseClient } from '@/lib/releases/client';
import type { ReleaseBatch, ReleasePage, ReleaseQaSource } from '@/lib/releases/core';
import { groupProjectsByLine } from '@/lib/projectGroups';
import { hasReleaseNavigationGuard } from './navigation';
import { ProjectSelectOptions } from '@/components/project/ProjectOptions';
import { USING_MOCK_BACKEND } from '@/integrations/supabase/client';
import ReleaseManifestForm from './ReleaseManifestForm';
import ReleaseDetail from './ReleaseDetail';
import { ReleaseFailure, ReleaseField, ReleaseSelect, releaseButton, releasePrimary } from './ReleaseFields';

export default function ReleaseWorkspaceView() {
  const { currentMember } = useAuthContext();
  return currentMember ? <ReleaseWorkspaceContent key={currentMember.id} actorId={currentMember.id} role={currentMember.role} /> : null;
}
function ReleaseWorkspaceContent({ actorId, role }: { actorId: string; role: string }) {
  const { t } = useTranslation();
  const { allProjects, productLines } = useProjectContext(), { users } = useMemberContext(), { allTasks } = useTaskContext();
  const environments = useDeploymentEnvironments(), qa = useQa();
  const sources = useRef(new Map<string, ReleaseQaSource>()), latest = useRef({ allProjects, users, allTasks, environments, actorId, role });
  latest.current = { allProjects, users, allTasks, environments, actorId, role };
  const client = useMemo(() => createReleaseClient({ context: () => {
    const v = latest.current;
    return { workspaceId: 'default', actorId: v.actorId, role: v.role, now: new Date().toISOString(), newId: randomUUID, memberIds: new Set(v.users.filter(u => u.isActive).map(u => u.id)), projectIds: new Set(v.allProjects.filter(p => !p.isArchived).map(p => p.id)), visibleProjectIds: new Set(v.allProjects.map(p => p.id)), taskProjects: new Map(v.allTasks.map(task => [task.id, task.projectId])), environments: v.environments.ready ? v.environments.values : [], qaSources: sources.current };
  } }), []);
  const resources = { projects: allProjects, productLines, users, tasks: allTasks, environments: environments.values, environmentsReady: environments.ready };
  const canManage = role === 'admin' || role === 'super_admin';
  const [batchId, setBatchId] = useState(() => new URLSearchParams(window.location.search).get('release') ?? ''), [creating, setCreating] = useState(false);
  const [batch, setBatch] = useState<ReleaseBatch | null>(null), [page, setPage] = useState(0), [list, setList] = useState<ReleasePage | null>(null);
  const [projectId, setProjectId] = useState(''), [draftSearch, setDraftSearch] = useState(''), [search, setSearch] = useState(''), [revision, setRevision] = useState(0);
  const [loading, setLoading] = useState(false), [error, setError] = useState<unknown>(null);
  const savedRead = useRef('');
  const open = useCallback((id: string) => {
    const url = new URL(window.location.href); if (id) url.searchParams.set('release', id); else url.searchParams.delete('release');
    window.history.replaceState({}, '', url.toString()); setBatchId(id); setCreating(false); setBatch(null); setError(null);
  }, []);
  useEffect(() => {
    const pop = () => { if (!hasReleaseNavigationGuard()) { setBatch(null); setBatchId(new URLSearchParams(window.location.search).get('release') ?? ''); setCreating(false); } };
    window.addEventListener('popstate', pop); return () => window.removeEventListener('popstate', pop);
  }, []);
  useEffect(() => {
    if (creating) return;
    if (batchId && savedRead.current === batchId) { savedRead.current = ''; setLoading(false); return; }
    let active = true; setLoading(true); setError(null); setBatch(null); setList(null);
    const request = batchId ? client.get(batchId).then(v => { if (active) setBatch(v); }) : client.list(page, projectId || undefined, search || undefined).then(v => { if (active) setList(v); });
    void request.catch(e => { if (active) setError(e); }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [client, batchId, creating, page, projectId, search, revision]);
  const saved = (value: ReleaseBatch) => {
    if (creating || batchId !== value.id) savedRead.current = value.id;
    const url = new URL(window.location.href); url.searchParams.set('release', value.id); window.history.replaceState({}, '', url.toString());
    setCreating(false); setBatchId(value.id); setBatch(value); setError(null);
  };
  const onSource = useCallback((source: ReleaseQaSource) => { sources.current.set(source.id, source); }, []);
  return <div className="flex-1 min-w-0 overflow-y-auto bg-board p-3 md:p-6"><div className="mx-auto max-w-6xl space-y-5">
    {creating && canManage ? <ReleaseManifestForm actorId={actorId} client={client} resources={resources} onSaved={saved} onCancel={() => setCreating(false)} /> : batch && batchId ? <ReleaseDetail key={`${batch.id}-${role}`} batch={batch} client={client} resources={resources} actorId={actorId} canManage={canManage} qaClient={qa.client} qaEnabled={qa.enabled} onSource={onSource} onSaved={saved} onBack={() => open('')} onRefresh={() => setRevision(v => v + 1)} /> : <>
      <header className="flex flex-wrap items-start justify-between gap-3"><div><h1 className="flex items-center gap-2 text-2xl font-bold"><Package size={24} />{t('releaseWorkspace.title')}</h1><p className="mt-2 text-sm text-muted-foreground">{t('releaseWorkspace.intro')}</p>{USING_MOCK_BACKEND && <p className="text-xs text-muted-foreground">{t('releaseWorkspace.demo')}</p>}</div><div className="flex gap-2"><button className={releaseButton} onClick={() => setRevision(v => v + 1)}><RefreshCw size={16} />{t('releaseWorkspace.refresh')}</button>{canManage && !batchId && <button className={releasePrimary} onClick={() => { setError(null); setCreating(true); }}><Plus size={16} />{t('releaseWorkspace.create')}</button>}</div></header>
      {batchId ? <button className={releaseButton} onClick={() => open('')}>{t('releaseWorkspace.back')}</button> : <form className="grid items-end gap-3 rounded-xl border bg-card p-4 sm:grid-cols-3" onSubmit={e => { e.preventDefault(); setSearch(draftSearch); setPage(0); }}><ReleaseField label={t('releaseWorkspace.search')} maxLength={200} value={draftSearch} onChange={e => setDraftSearch(e.target.value)} /><ReleaseSelect label={t('releaseWorkspace.project')} value={projectId} onChange={e => { setProjectId(e.target.value); setPage(0); }}><option value="">{t('releaseWorkspace.allProjects')}</option><ProjectSelectOptions groups={groupProjectsByLine(productLines, allProjects, { archived: 'all' })} /></ReleaseSelect><button className={releaseButton} type="submit">{t('releaseWorkspace.search')}</button></form>}
      {error !== null && <ReleaseFailure error={error} />}{loading && <p role="status">{t('releaseWorkspace.loading')}</p>}
      {!batchId && list && <><div className="grid gap-3 md:grid-cols-2">{list.batches.map(value => <button className="space-y-2 rounded-xl border bg-card p-4 text-left hover:border-primary" key={value.id} onClick={() => open(value.id)}><h2 className="font-semibold break-words">{value.title}</h2><p className="text-sm text-muted-foreground">{t(`releaseWorkspace.statuses.${value.status}`)} · {t('releaseWorkspace.revision', { n: value.manifestRevision })}</p><p className="text-xs text-muted-foreground">{value.components.map(c => c.name).join(' / ')} · {value.updatedAt}</p></button>)}</div>{!list.batches.length && <p className="rounded-xl border border-dashed p-8 text-center text-muted-foreground">{t('releaseWorkspace.empty')}</p>}<div className="flex items-center gap-2"><button className={releaseButton} disabled={page === 0} onClick={() => setPage(v => v - 1)}>{t('releaseWorkspace.previous')}</button><span>{t('releaseWorkspace.page', { n: page + 1 })}</span><button className={releaseButton} disabled={!list.hasMore} onClick={() => setPage(v => v + 1)}>{t('releaseWorkspace.next')}</button></div></>}
    </>}
  </div></div>;
}
