import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { QaAttachment } from '@/lib/qa/domain';
import type { QaClient } from '@/lib/qa/client';
import { qaButton } from './QaFields';

export default function QaAttachments({ issueId, attachments, client, onChanged, onError }: { issueId: string; attachments: QaAttachment[]; client: QaClient; onChanged: () => Promise<void>; onError: (error: unknown) => void }) {
  const { t } = useTranslation();
  const [progress, setProgress] = useState<number | null>(null);
  const [loading, setLoading] = useState<string | null>(null);
  const [retryFile, setRetryFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<{ url: string; file: QaAttachment } | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const active = useRef(true), downloadController = useRef<AbortController>();
  const uploadController = useRef<AbortController>();
  useEffect(() => {
    active.current = true;
    const abort = () => { downloadController.current?.abort(); uploadController.current?.abort(); setPreview(null); setProgress(null); setLoading(null); setRetryFile(null); };
    window.addEventListener('livo:qa-abort', abort);
    return () => { active.current = false; downloadController.current?.abort(); uploadController.current?.abort(); window.removeEventListener('livo:qa-abort', abort); };
  }, []);
  useEffect(() => () => { if (preview) URL.revokeObjectURL(preview.url); }, [preview]);
  const upload = async (file: File) => {
    setProgress(0); setRetryFile(null);
    const controller = new AbortController(); uploadController.current?.abort(); uploadController.current = controller;
    try { await client.upload(issueId, file, percent => { if (active.current && !controller.signal.aborted) setProgress(percent); }, controller.signal); if (active.current && !controller.signal.aborted) await onChanged(); }
    catch (error) { if (active.current && !controller.signal.aborted) { setRetryFile(file); onError(error); } }
    finally { if (active.current) { setProgress(null); if (fileInput.current) fileInput.current.value = ''; } }
  };
  const open = async (file: QaAttachment) => {
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
    <input ref={fileInput} type="file" className="hidden" accept="*/*" aria-label={t('qa.attach')} onChange={event => { const file = event.target.files?.[0]; if (file) void upload(file); }} />
    <button type="button" className={qaButton} disabled={progress !== null} onClick={() => fileInput.current?.click()}>{t('qa.attach')}</button>
    {progress !== null && <p role="status" className="text-sm">{t('qa.uploadProgress', { percent: progress })}</p>}
    {retryFile && <button type="button" className={qaButton} onClick={() => void upload(retryFile)}>{t('qa.retryUpload')}: {retryFile.name}</button>}
    <ul className="space-y-2">{attachments.map(file => <li key={file.id} className="flex flex-wrap items-center justify-between gap-2 rounded border border-border p-2 text-sm"><span className="min-w-0 break-all">{file.fileName} <span className="text-muted-foreground">({(file.size / 1024 / 1024).toFixed(1)} MB)</span></span><button type="button" className={qaButton} disabled={loading !== null} onClick={() => void open(file)}>{t(loading === file.id ? 'qa.downloading' : 'qa.view')}</button></li>)}</ul>
    {preview && <div className="space-y-3 rounded-lg border border-border bg-muted/30 p-3">
      <div className="flex flex-wrap items-center justify-between gap-2"><span className="break-all text-sm">{preview.file.fileName}</span><button type="button" className={qaButton} onClick={() => setPreview(null)}>{t('qa.closePreview')}</button></div>
      {/^(video\/(mp4|webm|ogg|quicktime))$/i.test(preview.file.mimeType) && <video className="max-h-[60vh] w-full rounded bg-black" controls preload="metadata" src={preview.url} />}
      {/^(image\/(png|jpeg|gif|webp|avif))$/i.test(preview.file.mimeType) && <img className="max-h-[60vh] max-w-full object-contain" src={preview.url} alt={preview.file.fileName} />}
      <a href={preview.url} download={preview.file.fileName} className={`${qaButton} no-underline`}>{t('qa.download')}</a>
    </div>}
  </div>;
}
