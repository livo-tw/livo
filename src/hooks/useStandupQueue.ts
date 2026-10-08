import { useEffect, useMemo, useState } from 'react';
import type { QueueItem, StandupGroup } from './useStandupGrouping';
import { standupQueueKey } from '@/lib/standupLaunch';

function flatten(groups: StandupGroup[]): QueueItem[] {
  return groups.flatMap((group, groupIndex) => group.members.map((member, indexInGroup) => ({ member, group, groupIndex, indexInGroup })));
}

function regroup(queue: QueueItem[]): StandupGroup[] {
  const groups = new Map<string, StandupGroup>();
  for (const item of queue) {
    const key = item.group.group_key;
    if (!groups.has(key)) groups.set(key, { ...item.group, members: [] });
    groups.get(key)!.members.push(item.member);
  }
  return [...groups.values()];
}

/** Session-only edits: never persist exclusions into the next meeting's settings. */
export function useStandupQueue(groups: StandupGroup[], initialExcluded: string[] = []) {
  const [excludedMemberIds, setExcludedMemberIds] = useState(initialExcluded);
  const [order, setOrder] = useState<string[]>([]);
  const [completedKeys, setCompletedKeys] = useState<string[]>([]);
  const [cursor, setCursor] = useState<{ key: string | null; index: number }>({ key: null, index: 0 });
  const [finished, setFinished] = useState(false);

  const orderedQueue = useMemo(() => {
    const ranks = new Map(order.map((key, index) => [key, index]));
    return flatten(groups).sort((a, b) => (ranks.get(standupQueueKey(a)) ?? order.length) - (ranks.get(standupQueueKey(b)) ?? order.length));
  }, [groups, order]);
  const completedQueue = useMemo(() => {
    const itemsByKey = new Map(orderedQueue.map(item => [standupQueueKey(item), item]));
    // Completed turns follow the order they were actually reported, even when
    // a pending speaker was selected ahead of the original launch order.
    return completedKeys.flatMap(key => {
      const item = itemsByKey.get(key);
      return item ? [item] : [];
    });
  }, [orderedQueue, completedKeys]);
  // Excluding a person who has another project turn must leave their current
  // report and all finished reports intact. The explicit skip action handles it.
  const remainingQueue = orderedQueue.filter(item => !completedKeys.includes(standupQueueKey(item)) &&
    (!excludedMemberIds.includes(item.member.id) || standupQueueKey(item) === cursor.key));
  const matching = remainingQueue.findIndex(item => standupQueueKey(item) === cursor.key);
  const remainingIndex = matching >= 0 ? matching : Math.max(0, Math.min(cursor.index, remainingQueue.length - 1));
  const currentItem = finished ? null : remainingQueue[remainingIndex] ?? null;
  const currentKey = currentItem ? standupQueueKey(currentItem) : null;
  const pendingQueue = remainingQueue.filter(item => standupQueueKey(item) !== currentKey);
  const pendingGroups = regroup(pendingQueue);
  const flatQueue = [...completedQueue, ...(currentItem ? [currentItem] : []), ...pendingQueue];
  const excludedMembers = [...new Map(orderedQueue.filter(item => excludedMemberIds.includes(item.member.id)).map(item => [item.member.id, item.member])).values()];

  useEffect(() => {
    if (finished) return;
    setCursor(previous => previous.key === currentKey && previous.index === remainingIndex ? previous : { key: currentKey, index: remainingIndex });
  }, [currentKey, remainingIndex, finished]);

  const reorderPending = (nextGroups: StandupGroup[]) => {
    const keys = flatten(nextGroups).map(standupQueueKey);
    const allowed = new Set(pendingQueue.map(standupQueueKey));
    // A reorder cannot introduce, duplicate, or silently drop a report.
    if (keys.length !== allowed.size || new Set(keys).size !== keys.length || keys.some(key => !allowed.has(key))) return;
    setOrder([...completedQueue.map(standupQueueKey), ...(currentKey ? [currentKey] : []), ...keys]);
  };

  const excludeMember = (memberId: string) => {
    if (!pendingQueue.some(item => item.member.id === memberId)) return;
    setExcludedMemberIds(previous => [...new Set([...previous, memberId])]);
  };

  const restoreMember = (memberId: string) => {
    const recovered = orderedQueue.filter(item => item.member.id === memberId && !completedKeys.includes(standupQueueKey(item)) && standupQueueKey(item) !== currentKey);
    const nextGroups = pendingGroups.map(group => ({ ...group, members: [...group.members] }));
    for (const item of recovered) {
      const group = nextGroups.find(candidate => candidate.group_key === item.group.group_key);
      if (group) {
        if (!group.members.some(member => member.id === memberId)) group.members.push(item.member);
      } else nextGroups.push({ ...item.group, members: [item.member] });
    }
    setOrder([...completedQueue.map(standupQueueKey), ...(currentKey ? [currentKey] : []), ...flatten(nextGroups).map(standupQueueKey)]);
    setExcludedMemberIds(previous => previous.filter(id => id !== memberId));
    // Restoring during an empty/completed meeting makes the recovered report available.
    if (finished && recovered.length) {
      setCursor({ key: standupQueueKey(recovered[0]), index: 0 });
      setFinished(false);
    }
  };

  const advance = () => {
    if (!currentItem) return false;
    setCompletedKeys(previous => [...new Set([...previous, currentKey!])]);
    const next = pendingQueue[0];
    setCursor({ key: next ? standupQueueKey(next) : null, index: 0 });
    setFinished(!next);
    return !next;
  };

  const skipCurrent = () => {
    if (!currentItem) return;
    setExcludedMemberIds(previous => [...new Set([...previous, currentItem.member.id])]);
    const next = pendingQueue.find(item => item.member.id !== currentItem.member.id);
    setCursor({ key: next ? standupQueueKey(next) : null, index: 0 });
    setFinished(!next);
  };

  const select = (groupKey: string, memberId: string) => {
    const index = remainingQueue.findIndex(item => item.group.group_key === groupKey && item.member.id === memberId);
    if (index >= 0) {
      setCursor({ key: standupQueueKey(remainingQueue[index]), index });
      // A previously unavailable member can rejoin after the queue finished.
      // Selecting their pending turn explicitly resumes this same meeting.
      setFinished(false);
    }
  };

  const restart = () => {
    setCompletedKeys([]);
    setCursor({ key: null, index: 0 });
    setFinished(false);
  };

  return { currentItem, currentKey, pendingGroups, completedQueue, flatQueue, queueIndex: completedQueue.length,
    excludedMembers, excludedMemberIds, finished, reorderPending, excludeMember, restoreMember, advance, skipCurrent, select, restart };
}
