import { supabase } from '@/integrations/supabase/client';

export interface ActivityLog {
  id: string;
  user_id: string;
  action: string;
  target_type: string;
  task_id: string | null;
  task_key: string | null;
  detail: string;
  created_at: string;
}

export const logActivity = async (
  userId: string,
  action: string,
  detail: string,
  taskId?: string,
  taskKey?: string,
  targetType: string = 'task'
) => {
  const { error } = await supabase.from('activity_logs').insert({
    user_id: userId,
    action,
    target_type: targetType,
    task_id: taskId || null,
    task_key: taskKey || null,
    detail,
  });
  if (error) console.error('[LIVO] Failed to log activity:', error.message);
};

export const fetchTaskActivityLogs = async (taskId: string): Promise<ActivityLog[]> => {
  const { data, error } = await supabase
    .from('activity_logs')
    .select('*')
    .eq('task_id', taskId)
    .order('created_at', { ascending: false })
    .limit(100);
  if (error) console.error('[LIVO] Failed to load task activity logs:', error.message);
  return (data as ActivityLog[]) || [];
};

export const fetchUserActivityLogs = async (limit = 50): Promise<ActivityLog[]> => {
  const { data, error } = await supabase
    .from('activity_logs')
    .select('*')
    .order('created_at', { ascending: false })
    .limit(limit);
  if (error) console.error('[LIVO] Failed to load user activity logs:', error.message);
  return (data as ActivityLog[]) || [];
};
