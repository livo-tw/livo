import { SearchableSelect } from '@/components/ui/searchable-select';
import { ProjectSelectOptions } from '@/components/project/ProjectOptions';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { BookOpen, Plus, History, Lock, Paperclip, Trash2, ArrowLeft, ShieldCheck, FileText, Pencil, BadgeCheck, MoreHorizontal, Archive, ArchiveRestore, FileUp, FilePlus } from 'lucide-react';
import { IconAction } from '@/components/ui/icon-action';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { renderKnowledgeHtml } from '@/lib/knowledgeHtml';
import { randomUUID } from '@/lib/generateId';
import { toast } from 'sonner';
import { useAuthContext } from '@/context/AuthContext';
import { useProjectContext } from '@/context/ProjectContext';
import { useMemberContext } from '@/context/MemberContext';
import { usePresenceLock } from '@/hooks/usePresenceLock';
import { useKnowledgeBase, uploadKnowledgeFile, downloadKnowledgeFile } from '@/hooks/useKnowledgeBase';
import { validateKnowledgeTree, knowledgeInsidePrivateDraft, knowledgeDeleteErrorKey, knowledgeDirectoryPages } from '@/lib/knowledge';
import KnowledgeNavigation, { KnowledgePageActions } from '@/components/knowledge/KnowledgeNavigation';
import KnowledgeSidebar from '@/components/knowledge/KnowledgeSidebar';
import KnowledgeShareActions from '@/components/knowledge/KnowledgeShareActions';
import KnowledgeReadingBody, { KNOWLEDGE_READING_STYLE } from '@/components/knowledge/KnowledgeReadingBody';
import { KnowledgeWorkflowPanel } from '@/components/knowledge/KnowledgeWorkflowPanel';
import { useKnowledgeNavigation } from '@/hooks/useKnowledgeNavigation';
import { useProjectScope } from '@/hooks/useProjectScope';
import KnowledgeImportDialog from '@/components/KnowledgeImportDialog';
import KnowledgeImportSources from '@/components/KnowledgeImportSources';
import { useKnowledgeImportCapability } from '@/hooks/useKnowledgeImportCapability';
import { groupProjectsByLine } from '@/lib/projectGroups';
import { MAX_UPLOAD_MB } from '@/lib/uploadLimits';
import { knowledgeClient as supabase } from '@/integrations/supabase/knowledgeClient';
import RichTextEditor from '@/components/RichTextEditorLazy';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import KnowledgePermissionsDialog from '@/components/KnowledgePermissionsDialog';
import KnowledgeComments from '@/components/KnowledgeComments';
import KnowledgeWorkPanel from '@/components/knowledge-work/KnowledgeWorkPanel';
import KnowledgeWorkSpace from '@/components/knowledge-work/KnowledgeWorkSpace';
import { createKnowledgeWorkClient, type KnowledgeSearchItem } from '@/lib/knowledgeWork/client';
import { knowledgeCan, parseKnowledgePolicy } from '../../worker/src/knowledgeAccess';
import { KNOWLEDGE_DEPTH } from '../../worker/src/knowledgeModel';
import type { KnowledgePage, KnowledgeRevision, KnowledgePolicy } from '@/types/knowledge';
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { IS_DEMO_PRO } from '@/lib/demoMode';
import { DEMO_BANNER_HEIGHT } from '@/components/DemoModeBanner';
import { useUnsavedDraft } from '@/lib/unsavedDrafts';

const selectStyle = 'h-9 rounded-md border border-input bg-background px-2 text-sm min-w-0';

export default function KnowledgeBaseView() {
  const { t } = useTranslation();
  const { currentMemberId, currentMember } = useAuthContext();
  const { allProjects, productLines, selectedProjectId } = useProjectContext();
  const { users } = useMemberContext();
  const [scope, setScope] = useState(selectedProjectId || 'all');
  const [selectedId, setSelectedId] = useState<string | null>(() => new URLSearchParams(window.location.search).get('kb'));
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState<'all' | 'general' | 'meeting'>('all');
  const [newCategory, setNewCategory] = useState<'general' | 'meeting'>('general');
  const [newParent, setNewParent] = useState('');
  const [newPolicy, setNewPolicy] = useState<KnowledgePolicy>({ mode: 'inherit' });
  const [permissionTarget, setPermissionTarget] = useState<'page' | 'new' | null>(null);
  const [showArchived, setShowArchived] = useState(false);
  const [draft, setDraft] = useState<KnowledgePage | null>(null);
  // Leaving the knowledge base with a page open for editing asks first, like switching pages here does.
  useUnsavedDraft('view', !!draft, t('kb.discard'));
  const [busy, setBusy] = useState(false);
  const draftRef = useRef(draft); draftRef.current = draft;
  const lastLocation = useRef(window.location.href);
  const [showHistory, setShowHistory] = useState(false);
  const [preview, setPreview] = useState<KnowledgeRevision | null>(null);
  const [creating, setCreating] = useState(false);
  const [workOpen, setWorkOpen] = useState(false);
  const [workPanelOpen, setWorkPanelOpen] = useState(false);
  const workClient = useMemo(() => createKnowledgeWorkClient(supabase), [currentMemberId]);
  const [importOpen, setImportOpen] = useState(false);
  const [importTargetId, setImportTargetId] = useState<string | undefined>(undefined);
  const [newTitle, setNewTitle] = useState('');
  const [newScope, setNewScope] = useState(selectedProjectId || 'shared');
  const fileInput = useRef<HTMLInputElement>(null);
  const member = users.find(u => u.id === currentMemberId) || currentMember;
  const actor = member && currentMemberId ? { id: currentMemberId, role: member.role || currentMember?.role || '', jobTitle: member.jobTitle || '', is_active: member.isActive !== false } : null;
  const hasActor = !!actor;
  const { pages, attachments, revisions, comments, loading, error, ready, refresh } = useKnowledgeBase(selectedId, actor);
  const importCapability = useKnowledgeImportCapability(JSON.stringify(actor));
  const locks = usePresenceLock('knowledge-base');
  const activeLock = useRef<string | null>(null);
  const admin = actor?.role === 'admin' || actor?.role === 'super_admin';
  const page = pages.find(p => p.id === selectedId && knowledgeCan(pages, p.id, actor, 'view'));
  const lockedBy = page ? locks.isLockedBy(`kb:${page.id}`) : null;
  const hasEditAccess = !!page && knowledgeCan(pages, page.id, actor, 'edit');
  const canEdit = hasEditAccess && !lockedBy;
  const canArchive = !!page && admin && knowledgeCan(pages.map(p => p.id === page.id ? { ...p, is_archived: false } : p), page.id, actor, 'edit') && !lockedBy;
  const canComment = !!page && knowledgeCan(pages, page.id, actor, 'comment');
  const canDelete = !!page && canEdit && (admin || page.created_by === currentMemberId);
  const pagePolicy = useMemo(() => parseKnowledgePolicy(page?.access_policy) || { mode: 'inherit' } as KnowledgePolicy, [page?.access_policy]);
  const scopeName = (id: string | null) => id ? allProjects.find(p => p.id === id)?.name || t('kb.unknownProject') : t('kb.shared');
  // The sidebar project or product line limits the directory, as on the task views;
  // search still covers every scope (kb.searchAll).
  const { projectIds: sidebarScope } = useProjectScope();
  const inLine = (projectId: string | null) => !sidebarScope || (!!projectId && sidebarScope.has(projectId));
  const visible = pages.filter(p => knowledgeCan(pages, p.id, actor, 'view') && (showArchived || !p.is_archived) && (category === 'all' || (p.category || 'general') === category));
  const navigation = useKnowledgeNavigation(currentMemberId || '', pages);
  // A private draft belongs to no project. With a sidebar project or line selected the shared
  // pages are left out of the directory (search still covers every scope), but the member's
  // own drafts stay reachable in their own group.
  const treePages = knowledgeDirectoryPages(visible, !!sidebarScope, actor?.id);
  const sharedGroup = !sidebarScope ? [{ id: 'shared', name: t('kb.shared') }] : treePages.some(candidate => !candidate.project_id) ? [{ id: 'shared', name: t('knowledgeWork.tabs.mine') }] : [];
  const groups = [...sharedGroup, ...allProjects.filter(p => !p.isArchived && inLine(p.id)).map(p => ({ id: p.id, name: p.name }))];
  const projectGroups = useMemo(() => groupProjectsByLine(productLines, allProjects), [productLines, allProjects]);
  const scopeOptions = <>
    <option value="shared">{t('kb.shared')}</option>
    <ProjectSelectOptions groups={projectGroups} />
  </>;
  // The filter offers only what the sidebar scope shows; moving or creating a page still lists every project.
  const filterScopeOptions = sidebarScope ? <ProjectSelectOptions groups={groupProjectsByLine(productLines, allProjects.filter(p => inLine(p.id)))} /> : scopeOptions;

  useEffect(() => { setScope(selectedProjectId || 'all'); }, [selectedProjectId]);

  useEffect(() => {
    // Wait for pages read as the current member; an identity change briefly shows none.
    if (!ready || error || !actor) return;
    const url = new URL(window.location.href), requestedId = url.searchParams.get('knowledge');
    if (!requestedId) return;
    const target = pages.find(candidate => candidate.id === requestedId && !candidate.is_archived);
    if (target && knowledgeCan(pages, target.id, actor, 'view')) {
      setScope('all'); setCategory('all'); setQuery(''); setSelectedId(target.id);
    }
    // Do not retain a restricted document id in the URL or reveal its existence.
    url.searchParams.delete('knowledge');
    window.history.replaceState({}, '', url.toString());
  }, [ready, error, pages, actor]);

  useEffect(() => {
    const pop = () => {
      if (draftRef.current && !window.confirm(t('kb.discard'))) { window.history.pushState({}, '', lastLocation.current); return; }
      lastLocation.current = window.location.href; void stopEditing();
      setSelectedId(new URLSearchParams(window.location.search).get('kb')); setPreview(null); setShowHistory(false);
    };
    window.addEventListener('popstate', pop);
    return () => window.removeEventListener('popstate', pop);
  }, []);

  useEffect(() => {
    if (!page) return;
    const anchor = new URLSearchParams(window.location.search).get('anchor');
    if (!anchor) return;
    const frame = requestAnimationFrame(() => {
      const target = document.getElementById(anchor);
      if (target) { target.closest('details')?.setAttribute('open', ''); target.scrollIntoView?.({ block: 'start' }); }
    });
    return () => cancelAnimationFrame(frame);
  }, [page?.id, page?.body]);


  useEffect(() => {
    // Keep a ?kb= selection until pages for the current member are known.
    if (selectedId && ready && hasActor && !page) {
      setSelectedId(null); setPreview(null); setShowHistory(false); setPermissionTarget(null);
      void stopEditing();
    } else if (draft && !hasEditAccess) {
      void stopEditing();
    }
  }, [selectedId, page, ready, hasActor, hasEditAccess, draft]);

  useEffect(() => { if (!admin) setPermissionTarget(null); }, [admin]);

  useEffect(() => {
    const warn = (event: BeforeUnloadEvent) => { if (activeLock.current) { event.preventDefault(); event.returnValue = ''; } };
    window.addEventListener('beforeunload', warn);
    return () => { window.removeEventListener('beforeunload', warn); };
  }, []);

  function report(failure: unknown) {
    const message = failure && typeof failure === 'object' && 'message' in failure ? String(failure.message) : String(failure);
    const key = message.match(/kb_[a-z_]+/)?.[0] || (/foreign key/i.test(message) ? 'kb_has_children' : 'kb_failed');
    toast.error(t(`kb.errors.${key}`, { defaultValue: t('kb.errors.kb_failed'), size: MAX_UPLOAD_MB }));
  }
  async function run(action: () => Promise<void>) {
    setBusy(true);
    try { await action(); } catch (failure) { report(failure); }
    finally { setBusy(false); }
  }
  async function stopEditing() {
    const key = activeLock.current;
    activeLock.current = null;
    setDraft(null);
    if (key) await locks.releaseLock(key);
  }
  async function selectPage(id: string) {
    if (busy || (draft && !window.confirm(t('kb.discard')))) return;
    await stopEditing();
    setSelectedId(id); setPreview(null); setShowHistory(false);
    const location = new URL(window.location.href); location.searchParams.set('kb', id); location.searchParams.delete('anchor');
    window.history.pushState({}, '', location); lastLocation.current = location.href;
  }
  async function takeLock(target: KnowledgePage) {
    const key = `kb:${target.id}`;
    const acquired = await locks.acquireLock(key);
    if (!acquired.acquired) throw new Error('kb_conflict');
    activeLock.current = key;
  }
  async function edit() {
    if (!page || !canEdit) return;
    await run(async () => {
      await takeLock(page);
      // Refresh after acquiring; don't start an editor from a stale subscription.
      const result = await supabase.from('kb_pages').select('*').eq('id', page.id).single();
      if (result.error || !result.data) { await stopEditing(); throw result.error || new Error('kb_conflict'); }
      setDraft(result.data);
    });
  }
  async function update(target: KnowledgePage, patch: Partial<KnowledgePage>) {
    const result = await supabase.from('kb_pages').update({ ...patch, updated_by: currentMemberId })
      .eq('id', target.id).eq('version', target.version).select('*').single();
    if (result.error || !result.data) throw result.error || new Error('kb_conflict');
    await refresh();
    toast.success(t('kb.saved'));
  }
  async function save() {
    if (!draft || !hasEditAccess) return;
    await run(async () => {
      validateKnowledgeTree(pages.map(p => p.id === draft.id ? draft : p));
      // Send placement fields only when they changed; moving a page is a separate right.
      const original = pages.find(p => p.id === draft.id);
      const moved = (key: 'project_id' | 'parent_id' | 'sort_order') => !original || (original[key] ?? null) !== (draft[key] ?? null);
      await update(draft, { title: draft.title.trim(), body: draft.body, category: draft.category || 'general',
        ...(moved('project_id') ? { project_id: draft.project_id } : {}), ...(moved('parent_id') ? { parent_id: draft.parent_id } : {}),
        ...(moved('sort_order') ? { sort_order: draft.sort_order } : {}),
        ...(admin && (!original || original.admin_only !== draft.admin_only) ? { admin_only: draft.admin_only } : {}) });
      await stopEditing();
    });
  }
  async function archive() {
    if (!page || !canArchive) return;
    await run(async () => {
      await takeLock(page);
      try { await update(page, { is_archived: !page.is_archived }); }
      finally { await stopEditing(); }
    });
  }
  async function restore(revision: KnowledgeRevision) {
    if (!page || !canEdit || !window.confirm(t('kb.restoreConfirm'))) return;
    await run(async () => {
      await takeLock(page);
      try { await update(page, { body: revision.body }); setPreview(null); }
      finally { await stopEditing(); }
    });
  }
  async function remove() {
    if (!page || !canDelete || !window.confirm(t('kb.deleteConfirm', { title: page.title }))) return;
    await run(async () => {
      if (pages.some(p => p.parent_id === page.id)) throw new Error('kb_has_children');
      const result = await supabase.from('kb_pages').delete().eq('id', page.id).select('*').single();
      if (result.error) throw new Error(knowledgeDeleteErrorKey(result.error));
      if (!result.data) throw new Error('kb_conflict');
      setSelectedId(null); await refresh();
    });
  }
  // Pages a new page can go under: same scope, shared (not a private draft), editable, and not
  // already at the deepest level. Members may add subpages wherever they can edit.
  const depth = (id: string) => { let level = 0; let current = pages.find(p => p.id === id); while (current && level <= KNOWLEDGE_DEPTH) { level++; const parentId = current.parent_id; current = parentId ? pages.find(p => p.id === parentId) : undefined; } return level; };
  const parentChoices = pages.filter(p => (p.project_id || 'shared') === newScope && !p.is_archived && !knowledgeInsidePrivateDraft(pages, p.id)
    && !!actor && knowledgeCan(pages, p.id, actor, 'edit') && depth(p.id) < KNOWLEDGE_DEPTH);
  // The landing page's recent list follows the scope; no heading when the scope has no pages.
  const recentPages = visible.filter(candidate => scope === 'all' ? inLine(candidate.project_id) : (candidate.project_id || 'shared') === scope)
    .slice().sort((left, right) => right.updated_at.localeCompare(left.updated_at)).slice(0, 6);
  function openCreate(parent?: KnowledgePage) {
    setNewScope(parent ? parent.project_id || 'shared' : scope === 'all' ? 'shared' : scope);
    setNewParent(parent?.id || '');
    setNewCategory(parent?.category === 'meeting' || (!parent && category === 'meeting') ? 'meeting' : 'general');
    setNewPolicy({ mode: 'inherit' }); setCreating(true);
  }
  async function create() {
    await run(async () => {
      ensurePolicyKeepsView(newPolicy);
      // Name the page here and read it back afterwards: on Docker, RLS checks a returned
      // row with the page's inherited view permission, which cannot see a row that is
      // still being inserted, so asking for it back made every new page fail.
      const id = randomUUID();
      const result = await supabase.from('kb_pages').insert({ id, title: newTitle.trim(), body: '',
        project_id: newScope === 'shared' ? null : newScope, parent_id: newParent || null, category: newCategory, access_policy: newPolicy, created_by: currentMemberId, updated_by: currentMemberId });
      if (result.error) throw result.error;
      setCreating(false); setNewTitle(''); setNewParent(''); setScope(newScope); setCategory(newCategory); setNewPolicy({ mode: 'inherit' }); setQuery('');
      await refresh(); await selectPage(id);
    });
  }
  async function savePolicy(policy: KnowledgePolicy) {
    if (!admin) return;
    try { ensurePolicyKeepsView(policy, permissionTarget === 'page' ? page : undefined); }
    catch (failure) { report(failure); return; }
    if (permissionTarget === 'new') { setNewPolicy(policy); setPermissionTarget(null); return; }
    if (!page) return;
    await run(async () => {
      await takeLock(page);
      try { await update(page, { access_policy: policy }); setPermissionTarget(null); }
      finally { await stopEditing(); }
    });
  }
  function ensurePolicyKeepsView(policy: KnowledgePolicy, target?: KnowledgePage) {
    const candidate = { id: target?.id || 'new-knowledge-page', parent_id: target?.parent_id || null, access_policy: policy };
    if (!knowledgeCan([...pages.filter(p => p.id !== candidate.id), candidate], candidate.id, actor, 'view')) throw new Error('kb_self_lockout');
  }
  async function withFileLock(action: () => Promise<void>) {
    if (!page || !hasEditAccess) throw new Error('kb_forbidden');
    const transient = activeLock.current !== `kb:${page.id}`;
    await takeLock(page);
    try { await action(); }
    finally {
      if (transient) await stopEditing();
      await refresh();
    }
  }

  return <section className="flex-1 min-h-0 flex flex-col bg-gradient-to-b from-primary/[0.03] to-background">
    <header className="flex flex-wrap items-center justify-between gap-3 border-b px-4 md:px-6 py-4">
      <div className="flex items-center gap-3"><BookOpen className="text-primary" size={22} /><div>
        <h1 className="font-bold text-lg">{t('kb.title')}</h1><p className="text-xs text-muted-foreground">{t('kb.subtitle')}</p>
      </div></div>
      <div className="ml-auto flex flex-wrap items-center justify-end gap-2 max-w-full">
        <Button variant="outline" disabled={busy || !!draft || !actor} onClick={() => setWorkOpen(true)}>{t('knowledgeWork.workspaceTitle')}</Button>
        {importCapability.allowed && <Button variant="outline" disabled={busy || !!draft} onClick={() => { setImportTargetId(undefined); setImportOpen(true); }}>{t('kb.navigation.importFile', { defaultValue: 'Import document' })}</Button>}
        <Button disabled={busy || !!draft} onClick={() => openCreate()} className="shadow-sm gap-2"><Plus size={16} />{t('kb.newPage')}</Button>
      </div>
    </header>
    {error && <div role="alert" className="px-4 py-2 text-sm text-destructive">{t('kb.errors.kb_load_failed')} <button className="underline" onClick={() => void refresh()}>{t('kb.retry')}</button></div>}
    <div className="flex flex-1 min-h-0 overflow-hidden">
      <KnowledgeSidebar selected={!!selectedId} query={query} onQuery={setQuery} scope={scope} onScope={setScope} scopeOptions={filterScopeOptions} scopeLabel={scope === 'all' ? t('kb.allScopes') : scopeName(scope === 'shared' ? null : scope)} category={category} onCategory={setCategory} archived={showArchived} onArchived={setShowArchived}>
        <nav className="flex min-h-0 flex-1 flex-col" aria-label={t('kb.navigation.directory')}>
          {loading ? <p className="p-3 text-sm">{t('kb.loading')}</p> : <KnowledgeNavigation
            pages={query.trim() ? visible : treePages} groups={groups.filter(g => scope === 'all' || scope === g.id)} query={query}
            filtered={scope !== 'all' || category !== 'all'} selectedId={selectedId}
            onSelect={id => void selectPage(id)} navigation={navigation} busy={busy} scopeName={scopeName} />}

        </nav>
      </KnowledgeSidebar>
      <main className={`${selectedId ? 'flex' : 'hidden md:flex'} flex-col flex-1 min-w-0 overflow-auto p-4 md:p-7`}>
        {selectedId && <Button variant="ghost" className="md:hidden self-start mb-3 gap-2" disabled={busy} onClick={() => {
          if (!draft || window.confirm(t('kb.discard'))) {
            void stopEditing(); setSelectedId(null);
            const location = new URL(window.location.href); location.searchParams.delete('kb'); location.searchParams.delete('anchor');
            window.history.pushState({}, '', location); lastLocation.current = location.href;
          }
        }}><ArrowLeft size={16} />{t('kb.pages')}</Button>}
        {!page ? <div className="mx-auto my-auto w-full max-w-3xl py-6">
          <div className="mb-8 text-center text-muted-foreground"><BookOpen size={30} className="mx-auto mb-3 text-primary/60" /><h2 className="font-semibold text-foreground">{t(selectedId && !loading ? 'kb.sharing.unavailable' : 'kb.emptyTitle')}</h2><p className="mt-2 text-sm">{t('kb.emptyHint')}</p></div>
          {!selectedId && !loading && recentPages.length > 0 && <section aria-label={t('kb.navigation.recentPages')}><h3 className="mb-3 text-sm font-medium">{t('kb.navigation.recentPages')}</h3><div className="grid gap-3 lg:grid-cols-2">{recentPages.map(candidate => <button key={candidate.id} type="button" aria-label={t('kb.navigation.openRecent', { title: candidate.title })} className="flex items-start gap-3 rounded-xl border bg-card p-4 text-left transition-colors hover:border-primary/40 hover:bg-primary/5" onClick={() => void selectPage(candidate.id)}><FileText size={18} className="mt-0.5 shrink-0 text-primary" /><span className="min-w-0"><span className="block break-words text-sm font-medium">{candidate.title}</span><span className="mt-1.5 block text-xs text-muted-foreground">{scopeName(candidate.project_id)} · {t(`kb.categories.${candidate.category || 'general'}`)}</span></span></button>)}</div></section>}
        </div> : <div className="w-full max-w-5xl mx-auto space-y-5">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0"><p className="text-xs text-primary mb-2">{scopeName(page.project_id)} · {t(`kb.categories.${page.category || 'general'}`)}</p><h2 className="text-2xl font-bold break-words">{page.title}</h2>
              <p className="text-xs text-muted-foreground mt-2">{t('kb.updated', { name: users.find(u => u.id === page.updated_by)?.name || t('kb.member'), date: new Date(page.updated_at).toLocaleString() })}</p>
            </div>
            <div className="flex flex-wrap items-center gap-1">
              {draft ? <><Button disabled={busy || !draft.title.trim()} onClick={() => void save()}>{busy ? t('kb.saving') : t('kb.save')}</Button><Button variant="outline" disabled={busy} onClick={() => void stopEditing()}>{t('kb.cancel')}</Button></> : <>
                {/* Icons with hover labels; the one main action keeps its text. */}
                <KnowledgeShareActions page={page} scope={scopeName(page.project_id)} disabled={busy} onUnavailable={() => { void refresh(); }} />
                <KnowledgePageActions page={page} navigation={navigation} busy={busy} />
                <span className="mx-1 h-5 w-px bg-border" aria-hidden="true" />
                <IconAction label={t('kb.history')} pressed={showHistory} onClick={() => { setShowHistory(!showHistory); setPreview(null); }}><History size={16} /></IconAction>
                <IconAction label={t('knowledgeWork.documentStatus')} pressed={workPanelOpen} onClick={() => setWorkPanelOpen(value => !value)}><BadgeCheck size={16} /></IconAction>
                {admin && <IconAction label={t('kb.permissions.title')} disabled={busy || !!lockedBy} onClick={() => setPermissionTarget('page')}><ShieldCheck size={16} /></IconAction>}
                {(canEdit || canArchive || canDelete) && <DropdownMenu>
                  <DropdownMenuTrigger asChild><IconAction label={t('kb.moreActions')} disabled={busy}><MoreHorizontal size={16} /></IconAction></DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    {canEdit && !page.is_archived && !knowledgeInsidePrivateDraft(pages, page.id) && depth(page.id) < KNOWLEDGE_DEPTH && <DropdownMenuItem onSelect={() => openCreate(page)}><FilePlus size={15} />{t('kb.newChildPage')}</DropdownMenuItem>}
                    {canEdit && importCapability.allowed && <DropdownMenuItem onSelect={() => { setImportTargetId(page.id); setImportOpen(true); }}><FileUp size={15} />{t('kb.navigation.importVersion', { defaultValue: 'Import source revision' })}</DropdownMenuItem>}
                    {canArchive && <DropdownMenuItem disabled={!!lockedBy} onSelect={() => void archive()}>{page.is_archived ? <ArchiveRestore size={15} /> : <Archive size={15} />}{page.is_archived ? t('kb.unarchive') : t('kb.archive')}</DropdownMenuItem>}
                    {canDelete && <DropdownMenuItem className="text-destructive hover:text-destructive focus:text-destructive" onSelect={() => void remove()}><Trash2 size={15} />{t('kb.delete')}</DropdownMenuItem>}
                  </DropdownMenuContent>
                </DropdownMenu>}
                {canEdit && <Button disabled={busy} onClick={() => void edit()} className="ml-1 gap-2"><Pencil size={15} aria-hidden="true" />{t('kb.edit')}</Button>}
              </>}
            </div>
          </div>
          {lockedBy && <p role="status" className="text-sm rounded-lg bg-amber-500/10 p-3">{t('kb.editing', { name: lockedBy.name })}</p>}
          {page.is_archived && <p className="text-sm text-muted-foreground">{t('kb.archivedHint')}</p>}
          {page.access_policy?.mode === 'custom' && <p className="flex items-center gap-2 text-sm text-muted-foreground"><ShieldCheck size={14} />{t('kb.permissions.restricted')}</p>}
          {page.admin_only && <p className="flex items-center gap-2 text-sm text-muted-foreground"><Lock size={14} />{t('kb.adminOnly')}</p>}
          {page.private_draft_owner_id && <p className="text-sm text-muted-foreground">{t('knowledgeWork.privateDraft')}</p>}
          {workPanelOpen && <KnowledgeWorkPanel key={`${currentMemberId}:${page.id}`} client={workClient} pageId={page.id} pageVersion={page.version} parents={pages.filter(candidate => knowledgeCan(pages, candidate.id, actor, 'edit'))} disabled={busy || !!draft || !!lockedBy} onChanged={refresh} />}
          {draft ? <div className="rounded-xl border bg-card p-4 shadow-sm space-y-4">
            <label className="block text-sm space-y-1"><span>{t('kb.pageTitle')}</span><Input value={draft.title} maxLength={200} disabled={busy} onChange={e => setDraft({ ...draft, title: e.target.value })} /></label>
            <label className="flex flex-col gap-1 text-xs">{t('kb.category')}<SearchableSelect disabled={busy} className={selectStyle} value={draft.category || 'general'} onChange={e => setDraft({ ...draft, category: e.target.value as 'general' | 'meeting' })}><option value="general">{t('kb.categories.general')}</option><option value="meeting">{t('kb.categories.meeting')}</option></SearchableSelect></label>
            {/* Where the page sits, the team order and the edit lock are rarely changed: one collapsed section. */}
            <details className="rounded-lg border px-3 py-2">
              <summary className="cursor-pointer text-sm font-medium text-muted-foreground">{t('kb.placementSettings')}</summary>
              <div className="mt-3 space-y-3">
              <div className="grid sm:grid-cols-3 gap-3">
                <label className="flex flex-col gap-1 text-xs">{t('kb.scope')}<SearchableSelect disabled={busy || !admin} className={selectStyle} value={draft.project_id || 'shared'} onChange={e => setDraft({ ...draft, project_id: e.target.value === 'shared' ? null : e.target.value, parent_id: null })}>{scopeOptions}</SearchableSelect></label>
                <label className="flex flex-col gap-1 text-xs">{t('kb.parent')}<SearchableSelect disabled={busy || !admin} className={selectStyle} value={draft.parent_id || ''} onChange={e => setDraft({ ...draft, parent_id: e.target.value || null })}>
                  <option value="">{t('kb.noParent')}</option>{pages.filter(p => p.id !== draft.id && p.project_id === draft.project_id && (!p.is_archived || p.id === draft.parent_id)
                    // A shared page cannot be moved into a private draft.
                    && (p.id === draft.parent_id || knowledgeInsidePrivateDraft(pages, draft.id) || !knowledgeInsidePrivateDraft(pages, p.id))).map(p => <option key={p.id} value={p.id}>{p.title}</option>)}
                </SearchableSelect></label>
                <label className="flex flex-col gap-1 text-xs">{t('kb.order')}<Input disabled={busy} type="number" step="1" value={draft.sort_order} onChange={e => setDraft({ ...draft, sort_order: Number(e.target.value) })} /></label>
              </div>
              {admin && <p className="text-xs text-muted-foreground">{t('kb.permissions.moveHint')}</p>}
              {admin && <label className="flex items-center gap-2 text-sm"><input disabled={busy} type="checkbox" checked={draft.admin_only} onChange={e => setDraft({ ...draft, admin_only: e.target.checked })} />{t('kb.adminOnlyOption')}</label>}
              </div>
            </details>
            <p className="text-xs text-muted-foreground">{t('kb.privateFilesHint')}</p>
            <RichTextEditor content={draft.body} onChange={body => setDraft(d => d ? { ...d, body } : d)} editable={!busy && !lockedBy && hasEditAccess} allowImageUpload={false} members={users} />
          </div> : <KnowledgeReadingBody body={page.body || `<p>${t('kb.emptyBody')}</p>`} meeting={page.category === 'meeting'} />}
          {!draft && <KnowledgeWorkflowPanel key={`${page.id}:workflow`} pageId={page.id} canEdit={canEdit} category={page.category} pageProjectId={page.project_id} />}
          {/* Shown while editing too: the source versions are what an edit is checked against. */}
          <KnowledgeImportSources key={`${page.id}:sources`} pageId={page.id} />
          {/* History opens beside the page instead of far below it. */}
          <Sheet open={showHistory} onOpenChange={open => { setShowHistory(open); if (!open) setPreview(null); }}>
            <SheetContent className="w-full overflow-y-auto sm:max-w-xl" style={IS_DEMO_PRO ? { top: DEMO_BANNER_HEIGHT } : undefined} aria-describedby={undefined}>
              <SheetHeader><SheetTitle>{t('kb.history')}</SheetTitle></SheetHeader>
              <p className="mt-1 text-xs text-muted-foreground">{t('kb.historyHint')}</p>
              {!revisions.length && <p className="mt-4 text-sm text-muted-foreground">{t('kb.noHistory')}</p>}
              <div className="mt-4 space-y-1">{revisions.map(r => <div key={r.id} className={`flex flex-wrap items-center justify-between gap-2 rounded-md p-2 text-sm ${preview?.id === r.id ? 'bg-primary/10' : 'bg-muted/40'}`}>
                <button className="text-left hover:underline" aria-pressed={preview?.id === r.id} onClick={() => setPreview(r)}>{t('kb.version', { version: r.version })} · {new Date(r.created_at).toLocaleString()} · {users.find(u => u.id === r.created_by)?.name || t('kb.member')}</button>
                {canEdit && !draft && <Button size="sm" variant="outline" disabled={busy} onClick={() => void restore(r)}>{t('kb.restore')}</Button>}
              </div>)}</div>
              {preview && <article className={`${KNOWLEDGE_READING_STYLE} mt-4 border-t pt-4`} dangerouslySetInnerHTML={{ __html: renderKnowledgeHtml(preview.body) }} />}
            </SheetContent>
          </Sheet>
          {/* Readers see attachments only when there are some; the size limit sits on the upload button. */}
          {(canEdit || attachments.length > 0) && <section className="rounded-xl border bg-card p-4 shadow-sm space-y-3">
            <div className="flex items-center justify-between gap-2"><h3 className="font-semibold flex items-center gap-2"><Paperclip size={16} />{t('kb.attachments')}{attachments.length > 0 && <span className="text-sm font-normal text-muted-foreground">({attachments.length})</span>}</h3>
              {canEdit && <Button size="sm" variant="outline" disabled={busy} title={t('kb.fileLimit', { size: MAX_UPLOAD_MB })} onClick={() => fileInput.current?.click()}>{t('kb.upload')}</Button>}
            </div>
            <input ref={fileInput} type="file" multiple className="hidden" aria-label={t('kb.upload')} onChange={e => {
              const files = Array.from(e.target.files || []); e.target.value = '';
              void run(() => withFileLock(async () => { for (const file of files) await uploadKnowledgeFile(page.id, currentMemberId, file); }));
            }} />
            {!attachments.length && <p className="text-sm text-muted-foreground">{t('kb.noFiles')}</p>}
            {attachments.map(file => <div key={file.id} className="flex items-center gap-3 text-sm border-t pt-2">
              <button disabled={busy} className="flex-1 min-w-0 truncate text-left text-primary hover:underline" onClick={() => void run(() => downloadKnowledgeFile(file))}>{file.file_name}</button>
              <span className="text-xs text-muted-foreground">{(file.file_size / 1024).toFixed(1)} KB</span>
              {canEdit && <Button size="icon" variant="ghost" disabled={busy} aria-label={t('kb.deleteFile', { name: file.file_name })} onClick={() => {
                if (!window.confirm(t('kb.deleteFile', { name: file.file_name }))) return;
                void run(() => withFileLock(async () => {
                  const removed = await supabase.storage.from(file.storage_bucket || 'task-images').remove([file.storage_path]);
                  if (removed.error) throw removed.error;
                  const result = await supabase.from('kb_attachments').delete().eq('id', file.id).select('*').single();
                  if (result.error) throw result.error;
                }));
              }}><Trash2 size={14} /></Button>}
            </div>)}
          </section>}
          <KnowledgeComments key={`${page.id}:${currentMemberId}`} pageId={page.id} comments={comments} memberId={currentMemberId} users={users} canComment={canComment} canEdit={hasEditAccess} onChanged={refresh} report={report} />
        </div>}
      </main>
    </div>
    <Dialog open={creating} onOpenChange={open => { if (!busy) setCreating(open); }}><DialogContent aria-describedby={undefined}><DialogHeader><DialogTitle>{t('kb.newPage')}</DialogTitle></DialogHeader>
      <form onSubmit={e => { e.preventDefault(); void create(); }} className="space-y-4">
        <label className="block space-y-1 text-sm"><span>{t('kb.pageTitle')}</span><Input autoFocus required maxLength={200} value={newTitle} disabled={busy} onChange={e => setNewTitle(e.target.value)} /></label>
        <label className="flex flex-col gap-1 text-sm">{t('kb.scope')}<SearchableSelect className={selectStyle} value={newScope} disabled={busy} onChange={e => { setNewScope(e.target.value); setNewParent(''); }}>{scopeOptions}</SearchableSelect></label>
        <label className="flex flex-col gap-1 text-sm">{t('kb.parentForNew')}<SearchableSelect className={selectStyle} value={newParent} disabled={busy} onChange={e => setNewParent(e.target.value)}>
          <option value="">{t('kb.noParent')}</option>{parentChoices.map(p => <option key={p.id} value={p.id}>{p.title}</option>)}
        </SearchableSelect></label>
        <label className="flex flex-col gap-1 text-sm">{t('kb.category')}<SearchableSelect className={selectStyle} value={newCategory} disabled={busy} onChange={e => setNewCategory(e.target.value as 'general' | 'meeting')}><option value="general">{t('kb.categories.general')}</option><option value="meeting">{t('kb.categories.meeting')}</option></SearchableSelect></label>
        <div className="flex items-center justify-between gap-2 text-sm"><span>{t(newPolicy.mode === 'custom' ? 'kb.permissions.custom' : 'kb.permissions.inherit')}</span>{admin && <Button type="button" variant="outline" onClick={() => setPermissionTarget('new')}>{t('kb.permissions.title')}</Button>}</div>
        <DialogFooter><Button type="submit" disabled={busy || !newTitle.trim()}>{busy ? t('kb.saving') : t('kb.create')}</Button></DialogFooter>
      </form>
    </DialogContent></Dialog>
    {importOpen && member && <KnowledgeImportDialog open={importOpen} onOpenChange={setImportOpen} pages={pages} users={users} actor={member} initialTargetId={importTargetId} onImported={ids => { void refresh().then(() => { if (ids[0]) void selectPage(ids[0]); }); }} />}
    <KnowledgePermissionsDialog open={!!permissionTarget} onOpenChange={open => { if (!open) setPermissionTarget(null); }} policy={permissionTarget === 'new' ? newPolicy : pagePolicy} users={users} currentMemberId={currentMemberId || ''} hasParent={permissionTarget === 'page' && !!page?.parent_id} privateDraft={permissionTarget === 'page' && !!page?.private_draft_owner_id} busy={busy} onSave={savePolicy} />
    {workOpen && actor && <KnowledgeWorkSpace key={currentMemberId} client={workClient} projectId={scope === 'all' || scope === 'shared' ? undefined : scope} onClose={() => setWorkOpen(false)} onSaved={async () => { await refresh(); }} onOpenDraft={async id => { await refresh(); await selectPage(id); setWorkPanelOpen(true); setWorkOpen(false); }} onOpen={async (item: KnowledgeSearchItem) => {
      if (item.kind === 'knowledge' || item.kind === 'knowledge_file') { await selectPage(item.pageId || item.id); setWorkPanelOpen(true); setWorkOpen(false); }
      else { const target = new URL(window.location.href); target.search = ''; if (item.issueId) target.searchParams.set('qa', item.issueId); else if (item.taskKey) target.searchParams.set('task', item.taskKey); else { toast.error(t('knowledgeWork.errors.knowledge_source_unavailable')); return; } window.location.assign(target.toString()); }
    }} />}
  </section>;
}
