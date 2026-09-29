import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/integrations/supabase/types';
import { fromTable } from './supabaseQuery';

type DB = SupabaseClient<Database>;
const q = fromTable;

export type Platform = 'slack' | 'teams' | 'line';

export type ActionType =
  | 'approval_approve' | 'approval_reject' | 'approval_return'
  | 'status_change' | 'comment_add' | 'task_view' | 'task_assign'
  | 'slash_command';

export type ResultStatus = 'success' | 'failed' | 'denied' | 'expired';

export interface ExternalAccountBinding {
  id: string;
  member_id: string;
  platform: Platform;
  platform_user_id: string;
  platform_team_id: string | null;
  display_name: string | null;
  is_verified: boolean;
  bound_at: string;
  last_active_at: string | null;
}

export interface ExternalActionLog {
  id: string;
  member_id: string;
  binding_id: string | null;
  platform: Platform;
  action_type: ActionType;
  target_task_id: string | null;
  action_payload: Record<string, unknown> | null;
  result_status: ResultStatus;
  error_message: string | null;
  platform_message_id: string | null;
  acted_at: string;
}

export interface SlackThreadMapping {
  id: string;
  slack_channel_id: string;
  slack_thread_ts: string;
  task_id: string;
  notification_type: string | null;
  created_at: string;
}

export interface InteractionToken {
  id: string;
  token_hash: string;
  action_type: string;
  target_id: string;
  platform: Platform;
  expires_at: string;
  is_used: boolean;
  used_at: string | null;
  created_at: string;
}

export const bindingQueries = {
  fetchByMember: (db: DB, memberId: string) =>
    q(db, 'external_account_bindings')
      .select('*')
      .eq('member_id', memberId)
      .order('bound_at', { ascending: false }),

  fetchByPlatformUser: (db: DB, platform: Platform, platformUserId: string, platformTeamId?: string) => {
    let query = q(db, 'external_account_bindings')
      .select('*')
      .eq('platform', platform)
      .eq('platform_user_id', platformUserId);
    if (platformTeamId) query = query.eq('platform_team_id', platformTeamId);
    return query.maybeSingle();
  },

  create: (
    db: DB,
    data: Omit<ExternalAccountBinding, 'id' | 'bound_at' | 'last_active_at'>,
  ) => q(db, 'external_account_bindings').insert(data).select().single(),

  delete: (db: DB, id: string) =>
    q(db, 'external_account_bindings').delete().eq('id', id),

  updateLastActive: (db: DB, id: string) =>
    q(db, 'external_account_bindings')
      .update({ last_active_at: new Date().toISOString() })
      .eq('id', id),
};

export const actionLogQueries = {
  create: (db: DB, data: Omit<ExternalActionLog, 'id' | 'acted_at'>) =>
    q(db, 'external_action_logs').insert(data).select().single(),

  fetchByMember: (db: DB, memberId: string, limit = 50) =>
    q(db, 'external_action_logs')
      .select('*')
      .eq('member_id', memberId)
      .order('acted_at', { ascending: false })
      .limit(limit),

  fetchByTask: (db: DB, taskId: string) =>
    q(db, 'external_action_logs')
      .select('*')
      .eq('target_task_id', taskId)
      .order('acted_at', { ascending: false }),

  fetchRecent: (db: DB, limit = 100) =>
    q(db, 'external_action_logs')
      .select('*')
      .order('acted_at', { ascending: false })
      .limit(limit),
};

export const threadMappingQueries = {
  create: (db: DB, data: Omit<SlackThreadMapping, 'id' | 'created_at'>) =>
    q(db, 'slack_thread_mappings').insert(data).select().single(),

  fetchByThread: (db: DB, channelId: string, threadTs: string) =>
    q(db, 'slack_thread_mappings')
      .select('*')
      .eq('slack_channel_id', channelId)
      .eq('slack_thread_ts', threadTs)
      .maybeSingle(),

  fetchByTask: (db: DB, taskId: string) =>
    q(db, 'slack_thread_mappings')
      .select('*')
      .eq('task_id', taskId)
      .order('created_at', { ascending: false }),
};

export const tokenQueries = {
  create: (db: DB, data: Omit<InteractionToken, 'id' | 'is_used' | 'used_at' | 'created_at'>) =>
    q(db, 'interaction_tokens').insert(data).select().single(),

  validateAndConsume: async (db: DB, tokenHash: string): Promise<InteractionToken | null> => {
    // Atomic update: only matches tokens that are unused and not expired.
    // If another request already consumed the token, the update matches nothing and data is null.
    const { data } = await q(db, 'interaction_tokens')
      .update({ is_used: true, used_at: new Date().toISOString() })
      .eq('token_hash', tokenHash)
      .eq('is_used', false)
      .gt('expires_at', new Date().toISOString())
      .select()
      .maybeSingle();
    return (data as InteractionToken) ?? null;
  },

  cleanup: (db: DB) =>
    q(db, 'interaction_tokens')
      .delete()
      .lt('expires_at', new Date().toISOString()),
};
