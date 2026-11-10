import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { CheckCircle2, Eye, FileText, Film, Loader2, Paperclip, RotateCcw, Upload, X } from 'lucide-react';

export interface CommentDraftAttachment {
  id: string;
  file: File;
  preview?: string;
  progress: number;
  status: 'pending' | 'uploading' | 'complete' | 'failed';
}
export interface CommentAttachmentRejection {
  name: string;
  code: 'file_size' | 'file_type' | 'file_name' | 'file_count';
}
export const commentAttachmentSize = (bytes: number) => bytes < 1024 * 1024
  ? `${Math.max(1, Math.round(bytes / 1024))} KB`
  : `${(bytes / (1024 * 1024)).toFixed(1)} MB`;

/** Presentation only: each record provider owns validation, reservations and upload recovery. */
export default function CommentAttachmentPicker({ files, rejected = [], busy = false, onFiles, onRemove, onRetry,
  maxFiles = 10, accept = '.png,.jpg,.jpeg,.webp,.gif,.mp4,.webm,.pdf,.txt,.log,.csv,.json',
}: {
  files: readonly CommentDraftAttachment[];
  rejected?: readonly CommentAttachmentRejection[];
  busy?: boolean;
  onFiles: (files: File[]) => void;
  onRemove: (id: string) => void;
  onRetry?: () => void;
  maxFiles?: number;
  accept?: string;
}) {
  const { t } = useTranslation();
  const input = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const [previewId, setPreviewId] = useState<string | null>(null);
  const [overflow, setOverflow] = useState<CommentAttachmentRejection[]>([]);
  const preview = files.find(file => file.id === previewId);
  const choose = (incoming: File[]) => {
    if (busy) return;
    const unique = incoming.filter((file, index) => !files.some(entry => sameFile(entry.file, file))
      && incoming.findIndex(other => sameFile(other, file)) === index);
    const room = Math.max(0, maxFiles - files.length);
    setOverflow(unique.slice(room).map(file => ({ name: file.name, code: 'file_count' })));
    if (room && unique.length) onFiles(unique.slice(0, room));
  };
  const failures = [...rejected, ...overflow];
  return <div className="min-w-0 space-y-2">
    <div className="flex flex-wrap items-center justify-between gap-2">
      <span className="flex items-center gap-2 text-sm font-medium"><Paperclip size={15} aria-hidden="true" />{t('commentAttachments.heading')}</span>
      <button type="button" disabled={busy || files.length >= maxFiles} className="rounded border px-3 py-1.5 text-sm disabled:opacity-50" onClick={() => input.current?.click()}>{t('commentAttachments.add')}</button>
    </div>
    <input ref={input} type="file" multiple hidden accept={accept} disabled={busy} aria-label={t('commentAttachments.add')}
      onChange={event => { choose(Array.from(event.currentTarget.files || [])); event.currentTarget.value = ''; }} />
    <button type="button" disabled={busy} onClick={() => input.current?.click()}
      onDragOver={event => { event.preventDefault(); event.stopPropagation(); if (!busy) setDragging(true); }}
      onDragLeave={() => setDragging(false)} onDrop={event => { event.preventDefault(); event.stopPropagation(); setDragging(false); choose(Array.from(event.dataTransfer.files)); }}
      className={`flex w-full flex-col items-center gap-1 rounded-lg border border-dashed p-3 text-center focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary disabled:opacity-50 ${dragging ? 'border-primary bg-primary/5' : 'border-border bg-muted/20'}`}>
      <Upload size={18} aria-hidden="true" /><span className="text-sm">{t('commentAttachments.drop')}</span>
      <span className="text-xs text-muted-foreground">{t('commentAttachments.hint', { count: maxFiles })}</span>
    </button>
    {failures.length > 0 && <ul role="alert" className="space-y-1 rounded border border-destructive/30 p-2 text-sm text-destructive">{failures.map((file, index) => <li key={`${file.name}-${index}`} className="break-words">{file.name}: {t(file.code === 'file_count' ? 'commentAttachments.countLimit' : `qa.${file.code === 'file_size' ? 'fileSizeError' : file.code === 'file_type' ? 'fileTypeError' : 'fileNameError'}`, { count: maxFiles })}</li>)}</ul>}
    {files.length > 0 && <ul className="space-y-2">{files.map(entry => <li key={entry.id} className="rounded-lg border border-border p-2">
      <div className="flex min-w-0 items-center gap-2">
        {entry.preview && entry.file.type.startsWith('image/') ? <img src={entry.preview} alt="" className="h-10 w-10 shrink-0 rounded object-cover" /> : <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded bg-muted">{entry.file.type.startsWith('video/') ? <Film size={16} aria-hidden="true" /> : <FileText size={16} aria-hidden="true" />}</span>}
        <div className="min-w-0 flex-1"><p className="break-all text-sm">{entry.file.name}</p><p className="text-xs text-muted-foreground">{commentAttachmentSize(entry.file.size)} · {t(`commentAttachments.status.${entry.status}`)}</p></div>
        {entry.status === 'complete' ? <CheckCircle2 size={16} className="shrink-0 text-emerald-600" aria-label={t('commentAttachments.status.complete')} /> : entry.status === 'uploading' ? <Loader2 size={16} className="shrink-0 animate-spin" aria-hidden="true" /> : null}
        {entry.preview && <button type="button" className="rounded p-2 hover:bg-muted" aria-label={t('commentAttachments.preview', { name: entry.file.name })} aria-expanded={previewId === entry.id} onClick={() => setPreviewId(previewId === entry.id ? null : entry.id)}><Eye size={16} aria-hidden="true" /></button>}
        <button type="button" disabled={busy} className="rounded p-2 hover:bg-muted disabled:opacity-50" onClick={() => { if (previewId === entry.id) setPreviewId(null); onRemove(entry.id); }} aria-label={t('commentAttachments.remove', { name: entry.file.name })}><X size={16} aria-hidden="true" /></button>
      </div>
      {entry.status === 'uploading' && <div className="mt-2"><progress value={entry.progress} max={100} className="h-1.5 w-full accent-primary" aria-label={t('commentAttachments.progress', { percent: entry.progress })} /><p role="status" className="text-right text-xs">{entry.progress}%</p></div>}
    </li>)}</ul>}
    {onRetry && files.some(file => file.status === 'failed') && <button type="button" disabled={busy} className="inline-flex items-center gap-1 rounded border px-3 py-1.5 text-sm disabled:opacity-50" onClick={onRetry}><RotateCcw size={14} aria-hidden="true" />{t('commentAttachments.retry')}</button>}
    {preview?.preview && <div className="space-y-2 rounded-lg border p-2"><div className="flex items-center justify-between gap-2"><span className="break-all text-sm">{preview.file.name}</span><button type="button" onClick={() => setPreviewId(null)} className="rounded border px-2 py-1 text-sm">{t('commentAttachments.closePreview')}</button></div>{/^video\/(mp4|webm)$/.test(preview.file.type) ? <video src={preview.preview} controls preload="metadata" className="max-h-64 w-full rounded bg-black" /> : /^image\/(png|jpeg|gif|webp)$/.test(preview.file.type) ? <img src={preview.preview} alt={preview.file.name} className="mx-auto max-h-64 max-w-full rounded object-contain" /> : null}</div>}
  </div>;
}

const sameFile = (a: File, b: File) => a.name === b.name && a.size === b.size && a.type === b.type && a.lastModified === b.lastModified;
export { CommentAttachmentPicker };
