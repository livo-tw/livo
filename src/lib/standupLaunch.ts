import type { User, Task } from '@/types';
import type { StandupSettings } from '@/hooks/useStandupSettings';
import type { StandupGroup, QueueItem } from '@/hooks/useStandupGrouping';

export interface StandupOrder { groupKeys: string[]; memberIds: Record<string, string[]> }
export interface StandupLaunchSnapshot {
  settings: StandupSettings;
  groups: Array<Omit<StandupGroup, 'members'> & { memberIds: string[] }>;
}

// A launch is local to this running UI. Never round-trip the preview through an
// asynchronous database read: that can replace it with the previous meeting order.
let launchSnapshot: StandupLaunchSnapshot | undefined;
export function saveStandupLaunch(settings: StandupSettings, groups: StandupGroup[]) {
  launchSnapshot = { settings: { ...settings, memberDurations: { ...settings.memberDurations } },
    groups: groups.map(({ members, ...group }) => ({ ...group, memberIds: members.map(member => member.id) })) };
}
export const getStandupLaunch = () => launchSnapshot;
export const clearStandupLaunch = () => { launchSnapshot = undefined; };

function shuffled<T>(items: readonly T[], random: () => number) {
  const result = [...items];
  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1)); [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}

/** Called only when the user presses shuffle; grouping and rerenders never draw randomness. */
export function shuffleStandupOrder(groups: StandupGroup[], random = Math.random): StandupOrder {
  return { groupKeys: shuffled(groups.map(group => group.group_key), random),
    memberIds: Object.fromEntries(groups.map(group => [group.group_key, shuffled(group.members.map(member => member.id), random)])) };
}

export function applyStandupOrder(groups: StandupGroup[], order?: StandupOrder): StandupGroup[] {
  if (!order) return groups;
  const rank = (ids: string[], id: string) => { const index = ids.indexOf(id); return index < 0 ? ids.length : index; };
  return [...groups].sort((a, b) => rank(order.groupKeys, a.group_key) - rank(order.groupKeys, b.group_key)).map(group => ({ ...group,
    members: [...group.members].sort((a, b) => rank(order.memberIds[group.group_key] || [], a.id) - rank(order.memberIds[group.group_key] || [], b.id)) }));
}

/** Keep launch order, but resolve every participant against the current active roster. */
export function restoreStandupGroups(snapshot: StandupLaunchSnapshot, users: User[], tasks: Task[], getDuration: (id: string) => number, buffer: number): StandupGroup[] {
  const active = new Map(users.filter(user => user.isActive === true).map(user => [user.id, user]));
  return snapshot.groups.map(({ memberIds, ...group }) => {
    const members = [...new Set(memberIds)].flatMap(id => active.has(id) ? [active.get(id)!] : []);
    const ids = new Set(members.map(member => member.id));
    return { ...group, members, task_count: tasks.filter(task => task.assigneeId && ids.has(task.assigneeId) &&
      (snapshot.settings.sortMode !== 'by_project' || task.projectId === group.group_key)).length,
    estimated_duration: members.reduce((sum, member) => sum + getDuration(member.id) + buffer, 0) };
  }).filter(group => group.members.length > 0);
}

export const standupQueueKey = (item: QueueItem) => JSON.stringify([item.group.group_key, item.member.id]);
export function resolveStandupCursor(queue: QueueItem[], cursor: { key: string | null; index: number }): number {
  const matching = cursor.key === null ? -1 : queue.findIndex(item => standupQueueKey(item) === cursor.key);
  return matching >= 0 ? matching : Math.max(0, Math.min(cursor.index, queue.length - 1));
}
