import { useCallback, useEffect, useRef, useState } from 'react';
import { knowledgeClient as supabase } from '@/integrations/supabase/knowledgeClient';
import type { KnowledgePage, KnowledgeAttachment, KnowledgeRevision, KnowledgeComment } from '@/types/knowledge';
import { knowledgeCan, type KnowledgeActor } from '../../worker/src/knowledgeAccess';
import { MAX_UPLOAD_BYTES } from '@/lib/uploadLimits';
import { randomUUID } from '@/lib/generateId';

const EMPTY_DETAILS = { attachments: [] as KnowledgeAttachment[], revisions: [] as KnowledgeRevision[], comments: [] as KnowledgeComment[] };

/** Backend filtering is authoritative; local checks also discard stale, revoked data. */
export function useKnowledgeBase(pageId: string | null, actor: KnowledgeActor | null) {
  const identity = JSON.stringify(actor);
  const [snapshot, setSnapshot] = useState({ identity, pages: [] as KnowledgePage[] });
  const [details, setDetails] = useState({ identity, pageId, ...EMPTY_DETAILS });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const generation = useRef(0);
  const refresh = useCallback(async () => {
    const ticket = ++generation.current;
    try {
      const all: KnowledgePage[] = [];
      let cursor = '';
      for (;;) {
        let query = supabase.from('kb_pages').select('*').order('id').limit(500);
        if (cursor) query = query.gt('id', cursor);
        const { data, error: failure } = await query;
        if (failure) throw failure;
        const batch = data || [];
        all.push(...batch);
        if (batch.length < 500) break;
        cursor = batch[batch.length - 1].id;
      }
      if (ticket === generation.current) { setSnapshot({ identity, pages: all }); setError(null); }
    } catch (failure) {
      if (ticket === generation.current) {
        setSnapshot({ identity, pages: [] }); setDetails({ identity, pageId: null, ...EMPTY_DETAILS });
        setError(failure instanceof Error ? failure.message : 'kb_load_failed');
      }
    } finally { if (ticket === generation.current) setLoading(false); }
  }, [identity]);
  useEffect(() => {
    setLoading(true);
    void refresh();
    const reload = () => { if (document.visibilityState !== 'hidden') void refresh(); };
    window.addEventListener('focus', reload);
    document.addEventListener('visibilitychange', reload);
    // A revoked reader may no longer receive RLS-filtered events.
    const timer = window.setInterval(reload, 30_000);
    const channel = supabase.channel('knowledge-pages').on('postgres_changes',
      { event: '*', schema: 'public', table: 'kb_pages' }, () => { void refresh(); }).subscribe();
    return () => {
      generation.current++; window.clearInterval(timer);
      window.removeEventListener('focus', reload); document.removeEventListener('visibilitychange', reload);
      void supabase.removeChannel(channel);
    };
  }, [refresh]);

  const sourcePages = snapshot.identity === identity ? snapshot.pages : [];
  const pages = sourcePages.filter(p => knowledgeCan(sourcePages, p.id, actor, 'view'));
  const readable = !!pageId && pages.some(p => p.id === pageId);
  useEffect(() => {
    let alive = true;
    let loadGeneration = 0;
    setDetails({ identity, pageId, ...EMPTY_DETAILS });
    if (!pageId || !readable) return;
    const load = async () => {
      const ticket = ++loadGeneration;
      try {
        const [files, history, discussion] = await Promise.all([
          supabase.from('kb_attachments').select('*').eq('page_id', pageId).order('created_at', { ascending: false }),
          supabase.from('kb_revisions').select('*').eq('page_id', pageId).order('version', { ascending: false }).limit(20),
          (async () => {
            const comments: KnowledgeComment[] = []; let cursor = '';
            for (;;) {
              let query = supabase.from('kb_comments').select('*').eq('page_id', pageId).order('id').limit(500);
              if (cursor) query = query.gt('id', cursor);
              const result = await query;
              if (result.error) throw result.error;
              const batch = result.data || []; comments.push(...batch);
              if (batch.length < 500) break;
              cursor = batch[batch.length - 1].id;
            }
            return comments.sort((a, b) => a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id));
          })(),
        ]);
        if (files.error || history.error) throw files.error || history.error;
        if (alive && ticket === loadGeneration) setDetails({ identity, pageId, attachments: files.data || [], revisions: history.data || [], comments: discussion });
      } catch {
        if (alive && ticket === loadGeneration) {
          setDetails({ identity, pageId, ...EMPTY_DETAILS }); setSnapshot({ identity, pages: [] }); setError('kb_load_failed');
        }
      }
    };
    void load();
    // Events are invalidations only: confidential rows are never broadcast.
    const channel = supabase.channel(`knowledge-details-${pageId}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'kb_attachments' }, () => { void load(); })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'kb_revisions' }, () => { void load(); })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'kb_comments' }, () => { void load(); })
      .subscribe();
    return () => { alive = false; void supabase.removeChannel(channel); };
  }, [pageId, snapshot, identity, readable]);

  const safeDetails = readable && details.identity === identity && details.pageId === pageId ? details : EMPTY_DETAILS;
  return { pages, ...safeDetails, loading, error, refresh };
}

export async function uploadKnowledgeFile(pageId: string, memberId: string, file: File) {
  if (file.size > MAX_UPLOAD_BYTES) throw new Error('kb_file_too_large');
  const suffix = file.name.split('.').pop()?.replace(/[^a-zA-Z0-9]/g, '') || 'bin';
  const path = `kb/${pageId}/${randomUUID()}.${suffix}`;
  const bucket = supabase.storage.from('kb-files');
  const upload = await bucket.upload(path, file);
  if (upload.error) throw upload.error;
  const storedPath = upload.data.path;
  const result = await supabase.from('kb_attachments').insert({ page_id: pageId, file_name: file.name,
    file_size: file.size, file_type: file.type, storage_path: storedPath, storage_bucket: 'kb-files', uploaded_by: memberId });
  if (result.error) { await bucket.remove([storedPath]); throw result.error; }
}

export async function downloadKnowledgeFile(file: KnowledgeAttachment) {
  const result = await supabase.storage.from(file.storage_bucket || 'task-images').download(file.storage_path);
  if (result.error || !result.data) throw result.error || new Error('kb_failed');
  const url = URL.createObjectURL(result.data);
  const link = document.createElement('a');
  link.href = url; link.download = file.file_name; link.rel = 'noopener';
  document.body.appendChild(link); link.click(); link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}
