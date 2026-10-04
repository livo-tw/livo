import { safeLinkHref } from '@/lib/safeLink';
import { useEffect, useLayoutEffect, useRef, useState, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { registerReleaseNavigationGuard } from './navigation';
import { ReleaseError, releaseError, type ReleaseBatch } from '@/lib/releases/core';
import type { createReleaseClient, ReleaseIntent } from '@/lib/releases/client';

export type ReleaseClient = ReturnType<typeof createReleaseClient>;
export const releaseButton = 'inline-flex items-center justify-center gap-2 rounded-md border border-border bg-background px-3 py-2 text-sm font-medium hover:bg-accent disabled:cursor-not-allowed disabled:opacity-50';
export const releasePrimary = `${releaseButton} border-primary bg-primary text-primary-foreground hover:bg-primary/90`;
const fieldClass = 'w-full rounded-md border border-input bg-background px-3 py-2 text-sm disabled:opacity-60';
export function ReleaseField({ label, ...props }: InputHTMLAttributes<HTMLInputElement> & { label: string }) {
  return <label className="grid gap-1.5 text-sm"><span>{label}</span><input className={fieldClass} {...props} /></label>;
}
export function ReleaseSelect({ label, children, ...props }: SelectHTMLAttributes<HTMLSelectElement> & { label: string; children: ReactNode }) {
  return <label className="grid gap-1.5 text-sm"><span>{label}</span><select className={fieldClass} {...props}>{children}</select></label>;
}
export function ReleaseText({ label, value, onChange, maxLength = 2000, required = true }: { label: string; value: string; onChange: (value: string) => void; maxLength?: number; required?: boolean }) {
  return <label className="grid gap-1.5 text-sm"><span>{label}</span><textarea className={`${fieldClass} min-h-24`} value={value} maxLength={maxLength} required={required} onChange={e => onChange(e.target.value)} /></label>;
}
export function ReleaseFailure({ error }: { error: unknown }) {
  const { t } = useTranslation();
  return <p role="alert" className="rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">{t(`releaseWorkspace.errors.${releaseError(error).code}`)}</p>;
}
export function ReleaseLink({ url }: { url: string | null }) {
  const { t } = useTranslation();
  const href = safeLinkHref(url);
  if (!href) return null;
  return <a className="text-primary underline" href={href} target="_blank" rel="noopener noreferrer">{t('releaseWorkspace.openEvidence')}</a>;
}
export function useReleaseSubmit(client: ReleaseClient, onSaved: (batch: ReleaseBatch) => void) {
  const { t } = useTranslation();
  const [busy, setBusy] = useState(false), [error, setError] = useState<unknown>(null), [uncertain, setUncertain] = useState(false);
  const alive = useRef(true), flight = useRef(false), pinned = useRef<ReleaseIntent | null>(null);
  const saved = useRef(onSaved); saved.current = onSaved;
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  useLayoutEffect(() => registerReleaseNavigationGuard(() => toast.info(t('releaseWorkspace.finishForm'))), [t]);
  const submit = async (intent: ReleaseIntent) => {
    if (flight.current) return;
    flight.current = true; setBusy(true); setError(null);
    pinned.current ??= structuredClone(intent);
    try {
      const result = await client.execute(pinned.current);
      if (alive.current) { setUncertain(false); saved.current(result.batch); }
    } catch (failure) {
      if (alive.current) {
        const unknownResult = failure instanceof ReleaseError && failure.code === 'release_transport_error';
        setError(failure); setUncertain(unknownResult);
        if (!unknownResult) pinned.current = null;
      }
    } finally { flight.current = false; if (alive.current) setBusy(false); }
  };
  return { busy, error, uncertain, submit };
}
export function SubmitFooter({ busy, uncertain, onCancel, submitDisabled = false }: { busy: boolean; uncertain: boolean; onCancel: () => void; submitDisabled?: boolean }) {
  const { t } = useTranslation();
  return <><p className="text-xs text-muted-foreground">{t(uncertain ? 'releaseWorkspace.retryHint' : 'releaseWorkspace.saveHint')}</p><div className="flex gap-2"><button type="submit" disabled={busy || submitDisabled} className={releasePrimary}>{t(busy ? 'releaseWorkspace.saving' : uncertain ? 'releaseWorkspace.retry' : 'releaseWorkspace.confirmSave')}</button><button type="button" disabled={busy || uncertain} className={releaseButton} onClick={onCancel}>{t('releaseWorkspace.cancelForm')}</button></div></>;
}
