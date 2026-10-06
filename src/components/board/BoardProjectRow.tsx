import { useProjectColor } from '@/hooks/useProjectColor';
import React, { useMemo, useCallback, useState } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import type { Task, Status, Project, ProductLine } from '@/types';
import type { CardFieldVisibility } from '@/lib/fieldRegistry';
import TaskCard from '@/components/TaskCard';

interface BoardProjectRowProps {
  project: Project;
  line: ProductLine | undefined;
  projectTasks: Task[];
  statuses: Status[];
  isCollapsed: boolean;
  onToggle: () => void;
  onDrop: (taskId: string, newStatusId: string) => void;
  cardFields: CardFieldVisibility;
  subtaskMode: 'independent' | 'nested';
  customCardFields: Record<string, boolean>;
}

const BoardProjectRow = React.memo(({
  project, line, projectTasks, statuses, isCollapsed, onToggle, onDrop,
  cardFields, subtaskMode, customCardFields,
}: BoardProjectRowProps) => {
  const getProjectColor = useProjectColor();
  const [dragOverStatusId, setDragOverStatusId] = useState<string | null>(null);

  return (
    <div className="bg-card rounded-xl border border-border/80 shadow-sm overflow-hidden">
      <div
        className="flex items-center gap-2.5 px-3 md:px-4 py-2.5 md:py-3 cursor-pointer hover:bg-accent/30 transition-colors"
        onClick={onToggle}
        style={{ borderLeft: `4px solid ${getProjectColor(project)}` }}
      >
        <span className="text-muted-foreground">
          {isCollapsed ? <ChevronRight size={16} /> : <ChevronDown size={16} />}
        </span>
        {line && (
          <span className="text-sm md:text-[15px] px-2 py-0.5 rounded-md font-bold text-white" style={{ backgroundColor: line.color }}>
            {line.icon} {line.name}
          </span>
        )}
        <span className="text-sm md:text-[15px] font-bold text-foreground truncate">{project.name}</span>
        <span className="text-[13px] text-muted-foreground font-medium ml-auto flex-shrink-0">({projectTasks.length})</span>
      </div>

      {!isCollapsed && (
        <div className="px-2 md:px-3 pb-3 pt-1.5 overflow-x-auto overscroll-x-contain snap-x snap-proximity md:snap-none border-t border-border/50" style={{ touchAction: 'pan-x pan-y', WebkitOverflowScrolling: 'touch' }}>
          <div
            className="flex gap-2 md:gap-3 min-w-max md:min-w-0"
          >
            {statuses.map(status => {
              const columnTasks = projectTasks
                .filter(t => t.statusId === status.id)
                .sort((a, b) => a.sortOrder - b.sortOrder);

              return (
                <div
                  key={status.id}
                  className={`w-[min(82vw,300px)] min-w-0 shrink-0 md:w-auto md:flex-1 rounded-lg p-1.5 md:p-2 snap-start transition-colors ${
                    dragOverStatusId === status.id
                      ? 'bg-primary/8 ring-2 ring-primary/30'
                      : 'bg-muted/40'
                  }`}
                  onDragOver={e => { e.preventDefault(); setDragOverStatusId(status.id); }}
                  onDragLeave={e => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setDragOverStatusId(null); }}
                  onDrop={e => {
                    e.preventDefault();
                    setDragOverStatusId(null);
                    const taskId = e.dataTransfer.getData('taskId');
                    if (taskId) onDrop(taskId, status.id);
                  }}
                >
                  <div className="flex items-center gap-1.5 mb-2 md:mb-2.5 px-1">
                    <span className="w-3 h-3 rounded-full flex-shrink-0 ring-2 ring-white" style={{ backgroundColor: status.color }} />
                    <span className="text-sm font-bold truncate" style={{ color: status.color }}>{status.name}</span>
                    <span className="text-xs text-muted-foreground/70 font-medium bg-muted rounded-full px-1.5 py-0.5">{columnTasks.length}</span>
                  </div>
                  <div className="space-y-1.5 md:space-y-2 min-h-[100px] md:min-h-[120px]">
                    {columnTasks
                      .filter(task => subtaskMode !== 'nested' || !task.parentTaskId)
                      .map(task => (
                      <TaskCard key={task.id} task={task} fields={cardFields} subtaskMode={subtaskMode} customCardFields={customCardFields} />
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
});

BoardProjectRow.displayName = 'BoardProjectRow';

export default BoardProjectRow;
