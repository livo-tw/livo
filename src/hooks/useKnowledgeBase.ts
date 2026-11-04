import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { knowledgeClient as supabase } from '@/integrations/supabase/knowledgeClient';
import type { KnowledgePage, KnowledgeAttachment, KnowledgeRevision, KnowledgeComment } from '@/types/knowledge';
import { knowledgeCanFromIndex, type KnowledgeActor } from '../../worker/src/knowledgeAccess';
import { MAX_UPLOAD_BYTES } from '@/lib/uploadLimits';
import { randomUUID } from '@/lib/generateId';

const EMPTY_DETAILS = { error: null as string | null, attachments: [] as KnowledgeAttachment[], revisions: [] as KnowledgeRevision[], comments: [] as KnowledgeComment[] };

/** Backend filtering is authoritative; local checks also discard stale, revoked data. */
export function useKnowledgeBase(pageId: string | null, actor: KnowledgeActor | null) {
  const identity = JSON.stringify(actor);
  // `loaded` stays false until a read for this identity has completed.
  const [snapshot, setSnapshot] = useState({ identity, pages: [] as KnowledgePage[], loaded: false });
  const [details, setDetails] = useState({ identity, pageId, ...EMPTY_DETAILS });
  const [detailRevision, retryDetails] = useState(0);
  const reloadDetails = useCallback(() => retryDetails(revision => revision + 1), []);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const generation = useRef(0);
  const refreshDirectory = useCallback(async (includeDetails: boolean) => {
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
      if (ticket === generation.current) {
        setSnapshot({ identity, pages: all, loaded: true });
        setError(null);
        if (includeDetails) reloadDetails();
      }
    } catch (failure) {
      if (ticket === generation.current) {
        setSnapshot({ identity, pages: [], loaded: true }); setDetails({ identity, pageId: null, ...EMPTY_DETAILS });
        setError(failure instanceof Error ? failure.message : 'kb_load_failed');
      }
    } finally { if (ticket === generation.current) setLoading(false); }
  }, [identity, reloadDetails]);
  const refresh = useCallback(() => refreshDirectory(true), [refreshDirectory]);
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

  const pages = useMemo(() => {
    if (!actor || snapshot.identity !== identity) return [];
    const byId = new Map(snapshot.pages.map(page => [page.id, page]));
    return snapshot.pages.filter(page => knowledgeCanFromIndex(byId, page.id, actor, 'view'));
  }, [snapshot, identity, actor]);
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
        if (alive && ticket === loadGeneration) setDetails({ identity, pageId, error: null, attachments: files.data || [], revisions: history.data || [], comments: discussion });
      } catch {
        if (alive && ticket === loadGeneration) {
          setDetails({ identity, pageId, ...EMPTY_DETAILS, error: 'kb_details_failed' });
          // Recheck the authoritative directory in case access changed. Do not
          // trigger another details load from the failure's own revalidation.
          void refreshDirectory(false);
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
  }, [pageId, identity, readable, detailRevision, refreshDirectory]);

  const safeDetails = readable && details.identity === identity && details.pageId === pageId ? details : EMPTY_DETAILS;
  /** Pages reflect the current actor (not a previous identity or the initial empty state). */
  const ready = snapshot.loaded && snapshot.identity === identity;
  return { pages, attachments: safeDetails.attachments, revisions: safeDetails.revisions, comments: safeDetails.comments,
    detailsError: safeDetails.error, retryDetails: reloadDetails, loading, error, ready, refresh };
}

export async function uploadKnowledgeFile(pageId: string, memberId: string, file: File) {
  if (file.size > MAX_UPLOAD_BYTES) throw new Error('kb_file_too_large');
  const suffix = file.name.split('.').pop()?.replace(/[^a-zA-Z0-9]/g, '') || 'bin';
  const id = randomUUID();
  const path = `kb/${pageId}/${id}.${suffix}`;
  const bucket = supabase.storage.from('kb-files');
  const upload = await bucket.upload(path, file);
  if (upload.error) throw upload.error;
  const storedPath = upload.data.path;
  let failure: { code?: string; message: string } | undefined;
  try {
    const result = await supabase.from('kb_attachments').insert({ id, page_id: pageId, file_name: file.name,
      file_size: file.size, file_type: file.type, storage_path: storedPath, storage_bucket: 'kb-files', uploaded_by: memberId });
    if (!result.error) return;
    failure = result.error;
  } catch {
    // A thrown transport failure can follow a committed insert.
  }

  const stored = await Promise.resolve(supabase.from('kb_attachments')
    .select('id,page_id,storage_path,storage_bucket,uploaded_by').eq('id', id).maybeSingle()).catch((): null => null);
  if (stored && !stored.error && stored.data?.id === id && stored.data.page_id === pageId &&
      stored.data.storage_path === storedPath && stored.data.storage_bucket === 'kb-files' &&
      stored.data.uploaded_by === memberId) return;

  // Only a definite database rejection and an authorized empty read prove
  // there is nothing to preserve. Retain the bytes on an ambiguous result.
  const rejected = failure && (/^(?:22|23|28|42)[A-Z0-9]{3}$/.test(failure.code ?? '') ||
    /\b(?:FOREIGN KEY|NOT NULL|CHECK) constraint failed\b/i.test(failure.message));
  if (rejected && stored && !stored.error && !stored.data) {
    await Promise.resolve(bucket.remove([storedPath])).catch(() => {});
    throw failure;
  }
  throw new Error('kb_attachment_unconfirmed');
}

export async function deleteKnowledgeFile(file: KnowledgeAttachment) {
  const bucket = file.storage_bucket || 'task-images';
  const result = await Promise.resolve(supabase.from('kb_attachments').delete().eq('id', file.id)
    .eq('page_id', file.page_id).eq('storage_path', file.storage_path)
    .select('id,page_id,storage_path,storage_bucket').single()).catch((): null => null);
  const deleted = result?.data;
  // A missing row can mean that access changed. Only a matching DELETE result
  // proves the reference was removed and allows cleanup of the stored bytes.
  if (result?.error || !deleted || deleted.id !== file.id || deleted.page_id !== file.page_id ||
      deleted.storage_path !== file.storage_path || (deleted.storage_bucket || 'task-images') !== bucket) {
    throw new Error('kb_attachment_delete_unconfirmed');
  }

  const removed = await supabase.storage.from(bucket).remove([file.storage_path]).catch((): null => null);
  // The Worker returns object paths; Supabase Storage returns deleted objects.
  const confirmed = !removed?.error && Array.isArray(removed?.data) && removed.data.some((entry: unknown) =>
    entry === file.storage_path || (!!entry && typeof entry === 'object' && 'name' in entry && entry.name === file.storage_path));
  if (!confirmed) throw new Error('kb_attachment_cleanup_unconfirmed');
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
