import { useUIContext } from '@/context/UIContext';
import TaskDetailContent from '@/components/TaskDetailContent';
import { useIsMobile } from '@/hooks/use-mobile';
import { useMediaQuery } from '@/hooks/use-media-query';
import { useFocusTrap } from '@/hooks/useFocusTrap';
import { useTranslation } from 'react-i18next';
import { IS_DEMO_PRO } from '@/lib/demoMode';
import { DEMO_BANNER_HEIGHT } from '@/components/DemoModeBanner';

const TaskDetailModal = () => {
  const { selectedTask, setSelectedTask, taskDisplayMode } = useUIContext();
  const isMobile = useIsMobile();
  const compactTaskLayout = useMediaQuery('(max-width: 1023px)');
  const { t } = useTranslation();
  const showModal = taskDisplayMode === 'modal' || (compactTaskLayout && taskDisplayMode === 'side');
  const focusTrapRef = useFocusTrap(!!selectedTask && showModal);

  if (!selectedTask || !showModal) return null;

  // The demo banner is a 44px fixed bar at z-[10000] (above this z-50 modal).
  // A plain fixed inset-0 modal would sit UNDER it and clip the task header —
  // offset the overlay (and shrink the card) below the banner when in demo.
  const topOffset = IS_DEMO_PRO ? DEMO_BANNER_HEIGHT : 0;

  return (
    <div
      ref={focusTrapRef}
      role="dialog"
      aria-modal="true"
      aria-label={selectedTask.title}
      className="fixed inset-0 z-50 flex items-start justify-center pt-0 md:pt-6 bg-black/50"
      style={{ top: `calc(var(--livo-viewport-top, 0px) + ${topOffset}px)`, height: `calc(var(--livo-viewport-height, 100dvh) - ${topOffset}px)`, bottom: 'auto' }}
      onKeyDown={e => {
        // A portaled picker owns its Escape; a child may also handle it first.
        if (e.key === 'Escape' && !e.defaultPrevented && e.currentTarget.contains(e.target as Node)) setSelectedTask(null);
      }}
      onClick={e => { if (!isMobile && e.target === e.currentTarget) setSelectedTask(null); }}
    >
      <div
        className={`bg-card shadow-xl flex flex-col min-h-0 ${
          isMobile
            ? 'w-full h-full'
            : 'rounded-lg'
        }`}
        style={isMobile ? {} : { width: 'min(1280px, calc(100vw - 32px))', height: `calc(var(--livo-viewport-height, 100dvh) - 48px - ${topOffset}px)`, overflow: 'hidden' }}
        onClick={e => e.stopPropagation()}
      >
        <div className="flex-1 min-h-0 overflow-hidden flex flex-col">
          <TaskDetailContent onClose={() => setSelectedTask(null)} />
        </div>
        {/* Explicit close button so users aren't forced to hunt for the ✕ */}
        <div className="livo-safe-footer flex-shrink-0 border-t border-border px-4 py-2.5 flex justify-end bg-card">
          <button
            type="button"
            onClick={() => setSelectedTask(null)}
            className="min-h-11 px-5 py-1.5 rounded-md text-sm font-medium bg-primary text-primary-foreground hover:bg-primary/90 transition-colors"
          >
            {t('common.close')}
          </button>
        </div>
      </div>
    </div>
  );
};

export default TaskDetailModal;
