import { supabase } from '@/integrations/supabase/client';

interface NotificationReference { id: string; senderId: string; type: string }

/** The server derives names from received notification IDs, never caller-supplied account IDs. */
export async function qaNotificationPeople(notifications: readonly NotificationReference[], signal?: AbortSignal): Promise<Record<string, string>> {
  const qa = notifications.filter(notification => notification.type === 'qa_update');
  if (!qa.length || !supabase.functions?.invoke) return {};
  const { data, error } = await supabase.functions.invoke('qa', {
    body: { action: 'notification_people', notificationIds: qa.slice(0, 50).map(notification => notification.id) }, signal,
  });
  if (error) throw error;
  if (signal?.aborted) return {};
  const names: unknown = data?.memberNames;
  if (!names || typeof names !== 'object' || Array.isArray(names)) return {};
  const ids = new Set(qa.map(notification => notification.senderId));
  return Object.fromEntries(Object.entries(names).filter(([id, name]) => ids.has(id) && typeof name === 'string'
    && name.trim() && name !== id));
}
