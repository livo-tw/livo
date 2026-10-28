import { useState, useEffect, useRef } from 'react';
import { Zap, Trophy } from 'lucide-react';
import type { Sprint, PendingTaskAction } from '@/context/SprintContext';
import type { Task } from '@/types';
import { useIsMobile } from '@/hooks/use-mobile';
import { useTranslation } from 'react-i18next';

export type { PendingTaskAction } from '@/context/SprintContext';

interface SprintCompleteModalProps {
  currentSprint: Sprint | null;
  completedCount: number;
  cancelledCount?: number;
  pendingTasks: Task[];
  busy?: boolean;
  retryOnly?: boolean;
  onClose: () => void;
  onComplete: (action: PendingTaskAction) => void;
}

export const SprintCompleteModal = ({ currentSprint, completedCount, cancelledCount = 0, pendingTasks, busy = false, retryOnly = false, onClose, onComplete }: SprintCompleteModalProps) => {
  const { t } = useTranslation();
  const isMobile = useIsMobile();
  const [action, setAction] = useState<PendingTaskAction>('backlog');
  const dialogRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape' && !busy && !retryOnly) onClose(); };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [onClose, busy, retryOnly]);

  useEffect(() => {
    dialogRef.current?.focus();
  }, []);

  const PREVIEW_LIMIT = 5;
  const previewTasks = pendingTasks.slice(0, PREVIEW_LIMIT);
  const remaining = pendingTasks.length - PREVIEW_LIMIT;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" onClick={() => { if (!busy && !retryOnly) onClose(); }}>
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="sprint-complete-title"
        tabIndex={-1}
        className="bg-card rounded-xl shadow-xl border border-border p-0 w-full max-w-md max-h-[90dvh] overflow-y-auto outline-none"
        onClick={e => e.stopPropagation()}
      >
        <div className="bg-gradient-to-r from-primary/80 to-primary p-4 md:p-6 text-center">
          <Trophy className="mx-auto mb-2 text-yellow-300" size={isMobile ? 36 : 48} />
          <h2 id="sprint-complete-title" className="text-lg md:text-xl font-bold text-primary-foreground">{t('sprint.complete.title', { name: currentSprint?.name || '' })}</h2>
        </div>
        <div className="p-4 md:p-6 space-y-4">
          <p className="text-sm text-foreground" dangerouslySetInnerHTML={{ __html: t('sprint.complete.summary', { completedCount, pendingCount: pendingTasks.length }) }} />
          <p className="text-sm text-muted-foreground">{t('sprint.complete.cancelledSummary', { count: cancelledCount })}</p>
          <p className="text-xs text-muted-foreground">{t('sprint.complete.historyHint')}</p>
          {retryOnly && <p role="status" className="text-sm text-amber-600">{t('sprint.commandUncertain')}</p>}

          {pendingTasks.length > 0 && (
            <div className="space-y-3">
              <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">{t('sprint.complete.optionsLabel')}</p>
              <div className="space-y-2">
                {([
                  { value: 'backlog' as PendingTaskAction, label: t('sprint.complete.backlogLabel'), desc: t('sprint.complete.backlogDesc') },
                  { value: 'next-sprint' as PendingTaskAction, label: t('sprint.complete.nextSprintLabel'), desc: t('sprint.complete.nextSprintDesc') },
                ] as const).map(opt => (
                  <label
                    key={opt.value}
                    className={`flex items-start gap-2.5 p-2.5 rounded-lg border cursor-pointer transition-colors ${action === opt.value ? 'border-primary bg-primary/5' : 'border-border hover:bg-accent/40'}`}
                  >
                    <input
                      type="radio"
                      name="pending-action"
                      value={opt.value}
                      checked={action === opt.value}
                      disabled={busy || retryOnly}
                      onChange={() => setAction(opt.value)}
                      className="mt-0.5 accent-primary"
                    />
                    <div>
                      <p className="text-sm font-medium text-foreground">{opt.label}</p>
                      <p className="text-xs text-muted-foreground">{opt.desc}</p>
                    </div>
                  </label>
                ))}
              </div>

              <div className="rounded-lg bg-muted/50 border border-border p-3 space-y-1">
                <p className="text-xs font-medium text-muted-foreground mb-1.5">{t('sprint.complete.pendingList')}</p>
                {previewTasks.map(t => (
                  <p key={t.id} className="text-xs text-foreground truncate">• [{t.taskKey}] {t.title}</p>
                ))}
                {remaining > 0 && (
                  <p className="text-xs text-muted-foreground">{t('sprint.complete.moreItems', { count: remaining })}</p>
                )}
              </div>
            </div>
          )}

          <div className="flex gap-2 pt-1">
            <button onClick={onClose} disabled={busy || retryOnly} className="flex-1 py-2.5 rounded-md text-sm font-medium border border-border text-foreground hover:bg-accent transition-colors disabled:opacity-50">{t('common.cancel')}</button>
            <button onClick={() => onComplete(action)} disabled={busy} className="flex-1 py-2.5 rounded-md text-sm font-medium bg-primary text-primary-foreground hover:bg-primary/90 transition-colors disabled:opacity-50">{t(busy ? 'sprint.processing' : retryOnly ? 'sprint.retryOriginal' : 'button.confirmComplete')}</button>
          </div>
        </div>
      </div>
    </div>
  );
};

interface SprintStartModalProps {
  defaultName: string;
  onClose: () => void;
  onConfirm: (name: string, includeBacklog: boolean) => void;
  closeable?: boolean;
  carryOverCount?: number;
  excludedCarryCount?: number;
  /** Open backlog tasks the sprint takes in when the box is ticked. */
  backlogCount?: number;
  busy?: boolean;
  retryOnly?: boolean;
}

export const SprintStartModal = ({ defaultName, onClose, onConfirm, closeable = true, carryOverCount = 0, excludedCarryCount = 0, backlogCount, busy = false, retryOnly = false }: SprintStartModalProps) => {
  const { t } = useTranslation();
  const [name, setName] = useState(defaultName);
  const [includeBacklog, setIncludeBacklog] = useState(false);
  const dialogRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape' && closeable && !busy && !retryOnly) onClose(); };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [onClose, closeable, busy, retryOnly]);

  useEffect(() => {
    dialogRef.current?.focus();
  }, []);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" onClick={() => { if (closeable && !busy && !retryOnly) onClose(); }}>
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="sprint-start-title"
        tabIndex={-1}
        className="bg-card rounded-xl shadow-xl border border-border p-0 w-full max-w-sm max-h-[90dvh] overflow-y-auto outline-none"
        onClick={e => e.stopPropagation()}
      >
        <div className="bg-gradient-to-r from-primary/80 to-primary p-4 md:p-5 text-center">
          <Zap className="mx-auto mb-1 text-yellow-300" size={36} />
          <h2 id="sprint-start-title" className="text-lg font-bold text-primary-foreground">{t('sprint.start.title')}</h2>
        </div>
        <div className="p-4 md:p-5 space-y-4">
          <div>
            <label htmlFor="sprint-name-input" className="text-xs font-medium text-foreground mb-1 block">{t('sprint.start.nameLabel')}</label>
            <input
              id="sprint-name-input"
              type="text"
              value={name}
              maxLength={120}
              disabled={busy || retryOnly}
              onChange={e => setName(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter' && name.trim() && !busy) onConfirm(name.trim(), includeBacklog); }}
              className="w-full border border-border rounded-lg px-3 py-2 text-sm bg-background text-foreground outline-none focus:ring-2 focus:ring-primary"
              autoFocus
            />
          </div>
          <label className="flex items-center gap-2 cursor-pointer">
            <input
              type="checkbox"
              checked={includeBacklog}
              disabled={busy || retryOnly}
              onChange={e => setIncludeBacklog(e.target.checked)}
              className="accent-primary"
            />
            <span className="text-sm text-foreground">{backlogCount === undefined ? t('sprint.start.includeBacklog') : t('sprint.start.includeBacklogCount', { count: backlogCount })}</span>
          </label>
          <p className="text-xs text-muted-foreground">{t('sprint.start.scopeHint')}</p>
          {backlogCount !== undefined && <p className="text-sm font-medium">{t('sprint.start.selectedCount', { count: carryOverCount + (includeBacklog ? backlogCount : 0) })}</p>}
          {retryOnly && <p role="status" className="text-sm text-amber-600">{t('sprint.commandUncertain')}</p>}
          {carryOverCount > 0 && (
            <p className="text-xs text-muted-foreground">{t('sprint.start.carryOverHint', { count: carryOverCount })}</p>
          )}
          {excludedCarryCount > 0 && <p className="text-xs text-muted-foreground">{t('sprint.start.archivedCarryHint', { count: excludedCarryCount })}</p>}
          <div className="flex gap-2">
            {closeable && (
              <button onClick={onClose} disabled={busy || retryOnly} className="flex-1 py-2.5 rounded-md text-sm font-medium border border-border text-foreground hover:bg-accent transition-colors disabled:opacity-50">{t('common.cancel')}</button>
            )}
            <button onClick={() => name.trim() && onConfirm(name.trim(), includeBacklog)} disabled={!name.trim() || busy} className="flex-1 py-2.5 rounded-md text-sm font-medium bg-primary text-primary-foreground hover:bg-primary/90 transition-colors disabled:opacity-50">{t(busy ? 'sprint.processing' : retryOnly ? 'sprint.retryOriginal' : 'button.startSprint')}</button>
          </div>
        </div>
      </div>
    </div>
  );
};
