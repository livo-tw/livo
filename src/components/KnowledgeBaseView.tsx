import { SearchableSelect } from '@/components/ui/searchable-select';
import { ProjectSelectOptions } from '@/components/project/ProjectOptions';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { BookOpen, Plus, Search, History, Lock, Paperclip, Trash2, ArrowLeft, ShieldCheck } from 'lucide-react';
import { renderKnowledgeHtml } from '@/lib/knowledgeHtml';
import { toast } from 'sonner';
import { useAuthContext } from '@/context/AuthContext';
import { useProjectContext } from '@/context/ProjectContext';
import { useMemberContext } from '@/context/MemberContext';
import { usePresenceLock } from '@/hooks/usePresenceLock';
import { useKnowledgeBase, uploadKnowledgeFile, downloadKnowledgeFile } from '@/hooks/useKnowledgeBase';
import { validateKnowledgeTree } from '@/lib/knowledge';
import KnowledgeNavigation, { KnowledgePageActions } from '@/components/knowledge/KnowledgeNavigation';
import KnowledgeReadingBody, { KNOWLEDGE_READING_STYLE } from '@/components/knowledge/KnowledgeReadingBody';
import { KnowledgeWorkflowPanel } from '@/components/knowledge/KnowledgeWorkflowPanel';
import { useKnowledgeNavigation } from '@/hooks/useKnowledgeNavigation';
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
import { knowledgeCan, parseKnowledgePolicy } from '../../worker/src/knowledgeAccess';
import type { KnowledgePage, KnowledgeRevision, KnowledgePolicy } from '@/types/knowledge';

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
  const [newPolicy, setNewPolicy] = useState<KnowledgePolicy>({ mode: 'inherit' });
  const [permissionTarget, setPermissionTarget] = useState<'page' | 'new' | null>(null);
  const [showArchived, setShowArchived] = useState(false);
  const [draft, setDraft] = useState<KnowledgePage | null>(null);
  const [busy, setBusy] = useState(false);
  const draftRef = useRef(draft); draftRef.current = draft;
  const lastLocation = useRef(window.location.href);
  const [showHistory, setShowHistory] = useState(false);
  const [preview, setPreview] = useState<KnowledgeRevision | null>(null);
  const [creating, setCreating] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [importTargetId, setImportTargetId] = useState<string | undefined>(undefined);
  const [newTitle, setNewTitle] = useState('');
  const [newScope, setNewScope] = useState(selectedProjectId || 'shared');
  const fileInput = useRef<HTMLInputElement>(null);
  const member = users.find(u => u.id === currentMemberId) || currentMember;
  const actor = member && currentMemberId ? { id: currentMemberId, role: member.role || currentMember?.role || '', jobTitle: member.jobTitle || '', is_active: member.isActive !== false } : null;
  const { pages, attachments, revisions, comments, loading, error, refresh } = useKnowledgeBase(selectedId, actor);
  const importCapability = useKnowledgeImportCapability(JSON.stringify(actor));
  const locks = usePresenceLock('knowledge-base');
  const activeLock = useRef<string | null>(null);
  const admin = actor?.role === 'admin' || actor?.role === 'super_admin';
  const page = pages.find(p => p.id === selectedId);
  const lockedBy = page ? locks.isLockedBy(`kb:${page.id}`) : null;
  const hasEditAccess = !!page && knowledgeCan(pages, page.id, actor, 'edit');
  const canEdit = hasEditAccess && !lockedBy;
  const canArchive = !!page && admin && knowledgeCan(pages.map(p => p.id === page.id ? { ...p, is_archived: false } : p), page.id, actor, 'edit') && !lockedBy;
  const canComment = !!page && knowledgeCan(pages, page.id, actor, 'comment');
  const canDelete = !!page && canEdit && (admin || page.created_by === currentMemberId);
  const pagePolicy = useMemo(() => parseKnowledgePolicy(page?.access_policy) || { mode: 'inherit' } as KnowledgePolicy, [page?.access_policy]);
  const scopeName = (id: string | null) => id ? allProjects.find(p => p.id === id)?.name || t('kb.unknownProject') : t('kb.shared');
  const visible = pages.filter(p => (showArchived || !p.is_archived) && (category === 'all' || (p.category || 'general') === category));
  const navigation = useKnowledgeNavigation(currentMemberId || '', pages);
  const groups = [{ id: 'shared', name: t('kb.shared') }, ...allProjects.filter(p => !p.isArchived).map(p => ({ id: p.id, name: p.name }))];
  const projectGroups = useMemo(() => groupProjectsByLine(productLines, allProjects), [productLines, allProjects]);
  const scopeOptions = <>
    <option value="shared">{t('kb.shared')}</option>
    <ProjectSelectOptions groups={projectGroups} />
  </>;

  useEffect(() => { setScope(selectedProjectId || 'all'); }, [selectedProjectId]);

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
    if (selectedId && !loading && !page) {
      setSelectedId(null); setPreview(null); setShowHistory(false); setPermissionTarget(null);
      void stopEditing();
    } else if (draft && !hasEditAccess) {
      void stopEditing();
    }
  }, [selectedId, page, loading, hasEditAccess, draft]);

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
      await update(draft, { title: draft.title.trim(), body: draft.body, project_id: draft.project_id,
        parent_id: draft.parent_id, sort_order: draft.sort_order, category: draft.category || 'general', ...(admin ? { admin_only: draft.admin_only } : {}) });
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
      if (result.error || !result.data) throw result.error || new Error('kb_conflict');
      setSelectedId(null); await refresh();
    });
  }
  async function create() {
    await run(async () => {
      ensurePolicyKeepsView(newPolicy);
      const result = await supabase.from('kb_pages').insert({ title: newTitle.trim(), body: '',
        project_id: newScope === 'shared' ? null : newScope, category: newCategory, access_policy: newPolicy, created_by: currentMemberId, updated_by: currentMemberId }).select('*').single();
      if (result.error || !result.data) throw result.error || new Error('kb_failed');
      setCreating(false); setNewTitle(''); setScope(newScope); setCategory(newCategory); setNewPolicy({ mode: 'inherit' }); setQuery('');
      await refresh(); await selectPage(result.data.id);
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
        {importCapability.allowed && <Button variant="outline" disabled={busy || !!draft} onClick={() => { setImportTargetId(undefined); setImportOpen(true); }}>{t('kb.navigation.importFile', { defaultValue: 'Import document' })}</Button>}
        <Button disabled={busy || !!draft} onClick={() => { setNewScope(scope === 'all' ? 'shared' : scope); setNewCategory(category === 'meeting' ? 'meeting' : 'general'); setNewPolicy({ mode: 'inherit' }); setCreating(true); }} className="shadow-sm gap-2"><Plus size={16} />{t('kb.newPage')}</Button>
      </div>
    </header>
    {error && <div role="alert" className="px-4 py-2 text-sm text-destructive">{t('kb.errors.kb_load_failed')} <button className="underline" onClick={() => void refresh()}>{t('kb.retry')}</button></div>}
    <div className="flex flex-1 min-h-0 overflow-hidden">
      <aside className={`${selectedId ? 'hidden md:flex' : 'flex'} w-full md:w-72 shrink-0 flex-col border-r bg-card/60`} aria-label={t('kb.pages')}>
        <div className="p-3 space-y-3 border-b">
          <div className="relative"><Search size={15} className="absolute left-3 top-3 text-muted-foreground" /><Input value={query} onChange={e => setQuery(e.target.value)} placeholder={t('kb.search')} aria-label={t('kb.search')} className="pl-9" /></div>
          <SearchableSelect className={`${selectStyle} w-full`} aria-label={t('kb.scope')} value={scope} onChange={e => setScope(e.target.value)}>
            <option value="all">{t('kb.allScopes')}</option>{scopeOptions}
          </SearchableSelect>
          <SearchableSelect className={`${selectStyle} w-full`} aria-label={t('kb.category')} value={category} onChange={e => setCategory(e.target.value as typeof category)}>
            <option value="all">{t('kb.allCategories')}</option><option value="general">{t('kb.categories.general')}</option><option value="meeting">{t('kb.categories.meeting')}</option>
          </SearchableSelect>
          <label className="flex gap-2 text-xs text-muted-foreground"><input type="checkbox" checked={showArchived} onChange={e => setShowArchived(e.target.checked)} />{t('kb.showArchived')}</label>
        </div>
        <nav className="overflow-auto flex-1 p-2">
          {loading ? <p className="p-3 text-sm">{t('kb.loading')}</p> : <KnowledgeNavigation
            pages={visible} groups={groups.filter(g => scope === 'all' || scope === g.id)} query={query}
            filtered={scope !== 'all' || category !== 'all'} selectedId={selectedId}
            onSelect={id => void selectPage(id)} navigation={navigation} busy={busy} scopeName={scopeName} />}

        </nav>
      </aside>
      <main className={`${selectedId ? 'flex' : 'hidden md:flex'} flex-col flex-1 min-w-0 overflow-auto p-4 md:p-7`}>
        {selectedId && <Button variant="ghost" className="md:hidden self-start mb-3 gap-2" disabled={busy} onClick={() => {
          if (!draft || window.confirm(t('kb.discard'))) {
            void stopEditing(); setSelectedId(null);
            const location = new URL(window.location.href); location.searchParams.delete('kb'); location.searchParams.delete('anchor');
            window.history.pushState({}, '', location); lastLocation.current = location.href;
          }
        }}><ArrowLeft size={16} />{t('kb.pages')}</Button>}
        {!page ? <div className="m-auto text-center max-w-sm text-muted-foreground"><BookOpen size={36} className="mx-auto mb-4 text-primary/60" /><h2 className="font-semibold text-foreground">{t('kb.emptyTitle')}</h2><p className="text-sm mt-2">{t('kb.emptyHint')}</p></div> : <div className="w-full max-w-5xl mx-auto space-y-5">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0"><p className="text-xs text-primary mb-2">{scopeName(page.project_id)} · {t(`kb.categories.${page.category || 'general'}`)}</p><h2 className="text-2xl font-bold break-words">{page.title}</h2>
              <p className="text-xs text-muted-foreground mt-2">{t('kb.updated', { name: users.find(u => u.id === page.updated_by)?.name || t('kb.member'), date: new Date(page.updated_at).toLocaleString() })}</p>
            </div>
            <div className="flex flex-wrap gap-2">
              {!draft && <KnowledgePageActions page={page} navigation={navigation} busy={busy} />}
              {draft ? <><Button disabled={busy || !draft.title.trim()} onClick={() => void save()}>{busy ? t('kb.saving') : t('kb.save')}</Button><Button variant="outline" disabled={busy} onClick={() => void stopEditing()}>{t('kb.cancel')}</Button></> : <>
                <Button variant="outline" onClick={() => { setShowHistory(!showHistory); setPreview(null); }} className="gap-2"><History size={15} />{t('kb.history')}</Button>
                {canEdit && <Button disabled={busy} onClick={() => void edit()}>{t('kb.edit')}</Button>}
                {canEdit && importCapability.allowed && <Button variant="outline" disabled={busy} onClick={() => { setImportTargetId(page.id); setImportOpen(true); }}>{t('kb.navigation.importVersion', { defaultValue: 'Import source revision' })}</Button>}
                {admin && <Button variant="outline" disabled={busy || !!lockedBy} onClick={() => setPermissionTarget('page')} className="gap-2"><ShieldCheck size={15} />{t('kb.permissions.title')}</Button>}
                {canArchive && <Button variant="outline" disabled={busy || !!lockedBy} onClick={() => void archive()}>{page.is_archived ? t('kb.unarchive') : t('kb.archive')}</Button>}
                {canDelete && <Button variant="ghost" disabled={busy} aria-label={t('kb.delete')} onClick={() => void remove()}><Trash2 size={16} /></Button>}
              </>}
            </div>
          </div>
          {lockedBy && <p role="status" className="text-sm rounded-lg bg-amber-500/10 p-3">{t('kb.editing', { name: lockedBy.name })}</p>}
          {page.is_archived && <p className="text-sm text-muted-foreground">{t('kb.archivedHint')}</p>}
          {page.access_policy?.mode === 'custom' && <p className="flex items-center gap-2 text-sm text-muted-foreground"><ShieldCheck size={14} />{t('kb.permissions.restricted')}</p>}
          {page.admin_only && <p className="flex items-center gap-2 text-sm text-muted-foreground"><Lock size={14} />{t('kb.adminOnly')}</p>}
          {draft ? <div className="rounded-xl border bg-card p-4 shadow-sm space-y-4">
            <label className="block text-sm space-y-1"><span>{t('kb.pageTitle')}</span><Input value={draft.title} maxLength={200} disabled={busy} onChange={e => setDraft({ ...draft, title: e.target.value })} /></label>
            <div className="grid sm:grid-cols-3 gap-3">
              <label className="flex flex-col gap-1 text-xs">{t('kb.scope')}<SearchableSelect disabled={busy || !admin} className={selectStyle} value={draft.project_id || 'shared'} onChange={e => setDraft({ ...draft, project_id: e.target.value === 'shared' ? null : e.target.value, parent_id: null })}>{scopeOptions}</SearchableSelect></label>
              <label className="flex flex-col gap-1 text-xs">{t('kb.parent')}<SearchableSelect disabled={busy || !admin} className={selectStyle} value={draft.parent_id || ''} onChange={e => setDraft({ ...draft, parent_id: e.target.value || null })}>
                <option value="">{t('kb.noParent')}</option>{pages.filter(p => p.id !== draft.id && p.project_id === draft.project_id && (!p.is_archived || p.id === draft.parent_id)).map(p => <option key={p.id} value={p.id}>{p.title}</option>)}
              </SearchableSelect></label>
              <label className="flex flex-col gap-1 text-xs">{t('kb.order')}<Input disabled={busy} type="number" step="1" value={draft.sort_order} onChange={e => setDraft({ ...draft, sort_order: Number(e.target.value) })} /></label>
            </div>
            <p className="text-xs text-muted-foreground">{t('kb.permissions.moveHint')}</p>
            <label className="flex flex-col gap-1 text-xs">{t('kb.category')}<SearchableSelect disabled={busy} className={selectStyle} value={draft.category || 'general'} onChange={e => setDraft({ ...draft, category: e.target.value as 'general' | 'meeting' })}><option value="general">{t('kb.categories.general')}</option><option value="meeting">{t('kb.categories.meeting')}</option></SearchableSelect></label>
            {admin && <label className="flex items-center gap-2 text-sm"><input disabled={busy} type="checkbox" checked={draft.admin_only} onChange={e => setDraft({ ...draft, admin_only: e.target.checked })} />{t('kb.adminOnly')}</label>}
            <p className="text-xs text-muted-foreground">{t('kb.privateFilesHint')}</p>
            <RichTextEditor content={draft.body} onChange={body => setDraft(d => d ? { ...d, body } : d)} editable={!busy && !lockedBy && hasEditAccess} allowImageUpload={false} members={users} />
          </div> : <KnowledgeReadingBody body={page.body || `<p>${t('kb.emptyBody')}</p>`} meeting={page.category === 'meeting'} />}
          {!draft && <KnowledgeWorkflowPanel key={`${page.id}:workflow`} pageId={page.id} canEdit={canEdit} />}
          {!draft && <KnowledgeImportSources key={`${page.id}:sources`} pageId={page.id} />}
          {showHistory && <section className="rounded-xl border bg-card shadow-sm p-4 space-y-3" aria-label={t('kb.history')}>
            <h3 className="font-semibold">{t('kb.history')}</h3><p className="text-xs text-muted-foreground">{t('kb.historyHint')}</p>
            {!revisions.length && <p className="text-sm text-muted-foreground">{t('kb.noHistory')}</p>}
            <div className="max-h-56 overflow-auto space-y-1">{revisions.map(r => <div key={r.id} className="flex flex-wrap items-center justify-between gap-2 rounded-md bg-muted/40 p-2 text-sm">
              <button className="text-left hover:underline" onClick={() => setPreview(r)}>{t('kb.version', { version: r.version })} · {new Date(r.created_at).toLocaleString()} · {users.find(u => u.id === r.created_by)?.name || t('kb.member')}</button>
              {canEdit && !draft && <Button size="sm" variant="outline" disabled={busy} onClick={() => void restore(r)}>{t('kb.restore')}</Button>}
            </div>)}</div>
            {preview && <article className={`${KNOWLEDGE_READING_STYLE} border-t pt-3`} dangerouslySetInnerHTML={{ __html: renderKnowledgeHtml(preview.body) }} />}
          </section>}
          <section className="rounded-xl border bg-card p-4 shadow-sm space-y-3">
            <div className="flex items-center justify-between gap-2"><h3 className="font-semibold flex items-center gap-2"><Paperclip size={16} />{t('kb.attachments')}</h3>
              {canEdit && <Button size="sm" variant="outline" disabled={busy} onClick={() => fileInput.current?.click()}>{t('kb.upload')}</Button>}
            </div><p className="text-xs text-muted-foreground">{t('kb.fileLimit', { size: MAX_UPLOAD_MB })}</p>
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
          </section>
          <KnowledgeComments key={`${page.id}:${currentMemberId}`} pageId={page.id} comments={comments} memberId={currentMemberId} users={users} canComment={canComment} canEdit={hasEditAccess} onChanged={refresh} report={report} />
        </div>}
      </main>
    </div>
    <Dialog open={creating} onOpenChange={open => { if (!busy) setCreating(open); }}><DialogContent aria-describedby={undefined}><DialogHeader><DialogTitle>{t('kb.newPage')}</DialogTitle></DialogHeader>
      <form onSubmit={e => { e.preventDefault(); void create(); }} className="space-y-4">
        <label className="block space-y-1 text-sm"><span>{t('kb.pageTitle')}</span><Input autoFocus required maxLength={200} value={newTitle} disabled={busy} onChange={e => setNewTitle(e.target.value)} /></label>
        <label className="flex flex-col gap-1 text-sm">{t('kb.scope')}<SearchableSelect className={selectStyle} value={newScope} disabled={busy} onChange={e => setNewScope(e.target.value)}>{scopeOptions}</SearchableSelect></label>
        <label className="flex flex-col gap-1 text-sm">{t('kb.category')}<SearchableSelect className={selectStyle} value={newCategory} disabled={busy} onChange={e => setNewCategory(e.target.value as 'general' | 'meeting')}><option value="general">{t('kb.categories.general')}</option><option value="meeting">{t('kb.categories.meeting')}</option></SearchableSelect></label>
        <div className="flex items-center justify-between gap-2 text-sm"><span>{t(newPolicy.mode === 'custom' ? 'kb.permissions.custom' : 'kb.permissions.inherit')}</span>{admin && <Button type="button" variant="outline" onClick={() => setPermissionTarget('new')}>{t('kb.permissions.title')}</Button>}</div>
        <DialogFooter><Button type="submit" disabled={busy || !newTitle.trim()}>{busy ? t('kb.saving') : t('kb.create')}</Button></DialogFooter>
      </form>
    </DialogContent></Dialog>
    {importOpen && member && <KnowledgeImportDialog open={importOpen} onOpenChange={setImportOpen} pages={pages} users={users} actor={member} initialTargetId={importTargetId} onImported={ids => { void refresh().then(() => { if (ids[0]) void selectPage(ids[0]); }); }} />}
    <KnowledgePermissionsDialog open={!!permissionTarget} onOpenChange={open => { if (!open) setPermissionTarget(null); }} policy={permissionTarget === 'new' ? newPolicy : pagePolicy} users={users} hasParent={permissionTarget === 'page' && !!page?.parent_id} busy={busy} onSave={savePolicy} />
  </section>;
}
