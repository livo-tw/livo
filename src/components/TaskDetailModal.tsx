import { useUIContext } from '@/context/UIContext';
import TaskDetailContent from '@/components/TaskDetailContent';
import { useIsMobile } from '@/hooks/use-mobile';
import { useFocusTrap } from '@/hooks/useFocusTrap';
import { useTranslation } from 'react-i18next';
import { IS_DEMO_PRO } from '@/lib/demoMode';
import { DEMO_BANNER_HEIGHT } from '@/components/DemoModeBanner';

const TaskDetailModal = () => {
  const { selectedTask, setSelectedTask, taskDisplayMode } = useUIContext();
  const isMobile = useIsMobile();
  const { t } = useTranslation();
  const focusTrapRef = useFocusTrap(!!selectedTask && taskDisplayMode === 'modal');

  if (!selectedTask || taskDisplayMode !== 'modal') return null;

  // The demo banner is a 44px fixed bar at z-[10000] (above this z-50 modal).
  // A plain fixed inset-0 modal would sit UNDER it and clip the task header —
  // offset the overlay (and shrink the card) below the banner when in demo.
  const topOffset = IS_DEMO_PRO ? DEMO_BANNER_HEIGHT : 0;

  return (
    <div
      ref={focusTrapRef}
      role="dialog"
      aria-modal="true"
      className="fixed inset-0 z-50 flex items-start justify-center pt-0 md:pt-6 bg-black/50"
      style={{ top: topOffset }}
      onKeyDown={e => e.key === 'Escape' && setSelectedTask(null)}
      onClick={e => { if (!isMobile && e.target === e.currentTarget) setSelectedTask(null); }}
    >
      <div
        className={`bg-card shadow-xl flex flex-col min-h-0 ${
          isMobile
            ? 'w-full h-full'
            : 'rounded-lg'
        }`}
        style={isMobile ? {} : { width: 'min(1280px, calc(100vw - 32px))', height: `calc(100vh - 48px - ${topOffset}px)`, overflow: 'hidden' }}
        onClick={e => e.stopPropagation()}
      >
        <div className="flex-1 min-h-0 overflow-hidden flex flex-col">
          <TaskDetailContent onClose={() => setSelectedTask(null)} />
        </div>
        {/* Explicit close button so users aren't forced to hunt for the ✕ */}
        <div className="flex-shrink-0 border-t border-border px-4 py-2.5 flex justify-end bg-card">
          <button
            type="button"
            onClick={() => setSelectedTask(null)}
            className="px-5 py-1.5 rounded-md text-sm font-medium bg-primary text-primary-foreground hover:bg-primary/90 transition-colors"
          >
            {t('common.close')}
          </button>
        </div>
      </div>
    </div>
  );
};

export default TaskDetailModal;
