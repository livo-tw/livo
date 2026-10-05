import { SearchableSelect } from '@/components/ui/searchable-select';
import { useProjectColor } from '@/hooks/useProjectColor';
import React from 'react';
import { Lightbulb, ChevronLeft, ChevronRight, Calendar } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { Project, ProductLine } from '@/types';
import type { Sprint } from '@/context/SprintContext';
import DepartmentFilter from '@/components/DepartmentFilter';
import type { Department } from '@/lib/department';
import type { GroupByMode, ViewMode } from './types';
import { useIsMobile } from '@/hooks/use-mobile';

interface GanttToolbarProps {
  groupBy: GroupByMode;
  setGroupBy: (v: GroupByMode) => void;
  viewMode: ViewMode;
  setViewMode: (v: ViewMode) => void;
  filterDept: Department[];
  setFilterDept: (v: Department[]) => void;
  selectedSprintId: string;
  setSelectedSprintId: (v: string) => void;
  currentSprint: Sprint | null;
  sprints: Sprint[];
  legendProjects: Project[];
  onScrollLeft?: () => void;
  onScrollRight?: () => void;
  onScrollToToday?: () => void;
}

const GanttToolbar = React.memo(({
  groupBy, setGroupBy, viewMode, setViewMode,
  filterDept, setFilterDept,
  selectedSprintId, setSelectedSprintId,
  currentSprint, sprints, legendProjects,
  onScrollLeft, onScrollRight, onScrollToToday,
}: GanttToolbarProps) => {
  const { t } = useTranslation();
  const getProjectColor = useProjectColor();
  const isMobile = useIsMobile();

  const groupByOptions: [GroupByMode, string][] = [
    ['member', t('gantt.groupBy.member')],
    ['line', t('gantt.groupBy.line')],
    ['project', t('gantt.groupBy.project')],
  ];

  const viewModeOptions: [ViewMode, string][] = [
    ['day', t('gantt.viewMode.day')],
    ['week', t('gantt.viewMode.week')],
    ['month', t('gantt.viewMode.month')],
    ['quarter', t('gantt.viewMode.quarter')],
  ];

  return (
    <div className="px-3 md:px-5 pt-3 md:pt-4 pb-2">
      <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-2 mb-2 md:mb-3">
        <div className="flex min-w-0 flex-1 items-center gap-1 md:gap-2 flex-wrap">
          {!isMobile && (
            <div className="flex items-center gap-0.5">
              <button
                onClick={onScrollLeft}
                className="p-1.5 hover:bg-muted rounded transition-colors text-muted-foreground hover:text-foreground"
                title={t('gantt.scrollLeft')}
              >
                <ChevronLeft size={18} />
              </button>
              <button
                onClick={onScrollRight}
                className="p-1.5 hover:bg-muted rounded transition-colors text-muted-foreground hover:text-foreground"
                title={t('gantt.scrollRight')}
              >
                <ChevronRight size={18} />
              </button>
              <button
                onClick={onScrollToToday}
                className="flex items-center gap-1.5 px-2.5 py-1.5 text-[13px] font-medium rounded-md border border-border bg-card text-foreground hover:bg-muted transition-colors"
                title={t('gantt.todayButton')}
              >
                <Calendar size={14} />
                <span>{t('gantt.today')}</span>
              </button>
            </div>
          )}
          <h1 className="text-base md:text-lg font-bold text-foreground">{t('gantt.title')}</h1>
          <div className="flex items-center gap-0.5 bg-muted rounded-md p-0.5">
            {groupByOptions.map(([mode, label]) => (
              <button
                key={mode}
                onClick={() => setGroupBy(mode)}
                className={`px-2.5 md:px-3 py-1.5 text-[13px] font-medium rounded transition-colors ${
                  groupBy === mode ? 'bg-card text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'
                }`}
              >
                {label}
              </button>
            ))}
          </div>
          <DepartmentFilter value={filterDept} onChange={setFilterDept} />
          <SearchableSelect
            value={selectedSprintId}
            onChange={e => setSelectedSprintId(e.target.value)}
            className="px-2.5 py-1.5 text-[13px] font-medium rounded-md border border-border bg-card text-foreground cursor-pointer"
          >
            <option value="current">{currentSprint ? `${t('gantt.sprint.current')} (${currentSprint.name})` : t('gantt.sprint.openTasks')}</option>
            <option value="all">{t('gantt.sprint.all')}</option>
            {sprints
              .filter(s => !s.isActive)
              .sort((a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime())
              .map(s => (
                <option key={s.id} value={s.id}>{s.name}{s.completedAt ? ' ✓' : ''}</option>
              ))
            }
          </SearchableSelect>
        </div>
        <div className="flex shrink-0 self-start items-center gap-0.5 bg-muted rounded-md p-0.5 md:self-auto">
          {viewModeOptions.map(([mode, label]) => (
            <button
              key={mode}
              onClick={() => setViewMode(mode)}
              className={`whitespace-nowrap px-2.5 md:px-3 py-1.5 text-[13px] font-medium rounded transition-colors ${
                viewMode === mode ? 'bg-card text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'
              }`}
            >
              {label}
            </button>
          ))}
        </div>
      </div>
      {!isMobile && (
        <div className="flex items-center gap-3 flex-wrap text-[13px]">
          {legendProjects.map(p => (
            <span key={p.id} className="flex items-center gap-1">
              <span className="w-3 h-2.5 rounded-sm inline-block" style={{ backgroundColor: getProjectColor(p) }} />
              <span className="text-muted-foreground">{p.name}</span>
            </span>
          ))}
          <span className="flex items-center gap-1">
            <span className="w-3 h-2.5 rounded-sm inline-block bg-destructive" />
            <span className="text-muted-foreground">{t('gantt.legend.overdue')}</span>
          </span>
          <span className="text-muted-foreground/60 ml-2 flex items-center gap-1"><Lightbulb size={14} /> {t('gantt.dragHint')}</span>
        </div>
      )}
    </div>
  );
});

GanttToolbar.displayName = 'GanttToolbar';

export default GanttToolbar;
