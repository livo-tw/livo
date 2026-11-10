import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Download, FileText, Film, ImageIcon, Loader2 } from 'lucide-react';
import { commentAttachmentSize } from './CommentAttachmentPicker';

export interface CommentAttachmentItem { id: string; fileName: string; mimeType: string; size: number; }
const mime = (value: string) => value.split(';', 1)[0].trim().toLowerCase();
export function commentAttachmentPreviewType(file: CommentAttachmentItem, blob: Blob): 'image' | 'video' | undefined {
  const type = mime(file.mimeType);
  if (type !== mime(blob.type)) return undefined;
  if (/^image\/(png|jpeg|gif|webp)$/.test(type)) return 'image';
  if (/^video\/(mp4|webm)$/.test(type)) return 'video';
  return undefined;
}

/** Downloads always go through the record's authenticated provider; URLs are never supplied by a comment body. */
export default function CommentAttachmentList({ attachments, download, scopeKey, onError }: {
  attachments: readonly CommentAttachmentItem[];
  download: (fileId: string, signal: AbortSignal) => Promise<Blob>;
  scopeKey: string;
  onError: (error: unknown) => void;
}) {
  const { t } = useTranslation();
  const [loading, setLoading] = useState<string | null>(null);
  const [preview, setPreview] = useState<{ url: string; file: CommentAttachmentItem; kind?: 'image' | 'video' } | null>(null);
  const controller = useRef<AbortController>();
  const generation = useRef(0);
  const active = useRef(false);
  useEffect(() => {
    generation.current += 1; active.current = true; setLoading(null); setPreview(null);
    return () => { active.current = false; generation.current += 1; controller.current?.abort(); };
  }, [scopeKey]);
  useEffect(() => () => { if (preview) URL.revokeObjectURL(preview.url); }, [preview]);
  const open = async (file: CommentAttachmentItem) => {
    controller.current?.abort(); const request = new AbortController(); controller.current = request;
    const revision = generation.current; setLoading(file.id);
    try {
      const blob = await download(file.id, request.signal);
      if (!active.current || request.signal.aborted || revision !== generation.current) return;
      setPreview({ url: URL.createObjectURL(blob), file, kind: commentAttachmentPreviewType(file, blob) });
    } catch (error) { if (active.current && !request.signal.aborted && revision === generation.current) onError(error); }
    finally { if (active.current && !request.signal.aborted && revision === generation.current) setLoading(null); }
  };
  if (!attachments.length) return null;
  return <div className="min-w-0 space-y-2">
    <ul className="space-y-2">{attachments.map(file => <li key={file.id} className="flex min-w-0 flex-wrap items-center gap-2 rounded-lg border border-border bg-muted/20 p-2 text-sm">
      <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded bg-muted">{mime(file.mimeType).startsWith('video/') ? <Film size={15} aria-hidden="true" /> : mime(file.mimeType).startsWith('image/') ? <ImageIcon size={15} aria-hidden="true" /> : <FileText size={15} aria-hidden="true" />}</span>
      <div className="min-w-0 flex-1"><p className="break-all">{file.fileName}</p><p className="text-xs text-muted-foreground">{commentAttachmentSize(file.size)}</p></div>
      <button type="button" disabled={loading !== null} className="inline-flex shrink-0 items-center gap-1 rounded border px-2 py-1.5 text-sm disabled:opacity-50" onClick={() => void open(file)}>{loading === file.id ? <Loader2 size={14} className="animate-spin" aria-hidden="true" /> : <Download size={14} aria-hidden="true" />}{t(loading === file.id ? 'commentAttachments.loading' : 'commentAttachments.view')}</button>
    </li>)}</ul>
    {loading && <button type="button" className="rounded border px-2 py-1 text-sm" onClick={() => { controller.current?.abort(); setLoading(null); }}>{t('commentAttachments.cancelDownload')}</button>}
    {preview && <div className="space-y-2 rounded-lg border border-border p-3">
      <div className="flex items-center justify-between gap-2"><span className="break-all text-sm">{preview.file.fileName}</span><button type="button" className="shrink-0 rounded border px-2 py-1 text-sm" onClick={() => setPreview(null)}>{t('commentAttachments.closePreview')}</button></div>
      {preview.kind === 'image' && <img src={preview.url} alt={preview.file.fileName} className="mx-auto max-h-[60vh] max-w-full rounded object-contain" />}
      {preview.kind === 'video' && <video src={preview.url} controls preload="metadata" className="max-h-[60vh] w-full rounded bg-black" />}
      <a href={preview.url} download={preview.file.fileName} className="inline-flex items-center gap-1 rounded border px-2 py-1.5 text-sm"><Download size={14} aria-hidden="true" />{t('commentAttachments.download')}</a>
    </div>}
  </div>;
}
export { CommentAttachmentList };
