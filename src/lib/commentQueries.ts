import type { supabase } from '@/integrations/supabase/client';
import type { Tables } from '@/integrations/supabase/types';

type CommentQueryResult = { data: Tables<'comments'>[] | null; error: { message: string } | null };

/** Read every comment visible through RLS, including rows beyond the API page limit. */
export async function fetchComments(db: typeof supabase): Promise<CommentQueryResult> {
  const rows: Tables<'comments'>[] = [];
  const pageSize = 200;
  for (let offset = 0; ; offset += pageSize) {
    const query = db.from('comments').select('*').order('id');
    // The local demo returns its complete in-memory table and has no range API.
    if (typeof query.range !== 'function') return await query;
    const result = await query.range(offset, offset + pageSize - 1);
    if (result.error) return { data: null, error: result.error };
    const page = result.data ?? [];
    rows.push(...page);
    if (page.length < pageSize) return { data: rows, error: null };
  }
}
