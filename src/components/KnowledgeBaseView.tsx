import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { BookOpen, Plus, Search, FileText, History, Lock, Paperclip, Trash2, ArrowLeft } from 'lucide-react';
import { renderKnowledgeHtml } from '@/lib/knowledgeHtml';
import { toast } from 'sonner';
import { useAuthContext } from '@/context/AuthContext';
import { useProjectContext } from '@/context/ProjectContext';
import { useMemberContext } from '@/context/MemberContext';
import { usePresenceLock } from '@/hooks/usePresenceLock';
import { useKnowledgeBase, uploadKnowledgeFile } from '@/hooks/useKnowledgeBase';
import { buildKnowledgeTree, knowledgeSnippet, searchKnowledge, validateKnowledgeTree, type KnowledgeNode } from '@/lib/knowledge';
import { groupProjectsByLine, projectGroupLabel } from '@/lib/projectGroups';
import { MAX_UPLOAD_MB } from '@/lib/uploadLimits';
import { knowledgeClient as supabase } from '@/integrations/supabase/knowledgeClient';
import RichTextEditor from '@/components/RichTextEditorLazy';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import type { KnowledgePage, KnowledgeRevision } from '@/types/knowledge';

const selectStyle = 'h-9 rounded-md border border-input bg-background px-2 text-sm min-w-0';

export default function KnowledgeBaseView() {
  const { t } = useTranslation();
  const { currentMemberId, currentMember } = useAuthContext();
  const { allProjects, productLines, selectedProjectId } = useProjectContext();
  const { users } = useMemberContext();
  const [scope, setScope] = useState(selectedProjectId || 'all');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [showArchived, setShowArchived] = useState(false);
  const [draft, setDraft] = useState<KnowledgePage | null>(null);
  const [busy, setBusy] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  const [preview, setPreview] = useState<KnowledgeRevision | null>(null);
  const [creating, setCreating] = useState(false);
  const [newTitle, setNewTitle] = useState('');
  const [newScope, setNewScope] = useState(selectedProjectId || 'shared');
  const fileInput = useRef<HTMLInputElement>(null);
  const { pages, attachments, revisions, loading, error, refresh } = useKnowledgeBase(selectedId);
  const locks = usePresenceLock('knowledge-base');
  const activeLock = useRef<string | null>(null);
  const admin = currentMember?.role === 'admin' || currentMember?.role === 'super_admin';
  const page = pages.find(p => p.id === selectedId);
  const lockedBy = page ? locks.isLockedBy(`kb:${page.id}`) : null;
  const canEdit = !!page && !page.is_archived && (!page.admin_only || admin) && !lockedBy;
  const canDelete = !!page && (admin || page.created_by === currentMemberId) && !lockedBy;
  const scopeName = (id: string | null) => id ? allProjects.find(p => p.id === id)?.name || t('kb.unknownProject') : t('kb.shared');
  const visible = pages.filter(p => showArchived || !p.is_archived);
  const results = useMemo(() => searchKnowledge(visible, query), [pages, query, showArchived]);
  const groups = [{ id: 'shared', name: t('kb.shared') }, ...allProjects.filter(p => !p.isArchived).map(p => ({ id: p.id, name: p.name }))];
  const projectGroups = useMemo(() => groupProjectsByLine(productLines, allProjects), [productLines, allProjects]);
  const scopeOptions = <>
    <option value="shared">{t('kb.shared')}</option>
    {projectGroups.map(group => (
      <optgroup key={group.line?.id ?? 'other'} label={projectGroupLabel(group.line, t('common.other'))}>
        {group.projects.map(project => <option key={project.id} value={project.id}>{project.name}</option>)}
      </optgroup>
    ))}
  </>;

  useEffect(() => { setScope(selectedProjectId || 'all'); }, [selectedProjectId]);

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
  }
  async function takeLock(target: KnowledgePage) {
    const key = `kb:${target.id}`;
    const acquired = await locks.acquireLock(key);
    if (!acquired.acquired) throw new Error('kb_conflict');
    activeLock.current = key;
  }
  async function edit() {
    if (!page) return;
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
    if (!draft) return;
    await run(async () => {
      validateKnowledgeTree(pages.map(p => p.id === draft.id ? draft : p));
      await update(draft, { title: draft.title.trim(), body: draft.body, project_id: draft.project_id,
        parent_id: draft.parent_id, sort_order: draft.sort_order, ...(admin ? { admin_only: draft.admin_only } : {}) });
      await stopEditing();
    });
  }
  async function archive() {
    if (!page) return;
    await run(async () => {
      await takeLock(page);
      try { await update(page, { is_archived: !page.is_archived }); }
      finally { await stopEditing(); }
    });
  }
  async function restore(revision: KnowledgeRevision) {
    if (!page || !window.confirm(t('kb.restoreConfirm'))) return;
    await run(async () => {
      await takeLock(page);
      try { await update(page, { body: revision.body }); setPreview(null); }
      finally { await stopEditing(); }
    });
  }
  async function remove() {
    if (!page || !window.confirm(t('kb.deleteConfirm', { title: page.title }))) return;
    await run(async () => {
      if (pages.some(p => p.parent_id === page.id)) throw new Error('kb_has_children');
      const result = await supabase.from('kb_pages').delete().eq('id', page.id).select('*').single();
      if (result.error || !result.data) throw result.error || new Error('kb_conflict');
      setSelectedId(null); await refresh();
    });
  }
  async function create() {
    await run(async () => {
      const result = await supabase.from('kb_pages').insert({ title: newTitle.trim(), body: '',
        project_id: newScope === 'shared' ? null : newScope, created_by: currentMemberId, updated_by: currentMemberId }).select('*').single();
      if (result.error || !result.data) throw result.error || new Error('kb_failed');
      setCreating(false); setNewTitle(''); setScope(newScope); setQuery('');
      await refresh(); setSelectedId(result.data.id);
    });
  }
  async function withFileLock(action: () => Promise<void>) {
    if (!page) return;
    const transient = activeLock.current !== `kb:${page.id}`;
    await takeLock(page);
    try { await action(); }
    finally {
      if (transient) await stopEditing();
      await refresh();
    }
  }
  const renderTree = (nodes: KnowledgeNode[], depth = 0) => nodes.map(node => (
    <li key={node.id}>
      <button disabled={busy} onClick={() => void selectPage(node.id)} aria-current={node.id === selectedId ? 'page' : undefined}
        className={`my-0.5 w-full flex items-center gap-2 rounded-lg px-3 py-2 text-left text-sm transition-colors ${node.id === selectedId ? 'bg-primary/15 text-primary font-semibold shadow-sm' : 'hover:bg-muted text-foreground'}`}
        style={{ paddingLeft: `${12 + depth * 14}px` }}>
        <FileText size={14} className="shrink-0 opacity-60" /><span className="truncate">{node.title}</span>
        {node.admin_only && <Lock size={12} aria-label={t('kb.adminOnly')} />}
        {node.is_archived && <span className="text-xs text-muted-foreground">{t('kb.archived')}</span>}
      </button>
      {node.children.length > 0 && <ul>{renderTree(node.children, depth + 1)}</ul>}
    </li>
  ));

  return <section className="flex-1 min-h-0 flex flex-col bg-gradient-to-b from-primary/[0.03] to-background">
    <header className="flex flex-wrap items-center justify-between gap-3 border-b px-4 md:px-6 py-4">
      <div className="flex items-center gap-3"><BookOpen className="text-primary" size={22} /><div>
        <h1 className="font-bold text-lg">{t('kb.title')}</h1><p className="text-xs text-muted-foreground">{t('kb.subtitle')}</p>
      </div></div>
      <Button disabled={busy || !!draft} onClick={() => { setNewScope(scope === 'all' ? 'shared' : scope); setCreating(true); }} className="shadow-sm gap-2"><Plus size={16} />{t('kb.newPage')}</Button>
    </header>
    {error && <div role="alert" className="px-4 py-2 text-sm text-destructive">{t('kb.errors.kb_load_failed')} <button className="underline" onClick={() => void refresh()}>{t('kb.retry')}</button></div>}
    <div className="flex flex-1 min-h-0 overflow-hidden">
      <aside className={`${selectedId ? 'hidden md:flex' : 'flex'} w-full md:w-72 shrink-0 flex-col border-r bg-card/60`} aria-label={t('kb.pages')}>
        <div className="p-3 space-y-3 border-b">
          <div className="relative"><Search size={15} className="absolute left-3 top-3 text-muted-foreground" /><Input value={query} onChange={e => setQuery(e.target.value)} placeholder={t('kb.search')} aria-label={t('kb.search')} className="pl-9" /></div>
          <select className={`${selectStyle} w-full`} aria-label={t('kb.scope')} value={scope} onChange={e => setScope(e.target.value)}>
            <option value="all">{t('kb.allScopes')}</option>{scopeOptions}
          </select>
          <label className="flex gap-2 text-xs text-muted-foreground"><input type="checkbox" checked={showArchived} onChange={e => setShowArchived(e.target.checked)} />{t('kb.showArchived')}</label>
        </div>
        <nav className="overflow-auto flex-1 p-2">
          {loading ? <p className="p-3 text-sm">{t('kb.loading')}</p> : query.trim() ? <>
            <p className="px-3 py-2 text-xs text-muted-foreground">{t('kb.searchAll')}</p>
            {!results.length && <p className="p-3 text-sm text-muted-foreground">{t('kb.noResults')}</p>}
            {results.map(p => <button key={p.id} disabled={busy} onClick={() => void selectPage(p.id)} className="block w-full rounded-lg p-3 text-left hover:bg-muted">
              <span className="block text-sm font-semibold">{p.title}</span><span className="block text-xs text-primary my-1">{scopeName(p.project_id)}</span>
              <span className="block text-xs text-muted-foreground break-words">{knowledgeSnippet(p.body, query)}</span>
            </button>)}
          </> : groups.filter(g => scope === 'all' || scope === g.id).map(g => <div key={g.id} className="mb-4">
            <h2 className="px-3 py-2 text-xs font-bold text-muted-foreground">{g.name}</h2>
            <ul>{renderTree(buildKnowledgeTree(visible.filter(p => (p.project_id || 'shared') === g.id)))}</ul>
            {!visible.some(p => (p.project_id || 'shared') === g.id) && <p className="px-3 text-xs text-muted-foreground">{t('kb.emptyGroup')}</p>}
          </div>)}
        </nav>
      </aside>
      <main className={`${selectedId ? 'flex' : 'hidden md:flex'} flex-col flex-1 min-w-0 overflow-auto p-4 md:p-7`}>
        {selectedId && <Button variant="ghost" className="md:hidden self-start mb-3 gap-2" disabled={busy} onClick={() => {
          if (!draft || window.confirm(t('kb.discard'))) { void stopEditing(); setSelectedId(null); }
        }}><ArrowLeft size={16} />{t('kb.pages')}</Button>}
        {!page ? <div className="m-auto text-center max-w-sm text-muted-foreground"><BookOpen size={36} className="mx-auto mb-4 text-primary/60" /><h2 className="font-semibold text-foreground">{t('kb.emptyTitle')}</h2><p className="text-sm mt-2">{t('kb.emptyHint')}</p></div> : <div className="w-full max-w-5xl mx-auto space-y-5">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0"><p className="text-xs text-primary mb-2">{scopeName(page.project_id)}</p><h2 className="text-2xl font-bold break-words">{page.title}</h2>
              <p className="text-xs text-muted-foreground mt-2">{t('kb.updated', { name: users.find(u => u.id === page.updated_by)?.name || t('kb.member'), date: new Date(page.updated_at).toLocaleString() })}</p>
            </div>
            <div className="flex flex-wrap gap-2">
              {draft ? <><Button disabled={busy || !draft.title.trim()} onClick={() => void save()}>{busy ? t('kb.saving') : t('kb.save')}</Button><Button variant="outline" disabled={busy} onClick={() => void stopEditing()}>{t('kb.cancel')}</Button></> : <>
                <Button variant="outline" onClick={() => { setShowHistory(!showHistory); setPreview(null); }} className="gap-2"><History size={15} />{t('kb.history')}</Button>
                {canEdit && <Button disabled={busy} onClick={() => void edit()}>{t('kb.edit')}</Button>}
                {admin && <Button variant="outline" disabled={busy || !!lockedBy} onClick={() => void archive()}>{page.is_archived ? t('kb.unarchive') : t('kb.archive')}</Button>}
                {canDelete && <Button variant="ghost" disabled={busy} aria-label={t('kb.delete')} onClick={() => void remove()}><Trash2 size={16} /></Button>}
              </>}
            </div>
          </div>
          {lockedBy && <p role="status" className="text-sm rounded-lg bg-amber-500/10 p-3">{t('kb.editing', { name: lockedBy.name })}</p>}
          {page.is_archived && <p className="text-sm text-muted-foreground">{t('kb.archivedHint')}</p>}
          {page.admin_only && <p className="flex items-center gap-2 text-sm text-muted-foreground"><Lock size={14} />{t('kb.adminOnly')}</p>}
          {draft ? <div className="rounded-xl border bg-card p-4 shadow-sm space-y-4">
            <label className="block text-sm space-y-1"><span>{t('kb.pageTitle')}</span><Input value={draft.title} maxLength={200} disabled={busy} onChange={e => setDraft({ ...draft, title: e.target.value })} /></label>
            <div className="grid sm:grid-cols-3 gap-3">
              <label className="flex flex-col gap-1 text-xs">{t('kb.scope')}<select disabled={busy} className={selectStyle} value={draft.project_id || 'shared'} onChange={e => setDraft({ ...draft, project_id: e.target.value === 'shared' ? null : e.target.value, parent_id: null })}>{scopeOptions}</select></label>
              <label className="flex flex-col gap-1 text-xs">{t('kb.parent')}<select disabled={busy} className={selectStyle} value={draft.parent_id || ''} onChange={e => setDraft({ ...draft, parent_id: e.target.value || null })}>
                <option value="">{t('kb.noParent')}</option>{pages.filter(p => p.id !== draft.id && p.project_id === draft.project_id && (!p.is_archived || p.id === draft.parent_id)).map(p => <option key={p.id} value={p.id}>{p.title}</option>)}
              </select></label>
              <label className="flex flex-col gap-1 text-xs">{t('kb.order')}<Input disabled={busy} type="number" step="1" value={draft.sort_order} onChange={e => setDraft({ ...draft, sort_order: Number(e.target.value) })} /></label>
            </div>
            {admin && <label className="flex items-center gap-2 text-sm"><input disabled={busy} type="checkbox" checked={draft.admin_only} onChange={e => setDraft({ ...draft, admin_only: e.target.checked })} />{t('kb.adminOnly')}</label>}
            <RichTextEditor content={draft.body} onChange={body => setDraft(d => d ? { ...d, body } : d)} editable={!busy && !lockedBy} imageUploadPrefix={`kb/${page.id}`} members={users} />
          </div> : <article className="prose prose-sm dark:prose-invert max-w-none min-h-40 rounded-xl border bg-card p-5 shadow-sm break-words [&_img]:max-w-full" dangerouslySetInnerHTML={{ __html: renderKnowledgeHtml(page.body || `<p>${t('kb.emptyBody')}</p>`) }} />}
          {showHistory && <section className="rounded-xl border bg-card shadow-sm p-4 space-y-3" aria-label={t('kb.history')}>
            <h3 className="font-semibold">{t('kb.history')}</h3><p className="text-xs text-muted-foreground">{t('kb.historyHint')}</p>
            {!revisions.length && <p className="text-sm text-muted-foreground">{t('kb.noHistory')}</p>}
            <div className="max-h-56 overflow-auto space-y-1">{revisions.map(r => <div key={r.id} className="flex flex-wrap items-center justify-between gap-2 rounded-md bg-muted/40 p-2 text-sm">
              <button className="text-left hover:underline" onClick={() => setPreview(r)}>{t('kb.version', { version: r.version })} · {new Date(r.created_at).toLocaleString()} · {users.find(u => u.id === r.created_by)?.name || t('kb.member')}</button>
              {canEdit && !draft && <Button size="sm" variant="outline" disabled={busy} onClick={() => void restore(r)}>{t('kb.restore')}</Button>}
            </div>)}</div>
            {preview && <article className="prose prose-sm dark:prose-invert max-w-none border-t pt-3 break-words" dangerouslySetInnerHTML={{ __html: renderKnowledgeHtml(preview.body) }} />}
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
              <a className="flex-1 min-w-0 truncate text-primary hover:underline" href={supabase.storage.from('task-images').getPublicUrl(file.storage_path).data.publicUrl} target="_blank" rel="noreferrer">{file.file_name}</a>
              <span className="text-xs text-muted-foreground">{(file.file_size / 1024).toFixed(1)} KB</span>
              {canEdit && <Button size="icon" variant="ghost" disabled={busy} aria-label={t('kb.deleteFile', { name: file.file_name })} onClick={() => {
                if (!window.confirm(t('kb.deleteFile', { name: file.file_name }))) return;
                void run(() => withFileLock(async () => {
                  const removed = await supabase.storage.from('task-images').remove([file.storage_path]);
                  if (removed.error) throw removed.error;
                  const result = await supabase.from('kb_attachments').delete().eq('id', file.id).select('*').single();
                  if (result.error) throw result.error;
                }));
              }}><Trash2 size={14} /></Button>}
            </div>)}
          </section>
        </div>}
      </main>
    </div>
    <Dialog open={creating} onOpenChange={open => { if (!busy) setCreating(open); }}><DialogContent><DialogHeader><DialogTitle>{t('kb.newPage')}</DialogTitle></DialogHeader>
      <form onSubmit={e => { e.preventDefault(); void create(); }} className="space-y-4">
        <label className="block space-y-1 text-sm"><span>{t('kb.pageTitle')}</span><Input autoFocus required maxLength={200} value={newTitle} disabled={busy} onChange={e => setNewTitle(e.target.value)} /></label>
        <label className="flex flex-col gap-1 text-sm">{t('kb.scope')}<select className={selectStyle} value={newScope} disabled={busy} onChange={e => setNewScope(e.target.value)}>{scopeOptions}</select></label>
        <DialogFooter><Button type="submit" disabled={busy || !newTitle.trim()}>{busy ? t('kb.saving') : t('kb.create')}</Button></DialogFooter>
      </form>
    </DialogContent></Dialog>
  </section>;
}
