import type { Task, Project } from '@/types';

export type GroupByMode = 'member' | 'line' | 'project';
export type ViewMode = 'day' | 'week' | 'month' | 'quarter';

export const ROW_H = 38;
export const HEADER_H = 48;
export const CELL_WIDTHS: Record<ViewMode, number> = { day: 24, week: 36, month: 48, quarter: 60 };
export const weekDayLabels = ['日', '一', '二', '三', '四', '五', '六'];
export const quarterLabels = ['Q1', 'Q2', 'Q3', 'Q4'];

export type ColDay = { date: Date; key: string; label?: undefined; year?: undefined };
export type ColPeriod = { date: Date; key: string; label: string; year: number };
export type Col = ColDay | ColPeriod;

export interface EnrichedTask extends Task {
  project: Project | undefined;
  startPx: number;
  endPx: number;
  barWidth: number;
  isOverdue: boolean | undefined | "";
}

export interface DragInfo {
  taskId: string;
  type: 'move' | 'start' | 'end';
  initialMouseX: number;
  initialStartPx: number;
  initialEndPx: number;
  currentStartPx: number;
  currentEndPx: number;
}

export interface PendingChange {
  taskId: string;
  taskKey: string;
  taskTitle: string;
  oldStart: string | undefined;
  oldEnd: string | undefined;
  dueDateKind: 'estimated' | 'committed' | null;
  dueDateVersion: number;
  newStart: string | undefined;
  newEnd: string | undefined;
}

export type GanttFlatRow = { task: EnrichedTask; isSubtask: boolean; hasSubtasks: boolean; isOrphan: boolean };

export type GanttGroup = { id: string; label: string; avatar?: string; color: string; tasks: EnrichedTask[]; icon?: string };
