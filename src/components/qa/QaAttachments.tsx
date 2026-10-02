import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Download, FileText, Film, Loader2 } from 'lucide-react';
import type { QaAttachment } from '@/lib/qa/domain';
import type { QaClient } from '@/lib/qa/client';
import { qaButton } from './QaFields';
import QaDraftAttachments, { qaFileSize, uploadQaDraftFiles, useQaDraftFiles } from './QaDraftAttachments';

export default function QaAttachments({ issueId, attachments, client, onChanged, onError, onBusyChange }: { issueId: string; attachments: QaAttachment[]; client: QaClient; onChanged: () => Promise<void>; onError: (error: unknown) => void; onBusyChange?: (busy: boolean) => void }) {
  const { t } = useTranslation();
  const draft = useQaDraftFiles();
  const [busy, setBusy] = useState(false), [refreshFailed, setRefreshFailed] = useState(false);
  const [loading, setLoading] = useState<string | null>(null);
  const [preview, setPreview] = useState<{ url: string; file: QaAttachment } | null>(null);
  const active = useRef(true), running = useRef(false), disabled = useRef(false), downloadController = useRef<AbortController>();
  const uploadController = useRef<AbortController>();
  const busyCallback = useRef(onBusyChange); busyCallback.current = onBusyChange;
  useEffect(() => {
    active.current = true;
    const abort = () => { disabled.current = true; downloadController.current?.abort(); uploadController.current?.abort(); setPreview(null); setBusy(false); busyCallback.current?.(false); setLoading(null); };
    const preventLoss = (event: BeforeUnloadEvent) => { if (running.current) { event.preventDefault(); event.returnValue = ''; } };
    window.addEventListener('livo:qa-abort', abort);
    window.addEventListener('beforeunload', preventLoss);
    return () => { active.current = false; downloadController.current?.abort(); uploadController.current?.abort(); busyCallback.current?.(false); window.removeEventListener('livo:qa-abort', abort); window.removeEventListener('beforeunload', preventLoss); };
  }, []);
  useEffect(() => () => { if (preview) URL.revokeObjectURL(preview.url); }, [preview]);
  const upload = async () => {
    if (running.current || disabled.current) return;
    running.current = true; setBusy(true); busyCallback.current?.(true); setRefreshFailed(false);
    const controller = new AbortController(); uploadController.current = controller;
    let uploaded = false;
    try {
      await uploadQaDraftFiles(client, issueId, draft.current.current, controller.signal, draft.update);
      if (!active.current || controller.signal.aborted) return;
      uploaded = true; await onChanged();
      if (active.current && !controller.signal.aborted) draft.clearCompleted();
    } catch (error) { if (active.current && !controller.signal.aborted) { setRefreshFailed(uploaded); onError(error); } }
    finally { running.current = false; if (active.current) { setBusy(false); busyCallback.current?.(false); } }
  };
  const open = async (file: QaAttachment) => {
    if (disabled.current) return;
    downloadController.current?.abort(); const controller = new AbortController(); downloadController.current = controller; setLoading(file.id);
    try {
      const blob = await client.download(file.id, controller.signal);
      if (!active.current || controller.signal.aborted) return;
      // Only verified raster/video MIME types are embedded; HTML/SVG/documents are downloads.
      setPreview({ url: URL.createObjectURL(blob), file });
    } catch (error) { if (active.current && !controller.signal.aborted) onError(error); }
    finally { if (active.current && !controller.signal.aborted) setLoading(null); }
  };
  return <div className="space-y-3">
    <p className="text-sm text-muted-foreground">{t('qa.attachmentHint')}</p>
    <QaDraftAttachments files={draft.files} rejected={draft.rejected} busy={busy} onFiles={files => { if (!running.current && !disabled.current && draft.add(files).length) void upload(); }} onRemove={id => { if (!running.current) draft.remove(id); }} onRetry={() => void upload()} />
    {refreshFailed && <div role="alert" className="flex flex-wrap items-center gap-2 text-sm"><p className="text-muted-foreground">{t('qa.attachmentsRefreshFailed')}</p><button type="button" className={qaButton} disabled={busy} onClick={() => void upload()}>{t('qa.reload')}</button></div>}
    <ul className="space-y-2">{attachments.map(file => <li key={file.id} className="flex min-w-0 flex-wrap items-center gap-3 rounded-lg border border-border bg-card p-3 text-sm">
      <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-muted">{file.mimeType.startsWith('video/') ? <Film className="h-4 w-4 text-muted-foreground" aria-hidden="true" /> : <FileText className="h-4 w-4 text-muted-foreground" aria-hidden="true" />}</span>
      <div className="min-w-0 flex-1"><p className="break-all font-medium">{file.fileName}</p><p className="mt-0.5 text-xs text-muted-foreground">{qaFileSize(file.size)}</p></div>
      <button type="button" className={`${qaButton} shrink-0`} disabled={loading !== null} onClick={() => void open(file)}>{loading === file.id ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" aria-hidden="true" /> : <Download className="mr-1.5 h-3.5 w-3.5" aria-hidden="true" />}{t(loading === file.id ? 'qa.downloading' : 'qa.view')}</button>
    </li>)}</ul>
    {preview && <div className="space-y-3 rounded-lg border border-border bg-muted/30 p-3">
      <div className="flex flex-wrap items-center justify-between gap-2"><span className="break-all text-sm">{preview.file.fileName}</span><button type="button" className={qaButton} onClick={() => setPreview(null)}>{t('qa.closePreview')}</button></div>
      {/^(video\/(mp4|webm))$/i.test(preview.file.mimeType) && <video className="max-h-[60vh] w-full rounded bg-black" controls preload="metadata" src={preview.url} />}
      {/^(image\/(png|jpeg|gif|webp))$/i.test(preview.file.mimeType) && <img className="max-h-[60vh] max-w-full object-contain" src={preview.url} alt={preview.file.fileName} />}
      <a href={preview.url} download={preview.file.fileName} className={`${qaButton} no-underline`}>{t('qa.download')}</a>
    </div>}
  </div>;
}
