import { Link2, X } from 'lucide-react';
import { useId, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { useUIContext } from '@/context/UIContext';
import { useIsMobile } from '@/hooks/use-mobile';
import { useFocusTrap } from '@/hooks/useFocusTrap';
import { copyText } from '@/lib/clipboard';
import { hasQaNavigationGuard } from '@/lib/qa/navigationGuard';
import { IS_DEMO_PRO } from '@/lib/demoMode';
import { DEMO_BANNER_HEIGHT } from '@/components/DemoModeBanner';
import { RecordViewModeButtons } from '@/components/ui/record-view-mode-buttons';

export default function QaRecordView({ title, creating = false, busy, suspended = false, onClose, children }: {
  title: string; creating?: boolean; busy: boolean;
  /** A task opened on top (a linked task, Ctrl+K, a notification): hidden, kept as is, shown again when the task closes. */
  suspended?: boolean;
  onClose: () => void; children: ReactNode;
}) {
  const { t } = useTranslation();
  const { taskDisplayMode = 'modal', setTaskDisplayMode } = useUIContext();
  const isMobile = useIsMobile();
  const mode = creating || isMobile ? 'modal' : taskDisplayMode;
  const focus = useFocusTrap(mode === 'modal' && !suspended);
  const titleId = useId();
  const top = IS_DEMO_PRO ? DEMO_BANNER_HEIGHT : 0;
  const close = () => { if (!busy && !hasQaNavigationGuard()) onClose(); else toast.info(t('qa.finishPending')); };
  return <div ref={focus} role="dialog" aria-modal={mode === 'modal' || undefined} aria-labelledby={titleId} hidden={suspended}
    className={suspended ? 'hidden' : mode === 'page' ? 'flex min-h-0 w-full flex-1 flex-col bg-card' : mode === 'side' ? 'fixed bottom-0 right-0 z-50 flex w-[min(960px,100vw)] flex-col border-l border-border bg-card shadow-xl' : 'fixed inset-0 z-50 flex items-start justify-center bg-black/50 md:pt-6'}
    style={mode === 'page' ? undefined : { top: `calc(var(--livo-viewport-top, 0px) + ${top}px)`, height: `calc(var(--livo-viewport-height, 100dvh) - ${top}px)`, bottom: 'auto' }}
    onKeyDown={event => { if (event.key === 'Escape' && !event.defaultPrevented && (event.target as HTMLElement).closest('[role="dialog"]') === event.currentTarget && !(event.target as HTMLElement).closest('[data-radix-popper-content-wrapper], [role="listbox"]')) { event.preventDefault(); close(); } }}
    onClick={event => { if (!isMobile && mode === 'modal' && event.target === event.currentTarget) close(); }}>
    <div className={`flex min-h-0 flex-col bg-card ${mode === 'modal' ? 'h-full w-full shadow-xl md:rounded-lg' : 'flex-1'}`}
      style={mode === 'modal' && !isMobile ? { width: 'min(1280px, calc(100vw - 32px))', height: `calc(var(--livo-viewport-height, 100dvh) - 48px - ${top}px)` } : undefined}>
      <header className="flex shrink-0 items-center justify-between gap-3 border-b border-border px-3 py-3 sm:px-4" style={isMobile ? { paddingTop: 'max(12px, env(safe-area-inset-top))' } : undefined}>
        <h2 id={titleId} className="min-w-0 truncate text-sm font-semibold">{title}</h2>
        <div className="flex shrink-0 items-center gap-0.5">
          {!creating && !isMobile && <RecordViewModeButtons value={taskDisplayMode} onChange={value => { if (!busy && !hasQaNavigationGuard()) setTaskDisplayMode(value); }} disabled={busy} />}
          {!creating && <button type="button" className="inline-flex min-h-11 min-w-11 items-center justify-center rounded p-1.5 text-muted-foreground hover:bg-accent sm:min-h-8 sm:min-w-8" aria-label={t('task.copyLink')} title={t('task.copyLink')} onClick={async () => { if (await copyText(window.location.href)) toast.success(t('qa.copyLinkSuccess')); }}><Link2 size={15} aria-hidden="true" /></button>}
          <button type="button" className="inline-flex min-h-11 min-w-11 items-center justify-center rounded p-1.5 text-muted-foreground hover:bg-accent disabled:opacity-50 sm:min-h-8 sm:min-w-8" disabled={busy} aria-label={t('common.close')} title={t('common.close')} onClick={close}><X size={16} aria-hidden="true" /></button>
        </div>
      </header>
      <div className={`min-h-0 min-w-0 flex-1 overscroll-contain ${creating ? 'overflow-hidden' : 'overflow-y-auto pb-[env(safe-area-inset-bottom)]'}`}>{children}</div>
    </div>
  </div>;
}
