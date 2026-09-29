import { useMemo, useCallback } from 'react';
import { type ViewMode, type Col, type ColDay, type ColPeriod, CELL_WIDTHS, quarterLabels, type EnrichedTask } from './types';

export function useGanttTimeline(viewMode: ViewMode, tasks?: EnrichedTask[]) {
  const today = useMemo(() => {
    const d = new Date(); d.setHours(0, 0, 0, 0); return d;
  }, []);

  // v25.1: Default 6-year range (today ± 3y), but EXTENDS if any task falls outside.
  // Tasks beyond ±3y must still render (no hard cap).
  // Final range = union(default 6y, task envelope) + month boundary padding.
  const { rangeStart, rangeEnd } = useMemo(() => {
    // Default: today − 3y (Jan 1) ~ today + 3y (Dec 31)
    const defaultMin = new Date(today);
    defaultMin.setFullYear(today.getFullYear() - 3);
    defaultMin.setMonth(0, 1);
    defaultMin.setHours(0, 0, 0, 0);

    const defaultMax = new Date(today);
    defaultMax.setFullYear(today.getFullYear() + 3);
    defaultMax.setMonth(11, 31);
    defaultMax.setHours(0, 0, 0, 0);

    // Task envelope: collect every task date (startedAt + createdAt + dueDate)
    let taskMinTs: number | null = null;
    let taskMaxTs: number | null = null;
    if (tasks && tasks.length > 0) {
      for (const t of tasks) {
        const candidates = [t.startedAt, t.createdAt, t.dueDate];
        for (const raw of candidates) {
          if (!raw) continue;
          const ts = new Date(raw).getTime();
          if (Number.isNaN(ts)) continue;
          if (taskMinTs === null || ts < taskMinTs) taskMinTs = ts;
          if (taskMaxTs === null || ts > taskMaxTs) taskMaxTs = ts;
        }
      }
    }

    // Union: take whichever extends further
    const minDate = (taskMinTs !== null && taskMinTs < defaultMin.getTime())
      ? new Date(taskMinTs)
      : new Date(defaultMin);
    const maxDate = (taskMaxTs !== null && taskMaxTs > defaultMax.getTime())
      ? new Date(taskMaxTs)
      : new Date(defaultMax);

    // Pad to month boundary (only when task envelope extended beyond default;
    // default already aligns to Jan 1 / Dec 31).
    if (taskMinTs !== null && taskMinTs < defaultMin.getTime()) {
      minDate.setDate(1);
      minDate.setMonth(minDate.getMonth() - 1);
      minDate.setHours(0, 0, 0, 0);
    }
    if (taskMaxTs !== null && taskMaxTs > defaultMax.getTime()) {
      // last day of next month
      maxDate.setDate(1);
      maxDate.setMonth(maxDate.getMonth() + 2, 0);
      maxDate.setHours(0, 0, 0, 0);
    }

    return { rangeStart: minDate, rangeEnd: maxDate };
  }, [today, tasks]);

  const columns: Col[] = useMemo(() => {
    if (viewMode === 'day') {
      const arr: ColDay[] = [];
      const d = new Date(rangeStart);
      while (d <= rangeEnd) { arr.push({ date: new Date(d), key: d.toISOString() }); d.setDate(d.getDate() + 1); }
      return arr;
    }
    if (viewMode === 'week') {
      const arr: ColPeriod[] = [];
      const d = new Date(rangeStart);
      const dow = d.getDay();
      d.setDate(d.getDate() - (dow === 0 ? 6 : dow - 1));
      while (d <= rangeEnd) {
        const label = `${d.getMonth() + 1}/${d.getDate()}`;
        arr.push({ date: new Date(d), key: d.toISOString(), label, year: d.getFullYear() });
        d.setDate(d.getDate() + 7);
      }
      return arr;
    }
    if (viewMode === 'month') {
      const arr: ColPeriod[] = [];
      const d = new Date(rangeStart.getFullYear(), rangeStart.getMonth(), 1);
      while (d <= rangeEnd) {
        arr.push({ date: new Date(d), key: `${d.getFullYear()}-${d.getMonth()}`, label: `${d.getMonth() + 1}月`, year: d.getFullYear() });
        d.setMonth(d.getMonth() + 1);
      }
      return arr;
    }
    const arr: ColPeriod[] = [];
    const startQ = Math.floor(rangeStart.getMonth() / 3);
    const d = new Date(rangeStart.getFullYear(), startQ * 3, 1);
    while (d <= rangeEnd) {
      const q = Math.floor(d.getMonth() / 3);
      arr.push({ date: new Date(d), key: `${d.getFullYear()}-Q${q}`, label: quarterLabels[q], year: d.getFullYear() });
      d.setMonth(d.getMonth() + 3);
    }
    return arr;
  }, [viewMode, rangeStart, rangeEnd]);

  const cellW = CELL_WIDTHS[viewMode];
  const timelineWidth = columns.length * cellW;

  const todayColIndex = useMemo(() => {
    if (viewMode !== 'day') return -1;
    return Math.floor((today.getTime() - rangeStart.getTime()) / (1000 * 60 * 60 * 24));
  }, [viewMode, today, rangeStart]);

  const dateToPx = useMemo(() => {
    if (viewMode === 'day') {
      return (d: Date) => {
        const diff = (d.getTime() - rangeStart.getTime()) / (1000 * 60 * 60 * 24);
        return diff * cellW;
      };
    }
    if (viewMode === 'week') {
      return (d: Date) => {
        for (let i = 0; i < columns.length; i++) {
          const colStart = columns[i].date;
          const colEnd = i + 1 < columns.length ? columns[i + 1].date : new Date(colStart.getTime() + 7 * 86400000);
          if (d < colEnd) {
            const totalMs = colEnd.getTime() - colStart.getTime();
            const offsetMs = d.getTime() - colStart.getTime();
            return (i + Math.max(0, offsetMs / totalMs)) * cellW;
          }
        }
        return columns.length * cellW;
      };
    }
    if (viewMode === 'month') {
      return (d: Date) => {
        const cols = columns as { date: Date }[];
        for (let i = 0; i < cols.length; i++) {
          const colStart = cols[i].date;
          const colEnd = i + 1 < cols.length ? cols[i + 1].date : new Date(colStart.getFullYear(), colStart.getMonth() + 1, 1);
          if (d < colEnd) {
            const totalMs = colEnd.getTime() - colStart.getTime();
            const offsetMs = d.getTime() - colStart.getTime();
            return (i + Math.max(0, offsetMs / totalMs)) * cellW;
          }
        }
        return columns.length * cellW;
      };
    }
    return (d: Date) => {
      const cols = columns as { date: Date }[];
      for (let i = 0; i < cols.length; i++) {
        const colStart = cols[i].date;
        const colEnd = i + 1 < cols.length ? cols[i + 1].date : new Date(colStart.getFullYear(), colStart.getMonth() + 3, 1);
        if (d < colEnd) {
          const totalMs = colEnd.getTime() - colStart.getTime();
          const offsetMs = d.getTime() - colStart.getTime();
          return (i + Math.max(0, offsetMs / totalMs)) * cellW;
        }
      }
      return columns.length * cellW;
    };
  }, [viewMode, columns, cellW, rangeStart]);

  const pxToDate = useCallback((px: number): Date => {
    if (viewMode === 'day') {
      const dayIdx = Math.round(px / cellW);
      const d = new Date(rangeStart);
      d.setDate(d.getDate() + dayIdx);
      d.setHours(0, 0, 0, 0);
      return d;
    }
    if (viewMode === 'week') {
      const colIdx = Math.floor(px / cellW);
      const frac = (px / cellW) - colIdx;
      const col = columns[Math.min(colIdx, columns.length - 1)];
      const nextCol = columns[Math.min(colIdx + 1, columns.length - 1)];
      const colEnd = colIdx + 1 < columns.length ? nextCol.date : new Date(col.date.getTime() + 7 * 86400000);
      const ms = col.date.getTime() + frac * (colEnd.getTime() - col.date.getTime());
      const d = new Date(ms);
      d.setHours(0, 0, 0, 0);
      return d;
    }
    if (viewMode === 'month') {
      const colIdx = Math.floor(px / cellW);
      const frac = (px / cellW) - colIdx;
      const cols = columns as { date: Date }[];
      const col = cols[Math.min(colIdx, cols.length - 1)];
      const colEnd = colIdx + 1 < cols.length ? cols[colIdx + 1].date : new Date(col.date.getFullYear(), col.date.getMonth() + 1, 1);
      const ms = col.date.getTime() + frac * (colEnd.getTime() - col.date.getTime());
      const d = new Date(ms);
      d.setHours(0, 0, 0, 0);
      return d;
    }
    // quarter
    const colIdx = Math.floor(px / cellW);
    const frac = (px / cellW) - colIdx;
    const cols = columns as { date: Date }[];
    const col = cols[Math.min(colIdx, cols.length - 1)];
    const colEnd = colIdx + 1 < cols.length ? cols[colIdx + 1].date : new Date(col.date.getFullYear(), col.date.getMonth() + 3, 1);
    const ms = col.date.getTime() + frac * (colEnd.getTime() - col.date.getTime());
    const d = new Date(ms);
    d.setHours(0, 0, 0, 0);
    return d;
  }, [viewMode, cellW, rangeStart, columns]);

  const snapToPx = useCallback((px: number): number => {
    if (viewMode === 'day') {
      return Math.round(px / cellW) * cellW;
    }
    const d = pxToDate(px);
    d.setHours(0, 0, 0, 0);
    return dateToPx(d);
  }, [viewMode, cellW, pxToDate, dateToPx]);

  const todayPx = useMemo(() => dateToPx(today), [dateToPx, today]);

  const yearGroups = useMemo(() => {
    if (viewMode === 'day') return null;
    const groups: { year: number; startIdx: number; count: number }[] = [];
    let cur = { year: columns[0]?.year ?? 0, startIdx: 0, count: 0 };
    columns.forEach((c, i) => {
      const y = c.year ?? 0;
      if (y === cur.year) { cur.count++; }
      else { groups.push({ ...cur }); cur = { year: y, startIdx: i, count: 1 }; }
    });
    if (cur.count) groups.push(cur);
    return groups;
  }, [viewMode, columns]);

  return {
    today, rangeStart, rangeEnd,
    columns, cellW, timelineWidth,
    todayColIndex, dateToPx, pxToDate, snapToPx, todayPx,
    yearGroups,
  };
}

// Hook for timeline navigation (scrolling to specific dates)
export function useGanttTimelineNavigation(
  scrollRef: React.RefObject<HTMLDivElement>,
  todayPx: number,
  timelineWidth: number,
  dateToPx: (d: Date) => number,
) {
  const scrollToDate = useCallback((date: Date) => {
    if (!scrollRef.current) return;
    const targetPx = dateToPx(date);
    const containerWidth = scrollRef.current.clientWidth;
    const scrollLeft = Math.max(0, targetPx - containerWidth / 3);
    scrollRef.current.scrollLeft = scrollLeft;
  }, [dateToPx, scrollRef]);

  const scrollToToday = useCallback(() => {
    if (!scrollRef.current) return;
    const containerWidth = scrollRef.current.clientWidth;
    const scrollLeft = Math.max(0, todayPx - containerWidth / 3);
    scrollRef.current.scrollLeft = scrollLeft;
  }, [todayPx, scrollRef]);

  const scrollLeft = useCallback(() => {
    if (!scrollRef.current) return;
    scrollRef.current.scrollLeft = Math.max(0, scrollRef.current.scrollLeft - 300);
  }, [scrollRef]);

  const scrollRight = useCallback(() => {
    if (!scrollRef.current) return;
    const maxScroll = timelineWidth - scrollRef.current.clientWidth;
    scrollRef.current.scrollLeft = Math.min(maxScroll, scrollRef.current.scrollLeft + 300);
  }, [scrollRef, timelineWidth]);

  return { scrollToDate, scrollToToday, scrollLeft, scrollRight };
}
