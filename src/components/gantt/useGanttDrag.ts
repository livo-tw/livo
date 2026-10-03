import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { format } from 'date-fns';
import type { Task } from '@/types';
import type { DragInfo, PendingChange } from './types';

interface UseGanttDragOpts {
  cellW: number;
  pxToDate: (px: number) => Date;
  snapToPx: (px: number) => number;
  allTasks: Task[];
  isMobile: boolean;
}

export function useGanttDrag({ cellW, pxToDate, snapToPx, allTasks, isMobile }: UseGanttDragOpts) {
  const [dragInfo, setDragInfo] = useState<DragInfo | null>(null);
  const [pendingChange, setPendingChange] = useState<PendingChange | null>(null);

  const longPressTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingDragRef = useRef<{
    taskId: string;
    type: 'move' | 'start' | 'end';
    clientX: number;
    startPx: number;
    endPx: number;
  } | null>(null);
  const dragActivatedRef = useRef(false);

  const LONG_PRESS_MS = isMobile ? 500 : 300;

  const startDragSequence = useCallback((clientX: number, taskId: string, type: 'move' | 'start' | 'end', startPx: number, endPx: number) => {
    dragActivatedRef.current = false;
    pendingDragRef.current = { taskId, type, clientX, startPx, endPx };

    longPressTimer.current = setTimeout(() => {
      const info = pendingDragRef.current;
      if (!info) return;
      dragActivatedRef.current = true;
      setDragInfo({
        taskId: info.taskId,
        type: info.type,
        initialMouseX: info.clientX,
        initialStartPx: info.startPx,
        initialEndPx: info.endPx,
        currentStartPx: info.startPx,
        currentEndPx: info.endPx,
      });
    }, LONG_PRESS_MS);
  }, [LONG_PRESS_MS]);

  const handlePointerDown = useCallback((e: React.MouseEvent, taskId: string, type: 'move' | 'start' | 'end', startPx: number, endPx: number) => {
    e.stopPropagation();
    e.preventDefault();
    startDragSequence(e.clientX, taskId, type, startPx, endPx);
  }, [startDragSequence]);

  const handleTouchStart = useCallback((e: React.TouchEvent, taskId: string, type: 'move' | 'start' | 'end', startPx: number, endPx: number) => {
    e.stopPropagation();
    const touch = e.touches[0];
    if (!touch) return;
    startDragSequence(touch.clientX, taskId, type, startPx, endPx);
  }, [startDragSequence]);

  const clearLongPress = useCallback(() => {
    if (longPressTimer.current) {
      clearTimeout(longPressTimer.current);
      longPressTimer.current = null;
    }
    pendingDragRef.current = null;
  }, []);

  const computeDragDates = useCallback((startPx: number, endPx: number) => {
    const startDate = pxToDate(startPx);
    const endDate = pxToDate(endPx);
    return { startDate, endDate };
  }, [pxToDate]);

  // Cancel long-press on global pointer up (before drag activates)
  useEffect(() => {
    const handleGlobalUp = () => {
      if (!dragActivatedRef.current) clearLongPress();
    };
    window.addEventListener('mouseup', handleGlobalUp);
    window.addEventListener('touchend', handleGlobalUp);
    return () => {
      window.removeEventListener('mouseup', handleGlobalUp);
      window.removeEventListener('touchend', handleGlobalUp);
    };
  }, [clearLongPress]);

  // Drag move + end handlers
  useEffect(() => {
    if (!dragInfo) return;

    const handleMove = (clientX: number) => {
      const dx = clientX - dragInfo.initialMouseX;
      setDragInfo(prev => {
        if (!prev) return null;
        if (prev.type === 'move') {
          const rawStart = prev.initialStartPx + dx;
          const snappedStart = snapToPx(rawStart);
          const delta = snappedStart - prev.initialStartPx;
          return { ...prev, currentStartPx: snappedStart, currentEndPx: prev.initialEndPx + delta };
        }
        if (prev.type === 'start') {
          const raw = prev.initialStartPx + dx;
          const snapped = snapToPx(Math.min(raw, prev.currentEndPx - cellW));
          return { ...prev, currentStartPx: snapped };
        }
        const raw = prev.initialEndPx + dx;
        const snapped = snapToPx(Math.max(raw, prev.currentStartPx + cellW));
        return { ...prev, currentEndPx: snapped };
      });
    };

    const handleMouseMove = (e: MouseEvent) => handleMove(e.clientX);
    const handleTouchMove = (e: TouchEvent) => {
      if (e.touches[0]) {
        e.preventDefault();
        handleMove(e.touches[0].clientX);
      }
    };

    const handleEnd = () => {
      clearLongPress();
      if (!dragInfo) return;
      const task = allTasks.find(t => t.id === dragInfo.taskId);
      if (!task) { setDragInfo(null); return; }

      setDragInfo(prev => {
        if (!prev) return null;
        const { startDate, endDate } = computeDragDates(prev.currentStartPx, prev.currentEndPx);
        const fmtDate = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
        const newStart = fmtDate(startDate);
        const newEnd = fmtDate(endDate);

        const oldStart = task.startedAt;
        const oldEnd = task.dueDate;
        const effectiveNewStart = prev.type === 'end' ? oldStart : newStart;
        const effectiveNewEnd = prev.type === 'start' ? oldEnd : newEnd;
        if (effectiveNewStart !== oldStart || effectiveNewEnd !== oldEnd) {
          setPendingChange({
            taskId: task.id,
            taskKey: task.taskKey,
            taskTitle: task.title,
            oldStart,
            oldEnd,
            dueDateKind: task.dueDateKind ?? null,
            dueDateVersion: task.dueDateVersion ?? 0,
            newStart: effectiveNewStart,
            newEnd: effectiveNewEnd,
          });
        }
        return null;
      });
    };

    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', handleEnd);
    window.addEventListener('touchmove', handleTouchMove, { passive: false });
    window.addEventListener('touchend', handleEnd);
    return () => {
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleEnd);
      window.removeEventListener('touchmove', handleTouchMove);
      window.removeEventListener('touchend', handleEnd);
    };
  }, [dragInfo?.taskId, dragInfo?.type, dragInfo?.initialMouseX, allTasks, computeDragDates, cellW, clearLongPress, snapToPx]);

  const dragPreviewDates = useMemo(() => {
    if (!dragInfo) return null;
    const { startDate, endDate } = computeDragDates(dragInfo.currentStartPx, dragInfo.currentEndPx);
    return {
      start: format(startDate, 'MM/dd'),
      end: format(endDate, 'MM/dd'),
      startFull: format(startDate, 'yyyy/MM/dd'),
      endFull: format(endDate, 'yyyy/MM/dd'),
    };
  }, [dragInfo?.currentStartPx, dragInfo?.currentEndPx, computeDragDates]);

  const getDragBarPos = useCallback((task: { id: string; startPx: number; barWidth: number }) => {
    if (dragInfo && dragInfo.taskId === task.id) {
      return {
        left: dragInfo.currentStartPx,
        width: Math.max(cellW, dragInfo.currentEndPx - dragInfo.currentStartPx + cellW),
      };
    }
    return {
      left: Math.max(0, task.startPx),
      width: Math.max(cellW, task.barWidth),
    };
  }, [dragInfo, cellW]);

  return {
    dragInfo, setDragInfo,
    pendingChange, setPendingChange,
    dragActivatedRef,
    handlePointerDown, handleTouchStart,
    dragPreviewDates, getDragBarPos,
  };
}
