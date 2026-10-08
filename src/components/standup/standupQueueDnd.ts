export interface QueueDragData {
  kind: 'group' | 'member';
  groupKey: string;
  memberId?: string;
  name: string;
}

export const queueGroupId = (groupKey: string) => `standup-group:${encodeURIComponent(groupKey)}`;
export const queueMemberId = (groupKey: string, memberId: string) => `standup-member:${encodeURIComponent(groupKey)}:${encodeURIComponent(memberId)}`;

export function dragData(value: unknown): QueueDragData | null {
  if (!value || typeof value !== 'object') return null;
  const data = value as Record<string, unknown>;
  if ((data.kind !== 'group' && data.kind !== 'member') || typeof data.groupKey !== 'string' || typeof data.name !== 'string') return null;
  if (data.kind === 'member' && typeof data.memberId !== 'string') return null;
  return { kind: data.kind, groupKey: data.groupKey, name: data.name, memberId: typeof data.memberId === 'string' ? data.memberId : undefined };
}
