import React from 'react';
import type { Col, ViewMode } from './types';
import { CELL_WIDTHS, HEADER_H, weekDayLabels } from './types';

interface GanttTimelineHeaderProps {
  viewMode: ViewMode;
  columns: Col[];
  cellW: number;
  timelineWidth: number;
  todayColIndex: number;
  today: Date;
  yearGroups: { year: number; startIdx: number; count: number }[] | null;
}

const GanttTimelineHeader = React.memo(({
  viewMode, columns, cellW, timelineWidth, todayColIndex, today, yearGroups,
}: GanttTimelineHeaderProps) => {
  return (
    <div className="sticky top-0 z-[5] border-b border-border bg-card" style={{ width: timelineWidth, height: HEADER_H }}>
      {viewMode === 'day' ? (
        <>
          <div className="flex" style={{ height: HEADER_H / 2 }}>
            {columns.map((col, i) => {
              const day = col.date;
              const isToday = i === todayColIndex;
              const isWeekend = day.getDay() === 0 || day.getDay() === 6;
              return (
                <div key={i} className={`flex-shrink-0 flex items-center justify-center text-[9px] border-r border-border ${isToday ? 'bg-primary/10 text-primary font-bold' : isWeekend ? 'bg-muted/30 text-muted-foreground' : 'text-muted-foreground'}`} style={{ width: cellW }}>
                  {day.getMonth() + 1}/{day.getDate()}
                </div>
              );
            })}
          </div>
          <div className="flex" style={{ height: HEADER_H / 2 }}>
            {columns.map((col, i) => {
              const day = col.date;
              const isToday = i === todayColIndex;
              const isWeekend = day.getDay() === 0 || day.getDay() === 6;
              return (
                <div key={i} className={`flex-shrink-0 flex items-center justify-center text-[9px] border-r border-border ${isToday ? 'bg-primary/10 text-primary font-bold' : isWeekend ? 'bg-muted/30 text-muted-foreground' : 'text-muted-foreground'}`} style={{ width: cellW }}>
                  {weekDayLabels[day.getDay()]}
                </div>
              );
            })}
          </div>
        </>
      ) : (
        <>
          <div className="flex" style={{ height: HEADER_H / 2 }}>
            {yearGroups?.map(g => (
              <div key={g.year} className="flex-shrink-0 flex items-center justify-center text-[13px] font-bold border-r border-border text-muted-foreground" style={{ width: g.count * cellW }}>
                {g.year}
              </div>
            ))}
          </div>
          <div className="flex" style={{ height: HEADER_H / 2 }}>
            {columns.map((col, i) => {
              const isCurrentPeriod = viewMode === 'week'
                ? today >= col.date && today.getTime() < col.date.getTime() + 7 * 86400000
                : viewMode === 'month'
                ? col.date.getFullYear() === today.getFullYear() && col.date.getMonth() === today.getMonth()
                : col.date.getFullYear() === today.getFullYear() && Math.floor(col.date.getMonth() / 3) === Math.floor(today.getMonth() / 3);
              return (
                <div key={i} className={`flex-shrink-0 flex items-center justify-center text-[13px] border-r border-border ${isCurrentPeriod ? 'bg-primary/10 text-primary font-bold' : 'text-muted-foreground'}`} style={{ width: cellW }}>
                  {col.label ?? ''}
                </div>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
});

GanttTimelineHeader.displayName = 'GanttTimelineHeader';

export default GanttTimelineHeader;
