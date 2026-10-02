import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { CheckCircle2, Eye, FileText, Film, Loader2, Paperclip, RotateCcw, Upload, X } from 'lucide-react';
import { qaId, qaThrowIfAborted, qaUploadFileTypes, qaValidateUploadFile, type QaClient, type QaUploadResume } from '@/lib/qa/client';
import { qaButton } from './QaFields';

export interface QaDraftFile {
  id: string; file: File; preview?: string; progress: number;
  status: 'pending' | 'uploading' | 'complete' | 'failed';
  resume: QaUploadResume;
}
type FileFailure = { name: string; code: 'file_size' | 'file_type' | 'file_name' };
export const qaFileSize = (bytes: number) => bytes < 1024 * 1024 ? `${Math.max(1, Math.round(bytes / 1024))} KB` : `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
const revoke = (entry: QaDraftFile) => { if (entry.preview) URL.revokeObjectURL(entry.preview); };
const previewUrl = (file: File) => {
  if (!/^(image\/(png|jpeg|gif|webp)|video\/(mp4|webm))$/.test(file.type)) return undefined;
  try { return URL.createObjectURL(file); } catch { return undefined; }
};

/** File objects and signed-upload resume data deliberately stay in memory. */
export function useQaDraftFiles() {
  const [files, setFiles] = useState<QaDraftFile[]>([]);
  const [rejected, setRejected] = useState<FileFailure[]>([]);
  const current = useRef<QaDraftFile[]>([]);
  const mounted = useRef(true);
  const change = (next: QaDraftFile[]) => { current.current = next; if (mounted.current) setFiles(next); };
  useEffect(() => {
    mounted.current = true;
    const clear = () => { current.current.forEach(revoke); change([]); setRejected([]); };
    window.addEventListener('livo:qa-abort', clear);
    return () => { mounted.current = false; current.current.forEach(revoke); window.removeEventListener('livo:qa-abort', clear); };
  }, []);
  return {
    files, rejected, current,
    add(incoming: File[]): QaDraftFile[] {
      const failures: FileFailure[] = [], added: QaDraftFile[] = [];
      for (const file of incoming) {
        const code = qaValidateUploadFile(file);
        if (code) { failures.push({ name: file.name, code }); continue; }
        if ([...current.current, ...added].some(item => item.file.name === file.name && item.file.size === file.size && item.file.type === file.type && item.file.lastModified === file.lastModified)) continue;
        added.push({ id: qaId(), file, status: 'pending', progress: 0, resume: {}, preview: previewUrl(file) });
      }
      setRejected(failures); change([...current.current, ...added]); return added;
    },
    remove(id: string) { const entry = current.current.find(file => file.id === id); if (entry) revoke(entry); change(current.current.filter(file => file.id !== id)); },
    update(id: string, patch: Partial<Pick<QaDraftFile, 'status' | 'progress'>>) { change(current.current.map(file => file.id === id ? { ...file, ...patch } : file)); },
    clearCompleted() { current.current.filter(file => file.status === 'complete').forEach(revoke); change(current.current.filter(file => file.status !== 'complete')); },
  };
}

/** Stop at the first failure; earlier successes remain completed and are never uploaded again. */
export async function uploadQaDraftFiles(client: QaClient, issueId: string, files: QaDraftFile[], signal: AbortSignal,
  update: (id: string, patch: Partial<Pick<QaDraftFile, 'status' | 'progress'>>) => void) {
  for (const entry of files) {
    if (entry.status === 'complete' || entry.resume.attachment) { update(entry.id, { status: 'complete', progress: 100 }); continue; }
    qaThrowIfAborted(signal); update(entry.id, { status: 'uploading', progress: 0 });
    try {
      await client.upload(issueId, entry.file, percent => { if (!signal.aborted) update(entry.id, { progress: percent }); }, signal, entry.resume);
      qaThrowIfAborted(signal); update(entry.id, { status: 'complete', progress: 100 });
    } catch (error) { if (!signal.aborted) update(entry.id, { status: 'failed' }); else update(entry.id, { status: 'pending' }); throw error; }
  }
}

export default function QaDraftAttachments({ files, rejected, busy = false, onFiles, onRemove, onRetry }: {
  files: QaDraftFile[]; rejected: FileFailure[]; busy?: boolean; onFiles: (files: File[]) => void;
  onRemove: (id: string) => void; onRetry?: () => void;
}) {
  const { t } = useTranslation();
  const input = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false), [previewId, setPreviewId] = useState<string | null>(null);
  const preview = files.find(file => file.id === previewId);
  return <div className="min-w-0 space-y-3">
    <div className="flex flex-wrap items-center justify-between gap-2">
      <h3 className="flex items-center gap-2 text-sm font-semibold"><Paperclip className="h-4 w-4 text-muted-foreground" aria-hidden="true" />{t('qa.attachments')}{files.length > 0 && <span className="rounded bg-muted px-1.5 py-0.5 text-xs font-normal tabular-nums">{files.length}</span>}</h3>
      {onRetry && files.some(file => file.status === 'failed') && <button type="button" className={qaButton} disabled={busy} onClick={onRetry}><RotateCcw className="mr-1.5 h-3.5 w-3.5" aria-hidden="true" />{t('qa.retryUpload')}</button>}
    </div>
    <input ref={input} type="file" multiple className="hidden" accept={Object.keys(qaUploadFileTypes()).join(',')} aria-label={t('qa.attach')}
      disabled={busy} onChange={event => { const selected = Array.from(event.currentTarget.files || []); event.currentTarget.value = ''; if (!busy) onFiles(selected); }} />
    <button type="button" disabled={busy} onClick={() => input.current?.click()}
      onDragOver={event => { event.preventDefault(); if (!busy) setDragging(true); }} onDragLeave={() => setDragging(false)}
      onDrop={event => { event.preventDefault(); setDragging(false); if (!busy) onFiles(Array.from(event.dataTransfer.files)); }}
      className={`flex w-full flex-col items-center gap-1.5 rounded-lg border-2 border-dashed p-4 text-center transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary disabled:cursor-not-allowed disabled:opacity-50 ${dragging ? 'border-primary bg-primary/5' : 'border-border bg-muted/20 hover:border-primary/60 hover:bg-muted/40'}`}>
      <Upload className="h-5 w-5 text-muted-foreground" aria-hidden="true" /><span className="text-sm font-medium">{t('qa.dropFiles')}</span>
      <span className="text-xs text-muted-foreground">{t('qa.draftFileHint')}</span>
    </button>
    {rejected.length > 0 && <ul role="alert" className="space-y-1 rounded-lg border border-destructive/20 bg-destructive/5 p-3 text-sm text-destructive">{rejected.map((file, index) => <li key={index} className="break-words">{file.name}: {t(`qa.${file.code === 'file_size' ? 'fileSizeError' : file.code === 'file_type' ? 'fileTypeError' : 'fileNameError'}`)}</li>)}</ul>}
    {files.length > 0 && <ul className="space-y-2">{files.map(entry => <li key={entry.id} className="rounded-lg border border-border bg-muted/20 p-2.5">
      <div className="flex min-w-0 items-center gap-2.5">
        {entry.preview && entry.file.type.startsWith('image/') ? <img src={entry.preview} alt="" className="h-10 w-10 shrink-0 rounded object-cover" /> : <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded bg-muted">{entry.file.type.startsWith('video/') ? <Film className="h-4 w-4 text-muted-foreground" aria-hidden="true" /> : <FileText className="h-4 w-4 text-muted-foreground" aria-hidden="true" />}</span>}
        <div className="min-w-0 flex-1"><p className="break-all text-sm font-medium">{entry.file.name}</p><p className="mt-0.5 text-xs text-muted-foreground">{qaFileSize(entry.file.size)} · {t(`qa.fileStatus.${entry.status}`)}</p></div>
        {entry.status === 'complete' ? <CheckCircle2 className="h-4 w-4 shrink-0 text-emerald-600 dark:text-emerald-400" aria-label={t('qa.fileStatus.complete')} /> : entry.status === 'uploading' ? <Loader2 className="h-4 w-4 shrink-0 animate-spin text-primary" aria-hidden="true" /> : <button type="button" disabled={busy} onClick={() => onRemove(entry.id)} className="shrink-0 rounded p-2 text-muted-foreground hover:bg-muted hover:text-destructive focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary disabled:opacity-50" aria-label={t('qa.removeFile', { name: entry.file.name })}><X className="h-4 w-4" aria-hidden="true" /></button>}
        {entry.preview && <button type="button" className="shrink-0 rounded p-2 text-muted-foreground hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary" onClick={() => setPreviewId(previewId === entry.id ? null : entry.id)} aria-label={t('qa.previewFile', { name: entry.file.name })} aria-expanded={previewId === entry.id}><Eye className="h-4 w-4" aria-hidden="true" /></button>}
      </div>
      {entry.status === 'uploading' && <div className="mt-2 space-y-1"><progress max={100} value={entry.progress} aria-label={t('qa.uploadProgress', { percent: entry.progress })} className="h-1.5 w-full accent-primary" /><p role="status" className="text-right text-xs tabular-nums text-muted-foreground">{entry.progress}%</p></div>}
    </li>)}</ul>}
    {preview?.preview && <div className="rounded-lg border border-border bg-muted/20 p-3"><div className="mb-2 flex items-center justify-between gap-2"><span className="min-w-0 break-all text-sm">{preview.file.name}</span><button type="button" onClick={() => setPreviewId(null)} className={qaButton}>{t('qa.closePreview')}</button></div>{preview.file.type.startsWith('video/') ? <video src={preview.preview} controls preload="metadata" className="max-h-64 w-full rounded bg-black" /> : <img src={preview.preview} alt={preview.file.name} className="mx-auto max-h-64 max-w-full rounded object-contain" />}</div>}
  </div>;
}
