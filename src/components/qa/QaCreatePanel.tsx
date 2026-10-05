import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { CheckCircle2, Info } from 'lucide-react';
import type { QaClient } from '@/lib/qa/client';
import type { QaCreateInput } from '@/lib/qa/domain';
import type { ProductLine, Project } from '@/types';
import { useQaNavigationGuard } from '@/hooks/useQaNavigationGuard';
import QaReportForm from './QaReportForm';
import { qaErrorText, qaHasErrorText } from './qaErrorText';
import QaDraftAttachments, { uploadQaDraftFiles, useQaDraftFiles } from './QaDraftAttachments';

export default function QaCreatePanel({ client, projects, productLines, projectId, issueId, commandId, onCreated, onCancel, onBusyChange, fixedFooter = false }: {
  client: QaClient; projects: Project[]; productLines: ProductLine[]; projectId?: string;
  issueId: string; commandId: string; onCreated: (id: string) => void; onCancel: () => void;
  onBusyChange?: (busy: boolean) => void; fixedFooter?: boolean;
}) {
  const { t } = useTranslation(), draft = useQaDraftFiles();
  const [busy, setBusy] = useState(false), [createdId, setCreatedId] = useState<string | null>(null);
  const [locked, setLocked] = useState(false), [failed, setFailed] = useState(false);
  useQaNavigationGuard(busy || locked);
  const [errorCode, setErrorCode] = useState<string | null>(null);
  const active = useRef(true), running = useRef(false), completed = useRef(false), disabled = useRef(false);
  const controller = useRef<AbortController>(), created = useRef<string>(), frozen = useRef<QaCreateInput>();
  const callbacks = useRef({ onCreated, onBusyChange }); callbacks.current = { onCreated, onBusyChange };
  useEffect(() => {
    active.current = true;
    const abort = () => { disabled.current = true; controller.current?.abort(); };
    const preventLoss = (event: BeforeUnloadEvent) => { if (running.current) { event.preventDefault(); event.returnValue = ''; } };
    window.addEventListener('livo:qa-abort', abort); window.addEventListener('beforeunload', preventLoss);
    return () => { active.current = false; controller.current?.abort(); callbacks.current.onBusyChange?.(false); window.removeEventListener('livo:qa-abort', abort); window.removeEventListener('beforeunload', preventLoss); };
  }, []);
  const finish = (id: string) => {
    if (!active.current || disabled.current || completed.current) return;
    completed.current = true; callbacks.current.onCreated(id);
  };
  const submit = async (input: QaCreateInput) => {
    if (running.current || disabled.current || completed.current) return;
    running.current = true; setBusy(true); callbacks.current.onBusyChange?.(true); setFailed(false); setErrorCode(null);
    const request = new AbortController(); controller.current = request;
    try {
      if (!created.current) {
        // Freeze the payload as well as IDs: a lost response may already have created this Bug.
        frozen.current ??= { ...input }; setLocked(true);
        const issue = await client.create(frozen.current, issueId, commandId, request.signal);
        if (!active.current || request.signal.aborted) return;
        created.current = issue.id; setCreatedId(issue.id);
      }
      await uploadQaDraftFiles(client, created.current, draft.current.current, request.signal, draft.update);
      if (!request.signal.aborted) finish(created.current);
    } catch (error) {
      if (!active.current || request.signal.aborted) return;
      const failure = error as { status?: number; code?: string };
      // Definite validation/auth failures did not create a Bug, so users can correct the form.
      if (!created.current && [400, 401, 403, 404, 422].includes(failure.status || 0)) { frozen.current = undefined; setLocked(false); }
      setFailed(true); setErrorCode(typeof failure.code === 'string' && /^[a-z0-9_]+$/i.test(failure.code) ? failure.code : null);
    } finally {
      running.current = false;
      if (active.current) { setBusy(false); callbacks.current.onBusyChange?.(false); }
    }
  };
  return <div className={fixedFooter ? 'flex h-full min-h-0 min-w-0 flex-col gap-4' : 'min-w-0 space-y-4'}>
    {createdId && <div role="status" className="flex items-start gap-2 rounded-lg border border-border bg-muted/30 p-3 text-sm"><CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-primary" aria-hidden="true" /><p>{t('qa.createdAttachmentsPending')}</p></div>}
    {failed && <div role="alert" className="space-y-1 rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive"><p>{createdId ? t('qa.attachmentRetryHint') : locked ? t('qa.createRetryHint') : qaErrorText(t, { code: errorCode }).message}</p>{errorCode && !qaHasErrorText(t, errorCode) && <p className="break-all font-mono text-xs">{t('qa.errorCode', { code: errorCode })}</p>}</div>}
    <QaReportForm client={client} projects={projects} productLines={productLines} projectId={projectId} busy={busy} readOnly={locked} fixedFooter={fixedFooter}
      submitLabel={t(createdId ? 'qa.retryUpload' : locked ? 'qa.retryCreate' : 'qa.createBug')}
      cancelLabel={createdId ? t('qa.openWithoutPendingFiles') : undefined} cancelDisabled={locked && !createdId}
      onSubmit={input => void submit(input)} onCancel={() => { if (running.current) return; if (created.current) finish(created.current); else if (!frozen.current) onCancel(); }}>
      <QaDraftAttachments files={draft.files} rejected={draft.rejected} busy={busy} onFiles={files => { if (!running.current && !disabled.current) draft.add(files); }} onRemove={id => { if (!running.current) draft.remove(id); }} />
      <p className="mt-3 flex items-start gap-2 text-xs leading-relaxed text-muted-foreground"><Info className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />{t('qa.createAttachmentHint')}</p>
    </QaReportForm>
  </div>;
}
