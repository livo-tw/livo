import type { SupabaseClient } from '@supabase/supabase-js';
import { supabase } from './client';
import type { KnowledgeTables, FieldLockFunctions } from '@/types/knowledge';

/** Typed view of the SAME singleton (auth, mock routing and storage included).
 * Keep the new schema independent of the older generated, partial DB types.
 */
type KnowledgeDatabase = {
  __InternalSupabase: { PostgrestVersion: '14.4' };
  public: { Tables: KnowledgeTables; Functions: FieldLockFunctions; Views: {}; Enums: {}; CompositeTypes: {} };
};
export const knowledgeClient = supabase as unknown as SupabaseClient<KnowledgeDatabase>;
