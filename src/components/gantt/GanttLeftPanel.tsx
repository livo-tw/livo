import React from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { Task } from '@/types';
import type { GanttGroup, GanttFlatRow, EnrichedTask, GroupByMode } from './types';
import { ROW_H, HEADER_H } from './types';
import { useIsMobile } from '@/hooks/use-mobile';

interface GanttLeftPanelProps {
  grouped: GanttGroup[];
  collapsedGroups: string[];
  setCollapsedGroups: React.Dispatch<React.SetStateAction<string[]>>;
  collapsedSubtaskParents: Set<string>;
  setCollapsedSubtaskParents: React.Dispatch<React.SetStateAction<Set<string>>>;
  getFlatRows: (groupTasks: EnrichedTask[]) => GanttFlatRow[];
  onSelectTask: (task: Task) => void;
  groupBy: GroupByMode;
  leftRef: React.RefObject<HTMLDivElement>;
}

const GanttLeftPanel = React.memo(({
  grouped, collapsedGroups, setCollapsedGroups,
  collapsedSubtaskParents, setCollapsedSubtaskParents,
  getFlatRows, onSelectTask, groupBy, leftRef,
}: GanttLeftPanelProps) => {
  const { t } = useTranslation();
  const isMobile = useIsMobile();
  const LEFT_W = isMobile ? 180 : 240;

  const groupLabel = groupBy === 'member'
    ? t('gantt.groupBy.member')
    : groupBy === 'line'
    ? t('gantt.groupBy.line')
    : t('gantt.groupBy.project');

  return (
    <div className="flex-shrink-0 border-r border-border flex flex-col" style={{ width: LEFT_W }}>
      <div className="border-b border-border flex-shrink-0" style={{ height: HEADER_H }}>
        <div className="h-full flex items-end px-2 pb-1 text-[13px] font-semibold text-muted-foreground uppercase">
          {groupLabel} {t('gantt.tasksSeparator')}
        </div>
      </div>
      <div ref={leftRef} className="flex-1 overflow-hidden overflow-x-auto">
        {grouped.length === 0 && (
          <div className="p-4 text-[13px] text-muted-foreground text-center">{t('gantt.noMatches')}</div>
        )}
        <div style={{ minWidth: isMobile ? '280px' : '300px' }}>
          {grouped.map(group => {
            const isCollapsed = collapsedGroups.includes(group.id);
            return (
              <div key={group.id}>
                <button
                  onClick={() => setCollapsedGroups(prev => prev.includes(group.id) ? prev.filter(id => id !== group.id) : [...prev, group.id])}
                  className="w-full flex items-center gap-1.5 px-2 hover:bg-accent/50 transition-colors bg-muted/50"
                  style={{ height: ROW_H }}
                >
                  {isCollapsed ? <ChevronRight size={12} className="flex-shrink-0 text-muted-foreground" /> : <ChevronDown size={12} className="flex-shrink-0 text-muted-foreground" />}
                  {group.avatar ? (
                    <div className="w-[18px] h-[18px] rounded-full flex items-center justify-center text-[7px] font-bold flex-shrink-0" style={{ backgroundColor: group.color, color: '#fff' }}>
                      {group.avatar}
                    </div>
                  ) : group.icon ? (
                    <span className="text-[13px] flex-shrink-0">{group.icon}</span>
                  ) : (
                    <span className="w-[14px] h-[8px] rounded-sm inline-block flex-shrink-0" style={{ backgroundColor: group.color }} />
                  )}
                  <span className="text-[13px] font-semibold text-foreground truncate">{group.label}</span>
                  <span className="text-[13px] text-muted-foreground flex-shrink-0">({group.tasks.length})</span>
                </button>
                {!isCollapsed && getFlatRows(group.tasks).map(({ task, isSubtask, hasSubtasks }) => (
                  <div
                    key={task.id}
                    onClick={() => onSelectTask(task)}
                    className={`flex items-center text-[13px] text-foreground truncate cursor-pointer hover:bg-accent transition-colors whitespace-nowrap ${isSubtask ? 'pl-10 pr-2' : 'px-2 pl-6'}`}
                    style={{ height: ROW_H }}
                    title={task.title}
                  >
                    {hasSubtasks && (
                      <button
                        type="button"
                        onClick={e => {
                          e.stopPropagation();
                          setCollapsedSubtaskParents(prev => {
                            const next = new Set(prev);
                            if (next.has(task.id)) next.delete(task.id); else next.add(task.id);
                            return next;
                          });
                        }}
                        className="mr-1 flex-shrink-0 text-muted-foreground hover:text-foreground"
                      >
                        {collapsedSubtaskParents.has(task.id) ? <ChevronRight size={12} /> : <ChevronDown size={12} />}
                      </button>
                    )}
                    {isSubtask && !hasSubtasks && <span className="mr-1 flex-shrink-0 w-3" />}
                    <span className="truncate">{task.title}</span>
                  </div>
                ))}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
});

GanttLeftPanel.displayName = 'GanttLeftPanel';

export default GanttLeftPanel;
