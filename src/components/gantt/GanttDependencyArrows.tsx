import React, { useMemo } from 'react';
import type { TaskDependency } from '@/types';
import type { GanttGroup, GanttFlatRow, EnrichedTask } from './types';
import { ROW_H } from './types';

interface GanttDependencyArrowsProps {
  grouped: GanttGroup[];
  collapsedGroups: string[];
  taskDependencies: TaskDependency[];
  timelineWidth: number;
  getFlatRows: (groupTasks: EnrichedTask[]) => GanttFlatRow[];
  getBarPos: (task: EnrichedTask, groupTasks: EnrichedTask[], hasSubtasks: boolean) => { left: number; width: number };
}

interface TaskRowInfo {
  rowY: number;
  startPx: number;
  endPx: number;
  barWidth: number;
  task: EnrichedTask;
}

/**
 * Determines if a dependency is satisfied.
 * A dependency is satisfied if the predecessor task has an end date <= dependent task's start date
 * or if the predecessor is completed.
 */
function isDependencySatisfied(fromTask: EnrichedTask, toTask: EnrichedTask): boolean {
  // If predecessor is completed, dependency is satisfied
  if (fromTask.completedAt) return true;

  // Check if predecessor ends before or on dependent's start date
  const fromEnd = fromTask.dueDate ? new Date(fromTask.dueDate) : null;
  const toStart = new Date(toTask.startedAt || toTask.createdAt);

  if (fromEnd && fromEnd <= toStart) return true;
  return false;
}

const GanttDependencyArrows = React.memo(({
  grouped, collapsedGroups, taskDependencies, timelineWidth, getFlatRows, getBarPos,
}: GanttDependencyArrowsProps) => {
  // Build task map for quick lookup by ID
  const taskMap = useMemo(() => {
    const map = new Map<string, EnrichedTask>();
    grouped.forEach(group => {
      group.tasks.forEach(task => {
        map.set(task.id, task);
      });
    });
    return map;
  }, [grouped]);

  const { taskRowMap, totalH } = useMemo(() => {
    const rowMap = new Map<string, TaskRowInfo>();
    let rowIdx = 0;

    grouped.forEach(group => {
      rowIdx++; // group header row
      const isCollapsed = collapsedGroups.includes(group.id);
      if (!isCollapsed) {
        getFlatRows(group.tasks).forEach(({ task, hasSubtasks }) => {
          const barPos = getBarPos(task, group.tasks, hasSubtasks);
          rowMap.set(task.id, {
            rowY: rowIdx * ROW_H + ROW_H / 2,
            startPx: barPos.left,
            endPx: barPos.left + barPos.width,
            barWidth: barPos.width,
            task,
          });
          rowIdx++;
        });
      }
    });

    return { taskRowMap: rowMap, totalH: rowIdx * ROW_H };
  }, [grouped, collapsedGroups, getFlatRows, getBarPos]);

  const arrows = useMemo(() => {
    const arrowElements: React.ReactNode[] = [];
    const arrowSize = 5;
    const connectorOffset = 12; // Horizontal offset for connector line

    taskDependencies.forEach(dep => {
      const fromInfo = taskRowMap.get(dep.dependsOnTaskId);
      const toInfo = taskRowMap.get(dep.taskId);

      if (!fromInfo || !toInfo) return;

      const fromTask = fromInfo.task;
      const toTask = toInfo.task;
      const isSatisfied = isDependencySatisfied(fromTask, toTask);

      const fromX = fromInfo.endPx;
      const fromY = fromInfo.rowY;
      const toX = toInfo.startPx;
      const toY = toInfo.rowY;

      // Arrow color based on dependency satisfaction
      const strokeColor = isSatisfied ? '#16a34a' : '#dc2626'; // green if satisfied, red if blocker
      const strokeOpacity = 0.7;

      // Path: from task end -> connector -> to task start
      let pathD: string;

      if (Math.abs(fromY - toY) < 2) {
        // Same row: simple horizontal line
        pathD = `M ${fromX} ${fromY} L ${toX} ${toY}`;
      } else {
        // Different rows: L-shaped connector
        const midX = fromX + connectorOffset;
        pathD = `M ${fromX} ${fromY} L ${midX} ${fromY} L ${midX} ${toY} L ${toX} ${toY}`;
      }

      // Arrowhead polygon (pointing right towards the task)
      const arrowPoints = `${toX},${toY} ${toX - arrowSize * 1.5},${toY - arrowSize * 0.8} ${toX - arrowSize * 1.5},${toY + arrowSize * 0.8}`;

      arrowElements.push(
        <g key={dep.id}>
          {/* Main connector line */}
          <path
            d={pathD}
            fill="none"
            stroke={strokeColor}
            strokeWidth={2}
            strokeOpacity={strokeOpacity}
            strokeLinecap="round"
            strokeLinejoin="round"
          />
          {/* Arrowhead */}
          <polygon
            points={arrowPoints}
            fill={strokeColor}
            fillOpacity={strokeOpacity}
          />
        </g>
      );
    });

    return arrowElements;
  }, [taskRowMap, taskDependencies]);

  if (arrows.length === 0) return null;

  return (
    <svg
      className="absolute top-0 left-0 pointer-events-none overflow-visible"
      style={{
        width: timelineWidth,
        height: Math.max(totalH, 1),
        zIndex: 4,
      }}
    >
      <defs>
        {/* Define arrowhead markers for better rendering */}
        <marker
          id="arrowhead-satisfied"
          markerWidth={10}
          markerHeight={10}
          refX={8}
          refY={3}
          orient="auto"
        >
          <polygon points="0 0, 10 3, 0 6" fill="#16a34a" fillOpacity={0.7} />
        </marker>
        <marker
          id="arrowhead-blocker"
          markerWidth={10}
          markerHeight={10}
          refX={8}
          refY={3}
          orient="auto"
        >
          <polygon points="0 0, 10 3, 0 6" fill="#dc2626" fillOpacity={0.7} />
        </marker>
      </defs>
      {arrows}
    </svg>
  );
});

GanttDependencyArrows.displayName = 'GanttDependencyArrows';

export default GanttDependencyArrows;
