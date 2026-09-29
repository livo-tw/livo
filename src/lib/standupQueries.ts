import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/integrations/supabase/types';

import { fromTable } from './supabaseQuery';

type DB = SupabaseClient<Database>;
const q = fromTable;

export interface StandupSessionRow {
  id: string;
  created_by: string;
  started_at: string;
  ended_at: string | null;
  sprint_id: string | null;
  default_speak_duration: number;
  sort_mode: 'by_member' | 'by_project' | 'by_due_date' | 'by_department';
  auto_advance: boolean;
  buffer_seconds: number;
  created_at: string;
}

export interface MemberDurationRow {
  id: string;
  standup_session_id: string;
  member_id: string;
  speak_duration: number;
  created_at: string;
}

export const sessionQueries = {
  create: (db: DB, data: Omit<StandupSessionRow, 'id' | 'created_at'>) =>
    q(db, 'standup_sessions').insert(data).select().single(),

  update: (db: DB, id: string, data: Partial<Omit<StandupSessionRow, 'id' | 'created_at'>>) =>
    q(db, 'standup_sessions').update(data).eq('id', id).select().single(),

  fetchById: (db: DB, id: string) =>
    q(db, 'standup_sessions').select('*').eq('id', id).single(),

  fetchActive: (db: DB) =>
    q(db, 'standup_sessions')
      .select('*')
      .is('ended_at', null)
      .order('started_at', { ascending: false })
      .limit(1)
      .maybeSingle(),
};

export const memberDurationQueries = {
  fetchBySession: (db: DB, sessionId: string) =>
    q(db, 'standup_member_durations')
      .select('*')
      .eq('standup_session_id', sessionId),

  upsert: (db: DB, data: Omit<MemberDurationRow, 'id' | 'created_at'>) =>
    q(db, 'standup_member_durations')
      .upsert(data, { onConflict: 'standup_session_id,member_id' })
      .select()
      .single(),

  delete: (db: DB, sessionId: string, memberId: string) =>
    q(db, 'standup_member_durations')
      .delete()
      .eq('standup_session_id', sessionId)
      .eq('member_id', memberId),
};
