import { supabase } from '@/integrations/supabase/client';

/**
 * A member's own Slack link. On the self-hosted server LIVO keeps a verified
 * binding per Slack account ('binding'); the cloud matches the Slack account by
 * email every time ('email'). Either way the member can turn linking off: LIVO
 * then neither acts for that Slack account nor sends it direct messages.
 * Server side: livo_slack_link_status / livo_slack_link_set
 * (supabase/migrations/20261022_slack_link_preferences.sql, worker/src/slackLink.ts).
 */
export interface SlackLinkStatus {
  disabled: boolean;
  mode: 'binding' | 'email';
  linked: { displayName: string | null; verifiedBy: 'email' | 'admin' | null; boundAt: string | null } | null;
}


// These functions are not in the generated database types; both backends expose them under these names.
type Rpc = (fn: string, args?: Record<string, unknown>) => PromiseLike<{ data: unknown; error: { message?: string } | null }>;

export class SlackLinkError extends Error {}

function parse(value: unknown): SlackLinkStatus {
  if (!value || typeof value !== 'object') throw new SlackLinkError('slack_link_unavailable');
  const row = value as Record<string, unknown>;
  if (typeof row.disabled !== 'boolean' || (row.mode !== 'binding' && row.mode !== 'email')) throw new SlackLinkError('slack_link_unavailable');
  const linked = row.linked && typeof row.linked === 'object' ? row.linked as Record<string, unknown> : null;
  return {
    disabled: row.disabled, mode: row.mode,
    linked: linked ? {
      displayName: typeof linked.display_name === 'string' ? linked.display_name : null,
      verifiedBy: linked.verified_by === 'email' || linked.verified_by === 'admin' ? linked.verified_by : null,
      boundAt: typeof linked.bound_at === 'string' ? linked.bound_at : null,
    } : null,
  };
}

async function call(fn: string, args?: Record<string, unknown>): Promise<SlackLinkStatus> {
  const { data, error } = await (supabase.rpc.bind(supabase) as unknown as Rpc)(fn, args);
  if (error) throw new SlackLinkError(error.message || 'slack_link_unavailable');
  return parse(data);
}

export const loadSlackLink = () => call('livo_slack_link_status');
export const setSlackLinkEnabled = (enabled: boolean) => call('livo_slack_link_set', { p_enabled: enabled });
