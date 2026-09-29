import React from 'react';
import { Tooltip, TooltipTrigger, TooltipContent } from '@/components/ui/tooltip';
import { format } from 'date-fns';
import { useTranslation } from 'react-i18next';
import type { User } from '@/types';
import type { EnrichedTask, DragInfo, ViewMode } from './types';
import { ROW_H } from './types';
import { useIsMobile } from '@/hooks/use-mobile';

interface GanttTaskBarProps {
  task: EnrichedTask;
  isSubtask: boolean;
  barPos: { left: number; width: number };
  isDragging: boolean;
  dragPreviewDates: { startFull: string; endFull: string } | null;
  users: User[];
  onPointerDown: (e: React.MouseEvent, taskId: string, type: 'move' | 'start' | 'end', startPx: number, endPx: number) => void;
  onTouchStart: (e: React.TouchEvent, taskId: string, type: 'move' | 'start' | 'end', startPx: number, endPx: number) => void;
  onClickTask: (task: EnrichedTask) => void;
  dragActivatedRef: React.MutableRefObject<boolean>;
}

const GanttTaskBar = React.memo(({
  task, isSubtask, barPos, isDragging, dragPreviewDates,
  users, onPointerDown, onTouchStart, onClickTask, dragActivatedRef,
}: GanttTaskBarProps) => {
  const { t } = useTranslation();
  const isMobile = useIsMobile();
  const barColor = isSubtask
    ? (task.isOverdue ? '#FF7452' : (task.project?.color ? task.project.color + 'BB' : '#4C9AFF'))
    : (task.isOverdue ? '#FF5630' : (task.project?.color || '#0065FF'));

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <div
          className="absolute transition-none select-none group"
          style={{
            left: barPos.left,
            width: barPos.width,
            top: 4,
            height: ROW_H - 8,
            zIndex: isDragging ? 10 : 2,
            opacity: isDragging ? 0.95 : 0.85,
          }}
        >
          {/* Main bar (move) */}
          <div
            onMouseDown={e => onPointerDown(e, task.id, 'move', task.startPx, task.endPx)}
            onTouchStart={e => onTouchStart(e, task.id, 'move', task.startPx, task.endPx)}
            onClick={() => { if (!dragActivatedRef.current) onClickTask(task); }}
            className="absolute inset-0 rounded cursor-pointer"
            style={{ backgroundColor: barColor, borderRadius: 3, cursor: isDragging ? 'grabbing' : 'pointer' }}
          >
            <span className="text-[10px] font-bold text-white px-1.5 truncate block leading-[24px]">
              {task.taskKey}
            </span>
          </div>
          {/* Left drag handle (start date) */}
          <div
            onMouseDown={e => onPointerDown(e, task.id, 'start', task.startPx, task.endPx)}
            onTouchStart={e => onTouchStart(e, task.id, 'start', task.startPx, task.endPx)}
            className={`absolute left-0 top-0 bottom-0 ${isMobile ? 'w-[20px]' : 'w-[10px]'} cursor-col-resize z-[3] rounded-l flex items-center justify-center`}
            style={{ borderTopLeftRadius: 3, borderBottomLeftRadius: 3 }}
          >
            <div className={`w-[3px] h-[12px] rounded-full bg-white/50 transition-opacity ${isMobile ? 'opacity-80' : 'opacity-0 group-hover:opacity-100'}`} />
          </div>
          {/* Right drag handle (end date) */}
          <div
            onMouseDown={e => onPointerDown(e, task.id, 'end', task.startPx, task.endPx)}
            onTouchStart={e => onTouchStart(e, task.id, 'end', task.startPx, task.endPx)}
            className={`absolute right-0 top-0 bottom-0 ${isMobile ? 'w-[20px]' : 'w-[10px]'} cursor-col-resize z-[3] rounded-r flex items-center justify-center`}
            style={{ borderTopRightRadius: 3, borderBottomRightRadius: 3 }}
          >
            <div className={`w-[3px] h-[12px] rounded-full bg-white/50 transition-opacity ${isMobile ? 'opacity-80' : 'opacity-0 group-hover:opacity-100'}`} />
          </div>
          {/* Drag preview date label */}
          {isDragging && dragPreviewDates && (
            <div
              className="absolute left-1/2 -translate-x-1/2 -top-[26px] bg-foreground text-background text-[11px] font-semibold px-2 py-0.5 rounded whitespace-nowrap z-[20] shadow-lg"
            >
              {dragPreviewDates.startFull} ～ {dragPreviewDates.endFull}
            </div>
          )}
        </div>
      </TooltipTrigger>
      {!isDragging && (
        <TooltipContent side="top" className="text-[13px] space-y-0.5 max-w-[240px]">
          <p className="font-semibold">{task.taskKey}: {task.title}</p>
          <p className="text-muted-foreground">{t('gantt.tooltip.assignee')}{task.assigneeId ? users.find(u => u.id === task.assigneeId)?.name ?? '—' : t('gantt.tooltip.unassigned')}</p>
          <p className="text-muted-foreground">
            {task.startedAt ? format(new Date(task.startedAt), 'yyyy/MM/dd') : '—'} ～ {task.dueDate ? format(new Date(task.dueDate), 'yyyy/MM/dd') : '—'}
          </p>
        </TooltipContent>
      )}
    </Tooltip>
  );
});

GanttTaskBar.displayName = 'GanttTaskBar';

export default GanttTaskBar;
