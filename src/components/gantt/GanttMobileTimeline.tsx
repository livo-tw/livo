import { useState } from 'react';
import { format } from 'date-fns';
import { ChevronDown, ChevronRight } from 'lucide-react';
import type { GanttGroup, EnrichedTask } from './types';
import type { Status } from '@/types';
import i18n from 'i18next';

interface Props {
  grouped: GanttGroup[];
  statuses: Status[];
  onSelectTask: (task: EnrichedTask) => void;
}

type StatusCategory = 'done' | 'overdue' | 'active' | 'pending';

function getStatusCategory(task: EnrichedTask, statuses: Status[]): StatusCategory {
  const status = statuses.find(s => s.id === task.statusId);
  if (task.completedAt || status?.isDone) return 'done';
  if (task.isOverdue) return 'overdue';
  if (task.startedAt) return 'active';
  return 'pending';
}

function getTimeProgress(task: EnrichedTask, cat: StatusCategory): number {
  if (cat === 'done') return 100;
  if (cat === 'pending') return 0;
  const today = new Date();
  const start = new Date(task.startedAt || task.createdAt);
  if (!task.dueDate) return cat === 'overdue' ? 100 : 30;
  const end = new Date(task.dueDate);
  const total = end.getTime() - start.getTime();
  if (total <= 0) return 100;
  const elapsed = today.getTime() - start.getTime();
  return Math.min(100, Math.max(5, Math.round((elapsed / total) * 100)));
}

const CATEGORY_STYLE: Record<StatusCategory, { dot: string; bar: string; labelKey: string; labelClass: string }> = {
  done:    { dot: 'bg-green-500', bar: 'bg-green-500', labelKey: 'gantt.status.done', labelClass: 'text-green-700 dark:text-green-400' },
  overdue: { dot: 'bg-red-500',   bar: 'bg-red-500',   labelKey: 'gantt.status.overdue', labelClass: 'text-red-600 dark:text-red-400' },
  active:  { dot: 'bg-blue-500',  bar: 'bg-blue-500',  labelKey: 'gantt.status.inProgress', labelClass: 'text-blue-600 dark:text-blue-400' },
  pending: { dot: 'bg-gray-400',  bar: 'bg-gray-300',  labelKey: 'gantt.status.pending', labelClass: 'text-gray-500 dark:text-gray-400' },
};

const fmtDate = (d?: string) => (d ? format(new Date(d), 'MM/dd') : '—');

const TaskRow = ({ task, statuses, onSelectTask }: { task: EnrichedTask; statuses: Status[]; onSelectTask: (t: EnrichedTask) => void }) => {
  const cat = getStatusCategory(task, statuses);
  const style = CATEGORY_STYLE[cat];
  const progress = getTimeProgress(task, cat);
  const startDate = task.startedAt || task.createdAt;

  return (
    <button
      className="w-full text-left px-3 py-2.5 hover:bg-muted/30 active:bg-muted/50 transition-colors"
      onClick={() => onSelectTask(task)}
    >
      <div className="flex items-center gap-2 mb-1">
        <span className={`w-2 h-2 rounded-full flex-shrink-0 ${style.dot}`} />
        <span className="min-w-0 break-words text-[13px] font-medium flex-1 leading-snug [overflow-wrap:anywhere]">{task.title}</span>
        <span className={`text-[11px] font-semibold flex-shrink-0 ${style.labelClass}`}>{i18n.t(style.labelKey)}</span>
      </div>
      <div className="flex flex-wrap items-center gap-2 pl-4 mb-1.5">
        <span className="text-[11px] text-muted-foreground">
          {fmtDate(startDate)} → {fmtDate(task.dueDate)}
        </span>
        {task.taskKey && (
          <span className="break-all text-[10px] text-muted-foreground/50">{task.taskKey}</span>
        )}
      </div>
      <div className="pl-4 h-1 bg-muted rounded-full overflow-hidden">
        <div
          className={`h-full rounded-full ${style.bar}`}
          style={{ width: `${progress}%` }}
        />
      </div>
    </button>
  );
};

const GanttMobileTimeline = ({ grouped, statuses, onSelectTask }: Props) => {
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set());

  const toggleGroup = (id: string) => {
    setCollapsedGroups(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  if (grouped.length === 0) {
    return (
      <div className="flex-1 flex items-center justify-center text-sm text-muted-foreground">
        {i18n.t('gantt.noTasks')}
      </div>
    );
  }

  return (
    <div className="min-h-0 min-w-0 flex-1 overflow-y-auto overscroll-contain mx-2 mb-2 space-y-2 pb-[max(8px,env(safe-area-inset-bottom))]">
      {grouped.map(group => {
        const isCollapsed = collapsedGroups.has(group.id);
        return (
          <div key={group.id} className="bg-card rounded-lg border border-border overflow-hidden">
            <button
              className="w-full flex items-center gap-2 px-3 py-2.5 text-sm font-semibold text-left hover:bg-muted/40 transition-colors"
              aria-expanded={!isCollapsed}
              onClick={() => toggleGroup(group.id)}
            >
              {isCollapsed
                ? <ChevronRight className="w-4 h-4 flex-shrink-0 text-muted-foreground" />
                : <ChevronDown className="w-4 h-4 flex-shrink-0 text-muted-foreground" />
              }
              <span
                className="w-2.5 h-2.5 rounded-full flex-shrink-0"
                style={{ backgroundColor: group.color }}
              />
              <span className="flex-1 truncate">{group.label}</span>
              <span className="text-xs font-normal text-muted-foreground">{group.tasks.length}</span>
            </button>

            {!isCollapsed && (
              <div className="border-t border-border divide-y divide-border">
                {group.tasks.map(task => (
                  <TaskRow
                    key={task.id}
                    task={task}
                    statuses={statuses}
                    onSelectTask={onSelectTask}
                  />
                ))}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
};

export default GanttMobileTimeline;
