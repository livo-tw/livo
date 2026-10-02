import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { MessageSquare, Trash2 } from 'lucide-react';
import type { User } from '@/types';
import type { KnowledgeComment } from '@/types/knowledge';
import { knowledgeClient as supabase } from '@/integrations/supabase/knowledgeClient';
import { Button } from '@/components/ui/button';

export default function KnowledgeComments({ pageId, comments, memberId, users, canComment, canEdit, onChanged, report }:
  { pageId: string; comments: KnowledgeComment[]; memberId: string; users: User[]; canComment: boolean; canEdit: boolean;
    onChanged: () => Promise<void>; report: (failure: unknown) => void }) {
  const { t } = useTranslation();
  const [body, setBody] = useState('');
  const [editing, setEditing] = useState<string | null>(null);
  const [editBody, setEditBody] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (!canComment) { setEditing(null); setEditBody(''); setBody(''); } }, [canComment]);
  async function send(id?: string) {
    if (!canComment) return;
    const text = (id ? editBody : body).trim();
    if (!text || text.length > 10000) return;
    setBusy(true);
    try {
      const result = id
        ? await supabase.from('kb_comments').update({ body: text }).eq('id', id).eq('page_id', pageId).select('*').single()
        : await supabase.from('kb_comments').insert({ page_id: pageId, body: text, created_by: memberId }).select('*').single();
      if (result.error || !result.data) throw result.error || new Error('kb_forbidden');
      setBody(''); setEditing(null); setEditBody(''); await onChanged();
    } catch (failure) { report(failure); } finally { setBusy(false); }
  }
  async function remove(comment: KnowledgeComment) {
    if (!(canEdit || (canComment && comment.created_by === memberId)) || !window.confirm(t('kb.comments.deleteConfirm'))) return;
    setBusy(true);
    try {
      const result = await supabase.from('kb_comments').delete().eq('id', comment.id).eq('page_id', pageId).select('*').single();
      if (result.error || !result.data) throw result.error || new Error('kb_forbidden');
      if (editing === comment.id) setEditing(null);
      await onChanged();
    } catch (failure) { report(failure); } finally { setBusy(false); }
  }
  return <section aria-label={t('kb.comments.title')} className="rounded-xl border bg-card p-4 shadow-sm space-y-4">
    <h3 className="font-semibold flex items-center gap-2"><MessageSquare size={16} />{t('kb.comments.title')}</h3>
    {!comments.length && <p className="text-sm text-muted-foreground">{t('kb.comments.empty')}</p>}
    {comments.map(comment => <div key={comment.id} className="border-t pt-3 space-y-2">
      <div className="flex items-center justify-between gap-2"><p className="text-xs text-muted-foreground">{users.find(u => u.id === comment.created_by)?.name || t('kb.member')} · {new Date(comment.created_at).toLocaleString()}</p>
        <div className="flex gap-1">{canComment && comment.created_by === memberId && editing !== comment.id && <Button size="sm" variant="ghost" disabled={busy} onClick={() => { setEditing(comment.id); setEditBody(comment.body); }}>{t('kb.comments.edit')}</Button>}
          {(canEdit || (canComment && comment.created_by === memberId)) && <Button size="icon" variant="ghost" disabled={busy} aria-label={t('kb.comments.delete')} onClick={() => void remove(comment)}><Trash2 size={14} /></Button>}
        </div>
      </div>
      {editing === comment.id ? <form className="space-y-2" onSubmit={e => { e.preventDefault(); void send(comment.id); }}>
        <textarea aria-label={t('kb.comments.edit')} className="w-full rounded-md border bg-background p-2 text-sm min-h-24" maxLength={10000} value={editBody} disabled={busy} onChange={e => setEditBody(e.target.value)} />
        <div className="flex gap-2"><Button size="sm" disabled={busy || !editBody.trim()}>{t('kb.save')}</Button><Button type="button" size="sm" variant="outline" disabled={busy} onClick={() => setEditing(null)}>{t('kb.cancel')}</Button></div>
      </form> : <p className="text-sm whitespace-pre-wrap break-words">{comment.body}</p>}
    </div>)}
    {canComment ? <form className="space-y-2" onSubmit={e => { e.preventDefault(); void send(); }}>
      <textarea aria-label={t('kb.comments.body')} placeholder={t('kb.comments.body')} className="w-full rounded-md border bg-background p-3 text-sm min-h-24" maxLength={10000} value={body} disabled={busy} onChange={e => setBody(e.target.value)} />
      <div className="flex items-center justify-between gap-2"><span className="text-xs text-muted-foreground">{body.length}/10000</span><Button disabled={busy || !body.trim()}>{busy ? t('kb.saving') : t('kb.comments.send')}</Button></div>
    </form> : <p className="text-xs text-muted-foreground">{t('kb.comments.readOnly')}</p>}
  </section>;
}
