import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/integrations/supabase/types';

import { fromTable } from './supabaseQuery';

type DB = SupabaseClient<Database>;
const q = fromTable;

export type ChannelType = 'slack' | 'email' | 'line' | 'webhook';
export type ReportSendFormat = 'text' | 'full' | 'pdf';
export type SendStatus = 'pending' | 'sending' | 'sent' | 'failed' | 'skipped';

export interface SlackChannelConfig { channel_id: string; channel_name: string }
export interface EmailChannelConfig { recipients: string[] }
// TODO [SECURITY]: LineChannelConfig.notify_token and WebhookChannelConfig headers are stored as
// plain JSONB in the report_send_targets table. Sensitive credentials (tokens, API keys) should be
// stored in a secrets manager (e.g. Supabase Vault) or injected via environment variables, never
// persisted in plain text in the database.
export interface LineChannelConfig { notify_token: string }
export interface WebhookChannelConfig { url: string; method: string; headers?: Record<string, string> }
export type ChannelConfig = SlackChannelConfig | EmailChannelConfig | LineChannelConfig | WebhookChannelConfig;

export interface ReportSendTarget {
  id: string;
  project_id: string | null;
  report_type: 'daily' | 'weekly' | 'monthly';
  channel_type: ChannelType;
  channel_config: ChannelConfig;
  format: ReportSendFormat;
  is_enabled: boolean;
  created_by: string;
  created_at: string;
  updated_at: string;
}

export interface ReportSendLog {
  id: string;
  report_type: string;
  target_id: string | null;
  channel_type: ChannelType;
  channel_target: string;
  format: ReportSendFormat;
  content_preview: string | null;
  status: SendStatus;
  error_message: string | null;
  retry_count: number;
  sent_by: string;
  sent_at: string;
  completed_at: string | null;
}

export const targetQueries = {
  fetchAll: (db: DB) =>
    q(db, 'report_send_targets').select('*').order('created_at'),

  fetchByProject: (db: DB, projectId: string) =>
    q(db, 'report_send_targets').select('*').eq('project_id', projectId).order('created_at'),

  fetchGlobal: (db: DB) =>
    q(db, 'report_send_targets').select('*').is('project_id', null).order('created_at'),

  fetchByReportType: (db: DB, reportType: string) =>
    q(db, 'report_send_targets').select('*').eq('report_type', reportType).order('created_at'),

  /** Fetch targets for a specific project (including global project_id=null) filtered by report type */
  fetchByProjectAndType: (db: DB, projectId: string, reportType: string) =>
    q(db, 'report_send_targets')
      .select('*')
      .or(`project_id.eq.${projectId},project_id.is.null`)
      .eq('report_type', reportType)
      .order('created_at'),

  create: (db: DB, data: Omit<ReportSendTarget, 'id' | 'created_at' | 'updated_at'>) =>
    q(db, 'report_send_targets').insert(data).select().single(),

  update: (db: DB, id: string, data: Partial<ReportSendTarget>) =>
    q(db, 'report_send_targets')
      .update({ ...data, updated_at: new Date().toISOString() })
      .eq('id', id).select().single(),

  delete: (db: DB, id: string) =>
    q(db, 'report_send_targets').delete().eq('id', id),

  toggle: (db: DB, id: string, enabled: boolean) =>
    q(db, 'report_send_targets')
      .update({ is_enabled: enabled, updated_at: new Date().toISOString() })
      .eq('id', id).select().single(),
};

export const logQueries = {
  create: (db: DB, data: Omit<ReportSendLog, 'id' | 'sent_at'>) =>
    q(db, 'report_send_logs').insert(data).select().single(),

  updateStatus: (db: DB, id: string, status: SendStatus, errorMessage?: string) =>
    q(db, 'report_send_logs')
      .update({
        status,
        error_message: errorMessage ?? null,
        completed_at: status === 'sent' || status === 'failed' ? new Date().toISOString() : null,
      })
      .eq('id', id).select().single(),

  fetchRecent: (db: DB, limit = 50) =>
    q(db, 'report_send_logs')
      .select('*').order('sent_at', { ascending: false }).limit(limit),

  fetchByReport: (db: DB, reportType: string, limit = 20) =>
    q(db, 'report_send_logs')
      .select('*').eq('report_type', reportType)
      .order('sent_at', { ascending: false }).limit(limit),
};