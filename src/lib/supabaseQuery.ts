/**
 * Type-safe Supabase query helper for tables not yet in the generated types.
 *
 * Replaces the `(supabase as any).from(table)` pattern. The cast is centralized
 * here so query files stay clean and greppable if we regenerate types later.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/integrations/supabase/types';

type DB = SupabaseClient<Database>;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const fromTable = (db: DB, table: string) => (db as any).from(table);
