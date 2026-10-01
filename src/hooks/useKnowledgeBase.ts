import { useCallback, useEffect, useRef, useState } from 'react';
import { knowledgeClient as supabase } from '@/integrations/supabase/knowledgeClient';
import type { KnowledgePage, KnowledgeAttachment, KnowledgeRevision } from '@/types/knowledge';
import { MAX_UPLOAD_BYTES } from '@/lib/uploadLimits';
import { randomUUID } from '@/lib/generateId';

/** Refetch subscriptions also work with Cloudflare's workspace-scoped hub. */
export function useKnowledgeBase(pageId: string | null) {
  const [pages, setPages] = useState<KnowledgePage[]>([]);
  const [attachments, setAttachments] = useState<KnowledgeAttachment[]>([]);
  const [revisions, setRevisions] = useState<KnowledgeRevision[]>([]);
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
      if (ticket === generation.current) { setPages(all); setError(null); }
    } catch (failure) {
      if (ticket === generation.current) setError(failure instanceof Error ? failure.message : 'kb_load_failed');
    } finally { if (ticket === generation.current) setLoading(false); }
  }, []);
  useEffect(() => {
    void refresh();
    const channel = supabase.channel('knowledge-pages').on('postgres_changes',
      { event: '*', schema: 'public', table: 'kb_pages' }, () => { void refresh(); }).subscribe();
    return () => { generation.current++; void supabase.removeChannel(channel); };
  }, [refresh]);

  useEffect(() => {
    let alive = true;
    setAttachments([]); setRevisions([]);
    if (!pageId) return;
    const load = async () => {
      try {
        const [files, history] = await Promise.all([
          supabase.from('kb_attachments').select('*').eq('page_id', pageId).order('created_at', { ascending: false }),
          supabase.from('kb_revisions').select('*').eq('page_id', pageId).order('version', { ascending: false }).limit(20),
        ]);
        if (files.error || history.error) throw files.error || history.error;
        if (alive) { setAttachments(files.data || []); setRevisions(history.data || []); }
      } catch { if (alive) setError('kb_load_failed'); }
    };
    void load();
    const channel = supabase.channel(`knowledge-details-${pageId}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'kb_attachments', filter: `page_id=eq.${pageId}` }, () => { void load(); })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'kb_revisions', filter: `page_id=eq.${pageId}` }, () => { void load(); })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'kb_pages', filter: `id=eq.${pageId}` }, () => { void load(); })
      .subscribe();
    // Mock data has no network events; a page refresh reloads its details too.
    return () => { alive = false; void supabase.removeChannel(channel); };
  }, [pageId, pages]);

  return { pages, attachments, revisions, loading, error, refresh };
}

export async function uploadKnowledgeFile(pageId: string, memberId: string, file: File) {
  if (file.size > MAX_UPLOAD_BYTES) throw new Error('kb_file_too_large');
  const suffix = file.name.split('.').pop()?.replace(/[^a-zA-Z0-9]/g, '') || 'bin';
  const path = `kb/${pageId}/${randomUUID()}.${suffix}`;
  const bucket = supabase.storage.from('task-images');
  const upload = await bucket.upload(path, file);
  if (upload.error) throw upload.error;
  const storedPath = upload.data.path;
  const result = await supabase.from('kb_attachments').insert({ page_id: pageId, file_name: file.name,
    file_size: file.size, file_type: file.type, storage_path: storedPath, uploaded_by: memberId });
  if (result.error) {
    await bucket.remove([storedPath]);
    throw result.error;
  }
}
