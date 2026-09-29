import { useMemo } from 'react';
import i18n from '@/i18n';
import type { User, Task, Project } from '@/types';
import { getDepartment } from '@/lib/department';
import type { SortMode } from '@/hooks/useStandupSettings';

export interface StandupGroup {
  group_key: string;
  group_title: string;
  task_count: number;
  estimated_duration: number; // seconds (member durations + buffers)
  members: User[];
}

// ─── Due-date bucketing ────────────────────────────────────────────────────

const DUE_BUCKET_ORDER = ['overdue', 'today', 'this_week', 'next_week', 'later', 'no_due'] as const;
type DueBucket = (typeof DUE_BUCKET_ORDER)[number];

function getDueBucketLabels(): Record<DueBucket, string> {
  return {
    overdue:   `⚠️ ${i18n.t('standup.dueBucket.overdue')}`,
    today:     `📅 ${i18n.t('standup.dueBucket.today')}`,
    this_week: `📆 ${i18n.t('standup.dueBucket.thisWeek')}`,
    next_week: `🗓️ ${i18n.t('standup.dueBucket.nextWeek')}`,
    later:     `📌 ${i18n.t('standup.dueBucket.later')}`,
    no_due:    `🔲 ${i18n.t('standup.dueBucket.noDue')}`,
  };
}

function getDueDateBucket(dueDate: string | undefined): DueBucket {
  if (!dueDate) return 'no_due';
  const now = new Date();
  now.setHours(0, 0, 0, 0);
  const due = new Date(dueDate);
  due.setHours(0, 0, 0, 0);
  const diff = Math.floor((due.getTime() - now.getTime()) / 86_400_000);
  if (diff < 0)  return 'overdue';
  if (diff === 0) return 'today';
  if (diff <= 6)  return 'this_week';
  if (diff <= 13) return 'next_week';
  return 'later';
}

function getNearestBucket(memberTasks: Task[]): DueBucket {
  if (memberTasks.length === 0) return 'no_due';
  const buckets = memberTasks.map(t => DUE_BUCKET_ORDER.indexOf(getDueDateBucket(t.dueDate)));
  return DUE_BUCKET_ORDER[Math.min(...buckets)];
}

// ─── Core grouping function ────────────────────────────────────────────────

export function groupMembers(
  members: User[],
  tasks: Task[],
  projects: Project[],
  sortMode: SortMode,
  getDuration: (id: string) => number,
  bufferSeconds: number,
): StandupGroup[] {
  switch (sortMode) {
    case 'by_member': {
      return members.map(m => {
        const mt = tasks.filter(t => t.assigneeId === m.id);
        return {
          group_key: m.id,
          group_title: m.name,
          task_count: mt.length,
          estimated_duration: getDuration(m.id) + bufferSeconds,
          members: [m],
        };
      });
    }

    case 'by_project': {
      const projectMap = new Map(projects.map(p => [p.id, p]));
      const groupMap = new Map<string, { project: Project; members: User[]; tasks: Task[] }>();

      for (const member of members) {
        const mt = tasks.filter(t => t.assigneeId === member.id);
        const projectIds = [...new Set(mt.map(t => t.projectId))];
        for (const pid of projectIds) {
          const project = projectMap.get(pid);
          if (!project) continue;
          if (!groupMap.has(pid)) groupMap.set(pid, { project, members: [], tasks: [] });
          const g = groupMap.get(pid)!;
          if (!g.members.find(u => u.id === member.id)) g.members.push(member);
          g.tasks.push(...mt.filter(t => t.projectId === pid));
        }
      }

      const assignedMemberIds = new Set<string>();
      for (const g of groupMap.values()) {
        for (const m of g.members) assignedMemberIds.add(m.id);
      }
      const unassigned = members.filter(m => !assignedMemberIds.has(m.id));

      const result: StandupGroup[] = [...groupMap.values()]
        .sort((a, b) => a.project.name.localeCompare(b.project.name))
        .map(g => ({
          group_key: g.project.id,
          group_title: `📁 ${g.project.name}`,  // project name is user data, not hardcoded
          task_count: g.tasks.length,
          estimated_duration: g.members.reduce((s, m) => s + getDuration(m.id) + bufferSeconds, 0),
          members: g.members,
        }));

      if (unassigned.length > 0) {
        result.push({
          group_key: '__unassigned__',
          group_title: `📋 ${i18n.t('standup.unassigned')}`,
          task_count: 0,
          estimated_duration: unassigned.reduce((s, m) => s + getDuration(m.id) + bufferSeconds, 0),
          members: unassigned,
        });
      }

      return result;
    }

    case 'by_due_date': {
      const bucketMap = new Map<DueBucket, { members: User[]; tasks: Task[] }>(
        DUE_BUCKET_ORDER.map(b => [b, { members: [], tasks: [] }]),
      );

      for (const member of members) {
        const mt = tasks.filter(t => t.assigneeId === member.id);
        const bucket = getNearestBucket(mt);
        const g = bucketMap.get(bucket)!;
        g.members.push(member);
        g.tasks.push(...mt);
      }

      const dueBucketLabels = getDueBucketLabels();
      return DUE_BUCKET_ORDER
        .filter(b => bucketMap.get(b)!.members.length > 0)
        .map(b => {
          const g = bucketMap.get(b)!;
          return {
            group_key: b,
            group_title: dueBucketLabels[b],
            task_count: g.tasks.length,
            estimated_duration: g.members.reduce((s, m) => s + getDuration(m.id) + bufferSeconds, 0),
            members: g.members,
          };
        });
    }

    case 'by_department': {
      const deptMap = new Map<string, { label: string; members: User[]; tasks: Task[] }>();

      for (const member of members) {
        const uncategorized = i18n.t('standup.uncategorized');
        const dept = getDepartment(member) ?? uncategorized;
        const label = dept === uncategorized ? `🏷️ ${uncategorized}` : dept;
        if (!deptMap.has(dept)) deptMap.set(dept, { label, members: [], tasks: [] });
        const g = deptMap.get(dept)!;
        g.members.push(member);
        g.tasks.push(...tasks.filter(t => t.assigneeId === member.id));
      }

      return [...deptMap.entries()].map(([key, g]) => ({
        group_key: key,
        group_title: g.label,
        task_count: g.tasks.length,
        estimated_duration: g.members.reduce((s, m) => s + getDuration(m.id) + bufferSeconds, 0),
        members: g.members,
      }));
    }
  }
}

// ─── Hook ──────────────────────────────────────────────────────────────────

export interface QueueItem {
  member: User;
  group: StandupGroup;
  groupIndex: number;
  indexInGroup: number;
}

export function useStandupGrouping(
  members: User[],
  tasks: Task[],
  projects: Project[],
  sortMode: SortMode,
  getDuration: (id: string) => number,
  bufferSeconds: number,
) {
  const groups = useMemo(
    () => groupMembers(members, tasks, projects, sortMode, getDuration, bufferSeconds),
    [members, tasks, projects, sortMode, getDuration, bufferSeconds],
  );

  const flatQueue = useMemo<QueueItem[]>(() => {
    const queue: QueueItem[] = [];
    groups.forEach((group, groupIndex) => {
      group.members.forEach((member, indexInGroup) => {
        queue.push({ member, group, groupIndex, indexInGroup });
      });
    });
    return queue;
  }, [groups]);

  return { groups, flatQueue };
}
