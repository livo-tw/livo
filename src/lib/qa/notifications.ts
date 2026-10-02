export interface QaNotificationContent { kind: 'qa'; issueId: string; title: string; event: string; }
export function parseQaNotification(content: string): QaNotificationContent | null {
  try {
    const value = JSON.parse(content);
    if (value?.kind !== 'qa' || typeof value.issueId !== 'string' || !/^[a-zA-Z0-9_-]{1,200}$/.test(value.issueId) || typeof value.title !== 'string') return null;
    return { kind: 'qa', issueId: value.issueId, title: value.title.slice(0, 200), event: typeof value.event === 'string' ? value.event : '' };
  } catch { return null; }
}
