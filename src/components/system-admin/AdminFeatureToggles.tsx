import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { SlidersHorizontal } from 'lucide-react';
import { toast } from 'sonner';
import { useAuthContext } from '@/context/AuthContext';
import { useUIContext } from '@/context/UIContext';
import { useTaskContext } from '@/context/TaskContext';
import { useApprovalWorkflow } from '@/hooks/useApprovalWorkflow';
import { FEATURE_TOGGLES, canManageFeatureToggles, type FeatureKey } from '@/lib/featureToggles';
import { fetchPendingFeatureApprovals, type PendingFeatureApproval } from '@/lib/featureToggleQueries';
import { withdrawAllAndDisable } from '@/lib/withdrawApproval';
import { Switch } from '@/components/ui/switch';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog';

export default function AdminFeatureToggles() {
  const { t } = useTranslation();
  const { currentMember } = useAuthContext();
  const { featureToggles, featureTogglesReady, featureTogglesError, refreshFeatureToggles, saveFeatureToggle } = useUIContext();
  const { refreshTasks } = useTaskContext();
  const { cancelApproval } = useApprovalWorkflow();
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState<PendingFeatureApproval[] | null>(null);
  const [failure, setFailure] = useState(false);

  if (!canManageFeatureToggles(currentMember?.role)) return null;

  const save = async (key: FeatureKey, enabled: boolean) => {
    if (busy) return;
    setBusy(true);
    setFailure(false);
    try {
      if (key === 'approvals' && !enabled) {
        const requests = await fetchPendingFeatureApprovals();
        if (requests.length) { setPending(requests); return; }
      }
      await saveFeatureToggle(key, enabled);
      toast.success(t('featureToggles.saved'));
    } catch (error) {
      console.error('[LIVO] Feature toggle save failed:', error);
      setFailure(true);
    } finally {
      setBusy(false);
    }
  };

  const withdrawAndDisable = async () => {
    if (busy || !pending) return;
    setBusy(true);
    setFailure(false);
    try {
      await withdrawAllAndDisable(pending, id => cancelApproval(id, { silent: true }),
        fetchPendingFeatureApprovals, () => saveFeatureToggle('approvals', false));
      setPending(null);
      toast.success(t('featureToggles.saved'));
    } catch (error) {
      console.error('[LIVO] Withdrawal did not complete:', error);
      setFailure(true);
      try { setPending(await fetchPendingFeatureApprovals()); } catch { /* Keep the last reviewed list. */ }
    } finally {
      try { await refreshTasks(); }
      catch (error) { console.error('[LIVO] Could not refresh withdrawn tasks:', error); }
      finally { setBusy(false); }
    }
  };

  return (
    <section className="rounded-lg border border-border bg-gradient-to-b from-card to-muted/20 p-4 shadow-sm md:p-6" aria-labelledby="feature-toggles-title">
      <h2 id="feature-toggles-title" className="flex items-center gap-2 text-base font-semibold">
        <SlidersHorizontal size={18} className="text-primary" />{t('featureToggles.title')}
      </h2>
      <p className="mt-1 text-sm text-muted-foreground">{t('featureToggles.description')}</p>
      {FEATURE_TOGGLES.map(feature => (
        <div key={feature.key} className="mt-4 flex items-center justify-between gap-4 rounded-lg border border-border bg-background/70 p-4 shadow-sm">
          <div className="min-w-0">
            <label htmlFor={`feature-${feature.key}`} className="font-medium">{t(feature.label)}</label>
            <p id={`feature-${feature.key}-description`} className="mt-1 text-sm text-muted-foreground">{t(feature.description)}</p>
          </div>
          <Switch id={`feature-${feature.key}`} aria-describedby={`feature-${feature.key}-description`}
            checked={featureToggles[feature.key]} disabled={busy || !featureTogglesReady}
            onCheckedChange={enabled => void save(feature.key, enabled)} />
        </div>
      ))}
      {featureTogglesError && <div role="alert" className="mt-3 text-sm text-destructive">
        {t('featureToggles.loadFailed')}
        <Button variant="outline" size="sm" className="ml-2" onClick={() => void refreshFeatureToggles()}>{t('featureToggles.retry')}</Button>
      </div>}
      {failure && !pending && <p role="alert" className="mt-3 text-sm text-destructive">{t('featureToggles.saveFailed')}</p>}
      {busy && <p role="status" className="mt-3 text-sm text-muted-foreground">{t('featureToggles.saving')}</p>}
      <Dialog open={pending !== null} onOpenChange={open => { if (!open && !busy) { setPending(null); setFailure(false); } }}>
        <DialogContent className="max-h-[85vh] max-w-lg overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{t('featureToggles.withdrawTitle')}</DialogTitle>
            <DialogDescription>{t('featureToggles.pendingDescription', { count: pending?.length ?? 0 })}</DialogDescription>
          </DialogHeader>
          <ul className="max-h-64 space-y-2 overflow-y-auto rounded-lg border border-border p-3">
            {pending?.map(request => <li key={request.id} className="text-sm">
              <a className="text-primary underline underline-offset-2 break-words" href={`${import.meta.env.BASE_URL}task/${encodeURIComponent(request.task.id)}`} target="_blank" rel="noreferrer">
                {request.task.task_key} · {request.task.title}
              </a>
            </li>)}
          </ul>
          <p className="text-sm text-muted-foreground">{t('featureToggles.historyKept')}</p>
          {failure && <p role="alert" className="text-sm text-destructive">{t('featureToggles.withdrawFailed')}</p>}
          <DialogFooter className="gap-2">
            <Button variant="outline" disabled={busy} onClick={() => { setPending(null); setFailure(false); }}>{t('button.cancel')}</Button>
            <Button disabled={busy} onClick={() => void withdrawAndDisable()} className="shadow-sm">{t(busy ? 'featureToggles.saving' : 'featureToggles.withdrawAndDisable')}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}
