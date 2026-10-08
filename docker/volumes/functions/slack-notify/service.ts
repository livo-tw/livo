// slack-notify (self-hosted): task-event and report notices for the web app and
// slack-interact. Calls the Slack Web API directly with the bot token from the
// server-only slack_config table (or SLACK_BOT_TOKEN). Mirrors the cloud
// worker's handleSlackNotify; the formatting and recipient rules are shared in
// ./core.ts (src/lib/slackNotifyCore.ts).
//
// Any active member may call this, so the request only names an event: the
// task, project, actor and DM recipients are read from the database as the
// caller sees them, every message is built here, and errors stay generic.
import { shouldPostChannel } from '../slack-interact/core.ts';
import { constantTimeSecret, Database, type Environment } from '../slack-interact/backend.ts';
import { commentMentionIds, commentPlainText, dmRecipients, notifyChannelId, notifyDetails, NOTIFY_TASK_TYPES, reportMessage,
  requestedEmails, memberEmailIdentityVerified, slackDmEligible, slackErrorCode, taskChannelMessage, taskDmMessage, type DmReason, type NotifyFields } from './core.ts';

type Row = Record<string, any>;
const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version',
};
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
const ID = /^[\w-]{1,200}$/;
const COMMENT_WINDOW_MS = 15 * 60 * 1000;

function slackApi(token: string, fetcher: typeof fetch) {
  return async (method: string, args: Row): Promise<Row> => {
    const read = ['conversations.list', 'users.lookupByEmail'].includes(method);
    const res = await fetcher(`https://slack.com/api/${method}${read ? '?' + new URLSearchParams(args) : ''}`, { method: read ? 'GET' : 'POST',
      headers: { Authorization: `Bearer ${token}`, ...(read ? {} : { 'Content-Type': 'application/json; charset=utf-8' }) },
      ...(read ? {} : { body: JSON.stringify(args) }), signal: AbortSignal.timeout(12000) });
    return await res.json().catch(() => ({ ok: false }));
  };
}
async function channelId(slack: (method: string, args: Row) => Promise<Row>, setting: unknown): Promise<string | undefined> {
  if (typeof setting !== 'string' || !setting.trim()) return undefined;
  const channels: Row[] = [];
  let cursor = '';
  for (let page = 0; page < 5 && !/^[CG][A-Z0-9]{2,}$/.test(setting.trim()); page++) {
    const list = await slack('conversations.list', { limit: '200', exclude_archived: 'true', types: 'public_channel,private_channel', ...(cursor ? { cursor } : {}) });
    if (!list.ok || !Array.isArray(list.channels)) break;
    channels.push(...list.channels);
    if (notifyChannelId(channels, setting)) break;
    cursor = String(list.response_metadata?.next_cursor || '');
    if (!cursor) break;
  }
  return notifyChannelId(channels, setting);
}

export async function handleSlackNotify(req: Request, env: Environment, fetcher: typeof fetch = fetch): Promise<Response> {
  if (req.method === 'OPTIONS') return new Response(null, { headers: corsHeaders });
  if (req.method !== 'POST') return new Response(null, { status: 405 });
  try {
    const admin = new Database(env);
    const jwt = (req.headers.get('authorization') || '').replace(/^Bearer\s+/i, '');
    // slack-interact calls with the service key after it resolved the actor itself.
    const service = await constantTimeSecret(jwt, env.get('SUPABASE_SERVICE_ROLE_KEY') || '');
    let caller: Row | undefined;
    if (!service) {
      const user = jwt ? await new Database(env, jwt).request('/auth/v1/user').catch((): null => null) : null;
      const members = typeof user?.id === 'string' ? await admin.rows('members', { select: 'id,name,role,is_active',
        auth_id: `eq.${user.id}`, is_active: 'eq.true', limit: '2' }) : [];
      if (members.length !== 1) return json({ error: 'unauthorized' }, 401);
      caller = members[0];
    }
    const raw = await req.text();
    if (raw.length > 65536) return json({ error: 'payload_too_large' }, 413);
    const parsed = JSON.parse(raw || '{}');
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return json({ error: 'invalid_request' }, 400);
    const payload = parsed as Row, type = String(payload.type || '');
    // Approval notices are produced by the committed command's durable outbox.
    // A client cannot fabricate a notice or repeat a successful decision.
    if (type.startsWith('approval_') || String(payload.eventType || '').startsWith('approval_')) return json({ error: 'approval_command_required' }, 409);

    const delivery = await admin.setting('slack_delivery');
    const token = (await admin.rows('slack_config', { select: 'bot_token', id: 'eq.singleton', limit: '1' }).catch((): Row[] => []))[0]?.bot_token
      || env.get('SLACK_BOT_TOKEN');
    if (!token) return json({ error: 'slack_not_configured' });
    // The database trigger already committed the durable event. Old UI and Slack
    // callers must not post it a second time or supply a different recipient.
    if (delivery?.enabled === true && NOTIFY_TASK_TYPES.includes(type)) return json({ accepted: true, managedBy: 'database' });
    const slack = slackApi(token, fetcher);
    const settings: Row = (await admin.rows('backup_settings', { select: 'task_notify_channel,notify_channel,task_notify_types,dm_notify_enabled,dm_notify_start_hour,dm_notify_end_hour', limit: '1' }))[0] || {};
    const taskNotifyChannel = settings.task_notify_channel || settings.notify_channel || '';

    if (type === 'report') {
      const target = typeof payload.channelTarget === 'string' && payload.channelTarget.trim() ? payload.channelTarget : taskNotifyChannel;
      if (!target) return json({ error: 'no_channel_configured' });
      const channel = await channelId(slack, target);
      if (!channel) return json({ error: 'channel_not_found' }, 400);
      if (delivery?.enabled === true && !(Array.isArray(delivery.routes) && delivery.routes.some((r: Row) => r.enabled !== false && r.channelId === channel)))
        return json({ error: 'channel_not_allowed' }, 403);
      const sender = service ? (typeof payload.actorName === 'string' ? payload.actorName : 'LIVO') : caller!.name;
      const res = await slack('chat.postMessage', { channel, ...reportMessage(payload.reportTitle, payload.reportContent, sender),
        unfurl_links: false, unfurl_media: false, username: 'LIVO' });
      if (!res.ok) return json({ error: slackErrorCode(res.error) });
      return json({ success: true });
    }
    if (!NOTIFY_TASK_TYPES.includes(type)) return json({ error: 'unknown_notify_type' }, 400);

    // The task as the caller can see it (member RLS); the request only names it.
    const reader = service ? admin : new Database(env, jwt);
    const taskId = payload.taskId;
    const task = typeof taskId === 'string' && ID.test(taskId) ? (await reader.rows('tasks', {
      select: 'id,task_key,title,priority,project_id,status_id,assignee_id,reviewer_id', id: `eq.${taskId}`, limit: '1' }))[0] : undefined;
    if (!task) return json({ error: 'task_unavailable' }, 404);
    const one = async (table: string, id: unknown, select = 'id,name') => typeof id === 'string' && ID.test(id)
      ? (await reader.rows(table, { select, id: `eq.${id}`, limit: '1' }))[0] : undefined;
    const [project, status, assignee] = await Promise.all([one('projects', task.project_id), one('statuses', task.status_id), one('members', task.assignee_id)]);
    const details = notifyDetails(payload);
    let actorId: string, actorName: string, mentioned: string[], preview = details.commentPreview;
    if (service) {
      actorId = typeof payload.actorId === 'string' ? payload.actorId : '';
      actorName = typeof payload.actorName === 'string' ? payload.actorName : '';
      mentioned = Array.isArray(payload.mentionedIds) ? payload.mentionedIds.filter((id: unknown): id is string => typeof id === 'string' && ID.test(id)).slice(0, 40) : [];
    } else {
      actorId = caller!.id; actorName = caller!.name; mentioned = [];
      if (type === 'comment_added') {
        // Mentions and the preview come from the caller's own new comment.
        const comment = (await reader.rows('comments', { select: 'content,created_at', task_id: `eq.${task.id}`, user_id: `eq.${caller!.id}`,
          order: 'created_at.desc', limit: '1' }))[0];
        if (!comment || !(Date.now() - Date.parse(comment.created_at) < COMMENT_WINDOW_MS)) return json({ error: 'comment_unavailable' }, 404);
        mentioned = commentMentionIds(comment.content);
        preview = commentPlainText(comment.content);
      }
    }
    const fields: NotifyFields = { ...details, type, taskKey: task.task_key, taskTitle: task.title, projectName: project?.name || '',
      actorName, priority: task.priority || 'medium', commentPreview: preview,
      assigneeName: assignee?.name || details.assigneeName, statusName: status?.name || details.statusName };
    const base = (env.get('APP_BASE_URL') || 'https://livo-tw.com').replace(/\/$/, '');
    const url = `${base}/?task=${encodeURIComponent(task.task_key)}`;

    if (taskNotifyChannel && (Array.isArray(settings.task_notify_types) ? settings.task_notify_types
      : ['task_created', 'status_changed', 'assignee_changed', 'comment_added']).includes(type)) {
      const channel = await channelId(slack, taskNotifyChannel);
      if (channel && shouldPostChannel(channel, payload.sourceChannelId)) {
        const res = await slack('chat.postMessage', { channel, ...taskChannelMessage(fields, url), unfurl_links: false, unfurl_media: false, username: 'LIVO' });
        if (!res.ok) return json({ error: slackErrorCode(res.error) }, 502);
      }
    }

    const allowed = dmRecipients(type, task, actorId, mentioned), requested = requestedEmails(payload.dmTargets);
    if (allowed.size && requested.size) {
      const dmEnabled = settings.dm_notify_enabled ?? true;
      const startHour = settings.dm_notify_start_hour ?? 0, endHour = settings.dm_notify_end_hour ?? 24;
      const hour = new Date(Date.now() + 8 * 60 * 60 * 1000).getUTCHours();
      const inWindow = startHour <= endHour ? hour >= startHour && hour < endHour : hour >= startHour || hour < endHour;
      if (dmEnabled && inWindow) {
        const members = await admin.rows('members', { select: 'id,email,email_identity_verified', is_active: 'eq.true', id: `in.(${[...allowed.keys()].join(',')})` });
        // Members who unlinked Slack in My settings get no direct messages.
        const unlinked = new Set((await admin.rows('slack_link_preferences', { select: 'member_id', linking_disabled: 'eq.true',
          member_id: `in.(${[...allowed.keys()].join(',')})` })).map(row => row.member_id));
        const targets = members.filter(m => memberEmailIdentityVerified(m) && !unlinked.has(m.id) && typeof m.email === 'string' && requested.has(m.email.trim().toLowerCase()));
        const results = await Promise.allSettled(targets.map(async m => {
          const found = await slack('users.lookupByEmail', { email: m.email.trim() });
          // No Slack account, or a guest/bot/deactivated one: skipped on purpose, not a failure.
          if (!found.ok) return found.error === 'users_not_found';
          if (!slackDmEligible(found.user, m.email)) return true;
          const dm = await slack('conversations.open', { users: found.user.id });
          if (!dm.ok || !dm.channel?.id) return false;
          const sent = await slack('chat.postMessage', { channel: dm.channel.id, ...taskDmMessage(fields, allowed.get(m.id) as DmReason, url),
            unfurl_links: false, unfurl_media: false, username: 'LIVO' });
          return sent.ok === true;
        }));
        if (results.some(r => r.status === 'rejected' || r.value !== true)) return json({ error: 'dm_delivery_failed' }, 502);
      }
    }
    return json({ success: true });
  } catch {
    console.error('[slack] notify failed');
    return json({ error: 'notify_failed' }, 500);
  }
}
