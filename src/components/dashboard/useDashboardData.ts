import { useMemo } from 'react';
import { useMemberContext } from '@/context/MemberContext';
import { useProjectContext } from '@/context/ProjectContext';
import { useProjectScope } from '@/hooks/useProjectScope';
import { useTaskContext } from '@/context/TaskContext';
import { useSprintContext } from '@/context/SprintContext';
import { useIsMobile } from '@/hooks/use-mobile';
import { sortUsersByDept } from '@/lib/department';

function parseDateTime(value?: string | null): number {
  if (!value) return Number.NaN;
  return Date.parse(value);
}

function getStatusLogTime(log: { id: string; changedAt: string }): number {
  const idMatch = /^sl-(\d{10,})-/.exec(log.id);
  if (idMatch) {
    const ts = Number(idMatch[1]);
    if (Number.isFinite(ts)) return ts;
  }
  return parseDateTime(log.changedAt);
}

export function getDwellColor(days: number) {
  return days <= 7 ? '#36B37E' : days <= 14 ? '#FF8B00' : '#FF5630';
}

export function getLoadColor(n: number) {
  return n <= 3 ? '#36B37E' : n <= 5 ? '#FF8B00' : '#FF5630';
}

export function getEffColor(days: number, type: 'create' | 'start') {
  if (type === 'create') return days <= 7 ? '#36B37E' : days <= 14 ? '#FF8B00' : '#FF5630';
  return days <= 5 ? '#36B37E' : days <= 10 ? '#FF8B00' : '#FF5630';
}

export function formatDate(d: string | null): string {
  if (!d) return '—';
  const date = new Date(d);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')} ${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

export function useDashboardData() {
  const { users } = useMemberContext();
  const { allProjects: everyProject, productLines: everyLine } = useProjectContext();
  const { allTasks: everyTask, statuses, statusLogs: everyLog } = useTaskContext();
  // Statistics cover the sidebar project or product line, like every other task view.
  const { projectIds: scopeIds } = useProjectScope();
  const allTasks = useMemo(() => scopeIds ? everyTask.filter(task => scopeIds.has(task.projectId)) : everyTask, [everyTask, scopeIds]);
  const allProjects = useMemo(() => scopeIds ? everyProject.filter(project => scopeIds.has(project.id)) : everyProject, [everyProject, scopeIds]);
  const productLines = useMemo(() => scopeIds ? everyLine.filter(line => allProjects.some(project => project.lineId === line.id)) : everyLine, [everyLine, allProjects, scopeIds]);
  const statusLogs = useMemo(() => { if (!scopeIds) return everyLog; const ids = new Set(allTasks.map(task => task.id)); return everyLog.filter(log => ids.has(log.taskId)); }, [everyLog, allTasks, scopeIds]);
  const { sprints, currentSprint, sprintActive } = useSprintContext();
  const isMobile = useIsMobile();

  const now = new Date();
  const nowTs = now.getTime();
  const msPerDay = 1000 * 60 * 60 * 24;

  const totalTasks = allTasks.length;

  const doneStatusIds = useMemo(() =>
    statuses.filter(s => s.isDone).map(s => s.id),
  [statuses]);

  const overdueTasks = useMemo(() =>
    allTasks.filter(t =>
      t.dueDate && new Date(t.dueDate) < now && !t.completedAt && !doneStatusIds.includes(t.statusId)
    ).length,
  [allTasks, doneStatusIds]);

  const statusData = useMemo(() =>
    statuses.map(s => {
      const count = allTasks.filter(t => t.statusId === s.id).length;
      return { name: s.name, count, color: s.color, pct: totalTasks > 0 ? Math.round((count / totalTasks) * 100) : 0 };
    }),
  [statuses, allTasks, totalTasks]);

  const dwellData = useMemo(() => {
    const nonDoneStatuses = statuses.filter(s => !s.isDone);
    const taskMap = new Map(allTasks.map(task => [task.id, task]));
    const taskLogMap = new Map<string, typeof statusLogs>();
    statusLogs.forEach(log => {
      if (!taskLogMap.has(log.taskId)) taskLogMap.set(log.taskId, []);
      taskLogMap.get(log.taskId)!.push(log);
    });
    const dwellDays: Record<string, number[]> = {};
    nonDoneStatuses.forEach(s => (dwellDays[s.id] = []));
    taskLogMap.forEach((logs, taskId) => {
      const sorted = logs.map(log => ({ ...log, time: getStatusLogTime(log) })).filter(log => Number.isFinite(log.time)).sort((a, b) => a.time - b.time);
      if (sorted.length === 0) return;
      for (let i = 0; i < sorted.length; i++) {
        const statusId = sorted[i].toStatusId;
        if (!dwellDays[statusId]) continue;
        const startTime = sorted[i].time;
        const nextTime = sorted[i + 1]?.time;
        const completedTime = parseDateTime(taskMap.get(taskId)?.completedAt);
        const endTime = nextTime ?? (Number.isFinite(completedTime) ? completedTime : nowTs);
        const days = (endTime - startTime) / msPerDay;
        if (Number.isFinite(days) && days >= 0) dwellDays[statusId].push(days);
      }
    });
    const firstStatusId = statuses.find(s => s.sortOrder === Math.min(...statuses.map(st => st.sortOrder)))?.id;
    const inProgressStatus = statuses.find(s => s.autoStart);
    allTasks.forEach(task => {
      if (taskLogMap.has(task.id)) return;
      const createdTs = parseDateTime(task.createdAt);
      const startedTs = parseDateTime(task.startedAt);
      const completedTs = parseDateTime(task.completedAt);
      if (firstStatusId && dwellDays[firstStatusId] !== undefined && Number.isFinite(createdTs)) {
        const endTs = Number.isFinite(startedTs) ? startedTs : (Number.isFinite(completedTs) ? completedTs : nowTs);
        const days = (endTs - createdTs) / msPerDay;
        if (Number.isFinite(days) && days >= 0) dwellDays[firstStatusId].push(days);
      }
      if (inProgressStatus && dwellDays[inProgressStatus.id] !== undefined && Number.isFinite(startedTs)) {
        const endTs = Number.isFinite(completedTs) ? completedTs : nowTs;
        const days = (endTs - startedTs) / msPerDay;
        if (Number.isFinite(days) && days >= 0) dwellDays[inProgressStatus.id].push(days);
      }
    });
    return nonDoneStatuses.map(s => {
      const arr = dwellDays[s.id];
      const avg = arr.length > 0 ? arr.reduce((a, b) => a + b, 0) / arr.length : 0;
      const safeAvg = Number.isFinite(avg) ? Math.round(avg * 10) / 10 : 0;
      return { ...s, avg: safeAvg, samples: arr.length };
    });
  }, [allTasks, nowTs, statusLogs, statuses]);

  const transitionData = useMemo(() => {
    const taskLogMap = new Map<string, typeof statusLogs>();
    const statusMap = new Map(statuses.map(s => [s.id, s]));
    statusLogs.forEach(log => {
      if (!taskLogMap.has(log.taskId)) taskLogMap.set(log.taskId, []);
      taskLogMap.get(log.taskId)!.push(log);
    });
    const transitions: Record<string, { days: number[]; fromId: string; toId: string }> = {};
    taskLogMap.forEach(logs => {
      const sorted = logs.map(log => ({ ...log, time: getStatusLogTime(log) })).filter(log => Number.isFinite(log.time)).sort((a, b) => a.time - b.time);
      for (let i = 0; i < sorted.length - 1; i++) {
        const from = sorted[i].toStatusId;
        const to = sorted[i + 1].toStatusId;
        const key = `${from}->${to}`;
        if (!transitions[key]) transitions[key] = { days: [], fromId: from, toId: to };
        const days = (sorted[i + 1].time - sorted[i].time) / msPerDay;
        if (Number.isFinite(days) && days >= 0) transitions[key].days.push(days);
      }
    });
    const firstStatus = statuses.find(s => s.sortOrder === Math.min(...statuses.map(st => st.sortOrder)));
    const inProgressStatus = statuses.find(s => s.autoStart);
    const doneStatus = statuses.find(s => s.isDone);
    allTasks.forEach(task => {
      if (taskLogMap.has(task.id)) return;
      const createdTs = parseDateTime(task.createdAt);
      const startedTs = parseDateTime(task.startedAt);
      const completedTs = parseDateTime(task.completedAt);
      if (firstStatus && inProgressStatus && Number.isFinite(createdTs) && Number.isFinite(startedTs)) {
        const key = `${firstStatus.id}->${inProgressStatus.id}`;
        if (!transitions[key]) transitions[key] = { days: [], fromId: firstStatus.id, toId: inProgressStatus.id };
        const days = (startedTs - createdTs) / msPerDay;
        if (Number.isFinite(days) && days >= 0) transitions[key].days.push(days);
      }
      if (inProgressStatus && doneStatus && Number.isFinite(startedTs) && Number.isFinite(completedTs)) {
        const key = `${inProgressStatus.id}->${doneStatus.id}`;
        if (!transitions[key]) transitions[key] = { days: [], fromId: inProgressStatus.id, toId: doneStatus.id };
        const days = (completedTs - startedTs) / msPerDay;
        if (Number.isFinite(days) && days >= 0) transitions[key].days.push(days);
      }
      if (firstStatus && doneStatus && Number.isFinite(createdTs) && Number.isFinite(completedTs) && !Number.isFinite(startedTs)) {
        const key = `${firstStatus.id}->${doneStatus.id}`;
        if (!transitions[key]) transitions[key] = { days: [], fromId: firstStatus.id, toId: doneStatus.id };
        const days = (completedTs - createdTs) / msPerDay;
        if (Number.isFinite(days) && days >= 0) transitions[key].days.push(days);
      }
    });
    return Object.values(transitions)
      .map(v => {
        const from = statusMap.get(v.fromId);
        const to = statusMap.get(v.toId);
        if (!from || !to || v.days.length === 0) return null;
        const avg = v.days.reduce((a, b) => a + b, 0) / v.days.length;
        return { from, to, avg: Number.isFinite(avg) ? Math.round(avg * 10) / 10 : 0, count: v.days.length };
      })
      .filter((item): item is { from: typeof statuses[number]; to: typeof statuses[number]; avg: number; count: number } => item !== null)
      .sort((a, b) => b.count - a.count);
  }, [allTasks, statusLogs, statuses]);

  const teamData = useMemo(() => {
    const sortedStatuses = [...statuses].sort((a, b) => a.sortOrder - b.sortOrder);
    const inProgressIds = sortedStatuses.filter(s => !s.isDone && s.autoStart).map(s => s.id);
    const activeStatusIds = inProgressIds.length > 0 ? inProgressIds : sortedStatuses.filter((s, i) => !s.isDone && i > 0).map(s => s.id);
    const maxInProgress = Math.max(...users.map(u => allTasks.filter(t => t.assigneeId === u.id && activeStatusIds.includes(t.statusId)).length), 1);
    const result = users.filter(u => u.isActive).map(u => {
      const userTasks = allTasks.filter(t => t.assigneeId === u.id);
      const inProgress = userTasks.filter(t => activeStatusIds.includes(t.statusId)).length;
      const overdue = userTasks.filter(t => t.dueDate && new Date(t.dueDate) < now && !t.completedAt && !doneStatusIds.includes(t.statusId)).length;
      const completed = userTasks.filter(t => t.completedAt);
      // Only spans that make sense count: an imported task can show a finish before its creation.
      const averageDays = (spans: [string | undefined, string | undefined][]) => {
        const days = spans.map(([from, to]) => (parseDateTime(to) - parseDateTime(from)) / msPerDay).filter(value => Number.isFinite(value) && value >= 0);
        return days.length ? days.reduce((sum, value) => sum + value, 0) / days.length : null;
      };
      const avgCreateToComplete = averageDays(completed.map(t => [t.createdAt, t.completedAt]));
      const avgStartToComplete = averageDays(completed.filter(t => t.startedAt).map(t => [t.startedAt, t.completedAt]));
      return {
        ...u,
        byStatus: statuses.map(s => ({ status: s, count: userTasks.filter(t => t.statusId === s.id).length })),
        inProgress, loadPct: Math.round((inProgress / maxInProgress) * 100), overdue, total: userTasks.length,
        avgCreateToComplete: avgCreateToComplete !== null ? Math.round(avgCreateToComplete * 10) / 10 : null,
        avgStartToComplete: avgStartToComplete !== null ? Math.round(avgStartToComplete * 10) / 10 : null,
      };
    });
    return sortUsersByDept(result);
  }, [allTasks, users, statuses, nowTs, msPerDay]);

  const lineData = useMemo(() =>
    productLines.map(line => {
      const lineProjectIds = allProjects.filter(p => p.lineId === line.id).map(p => p.id);
      const lineTasks = allTasks.filter(t => lineProjectIds.includes(t.projectId));
      const done = lineTasks.filter(t => doneStatusIds.includes(t.statusId)).length;
      const active = lineTasks.length - done;
      return { ...line, total: lineTasks.length, done, active, pct: lineTasks.length > 0 ? Math.round((done / lineTasks.length) * 100) : 0 };
    }),
  [allTasks, allProjects, productLines, doneStatusIds]);

  const projectProgressData = useMemo(() =>
    allProjects.map(project => {
      const projectTasks = allTasks.filter(t => t.projectId === project.id);
      const done = projectTasks.filter(t => doneStatusIds.includes(t.statusId)).length;
      const inProgress = projectTasks.length - done;
      const pct = projectTasks.length > 0 ? Math.round((done / projectTasks.length) * 100) : 0;
      return { ...project, total: projectTasks.length, done, inProgress, pct };
    }).sort((a, b) => b.pct - a.pct || b.total - a.total),
  [allProjects, allTasks, doneStatusIds]);

  const completedSprints = sprints.filter(s => !s.isActive);

  return {
    totalTasks, overdueTasks,
    statusData, dwellData, transitionData, teamData, lineData, projectProgressData,
    completedSprints, currentSprint, sprintActive,
    statuses, isMobile,
  };
}
