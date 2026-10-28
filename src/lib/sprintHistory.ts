import { supabase } from '@/integrations/supabase/client';
import type { SprintHistoryRecord } from './sprintLifecycle';

/** Paginate rather than silently truncating a completed sprint to the API row limit. */
export async function readSprintHistory(sprintId: string): Promise<SprintHistoryRecord[]> {
  const rows: SprintHistoryRecord[] = [];
  for (let start = 0; ; start += 500) {
    const { data, error } = await supabase.from('sprint_task_history').select('*').eq('sprint_id', sprintId).order('recorded_at').order('id').range(start, start + 499);
    if (error || !Array.isArray(data)) throw new Error('sprint_history_unavailable');
    if (data.some(row => row.sprint_id !== sprintId || !['completed', 'cancelled', 'pending', 'removed', 'unknown'].includes(row.outcome))) throw new Error('sprint_history_unavailable');
    rows.push(...data);
    if (data.length < 500) return rows;
  }
}
