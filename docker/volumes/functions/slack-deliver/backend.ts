import { Database, type Environment } from '../slack-interact/backend.ts';
import { type DeliveryStore, type Job, type Row, deliverJob } from './core.ts';

export function deliveryStore(env: Environment): DeliveryStore {
  const db = new Database(env);
  return {
    config: () => db.setting('slack_delivery'),
    claim: async owner => (await db.request('/rest/v1/rpc/livo_slack_claim_delivery', 'POST', { p_owner: owner }))[0],
    finish: (job, owner, result) => db.request('/rest/v1/rpc/livo_slack_finish_delivery', 'POST', {
      p_id: job.id, p_owner: owner, p_status: result.status, p_channel: result.channel || null,
      p_message_ts: result.messageTs || null, p_thread_ts: result.threadTs || null,
      p_error: result.error || null, p_delay_seconds: Math.ceil(result.delay || 0),
    }),
    token: async () => (await db.rows('slack_config', { select: 'bot_token', id: 'eq.singleton', limit: '1' }))[0]?.bot_token || env.get('SLACK_BOT_TOKEN'),
    project: async taskId => {
      const task = (await db.rows('tasks', { select: 'project_id', id: `eq.${taskId}`, limit: '1' }))[0];
      return task && (await db.rows('projects', { select: 'id,line_id,is_archived', id: `eq.${task.project_id}`, limit: '1' }))[0];
    },
    binding: async (memberId, teamId) => {
      const member = (await db.rows('members', { select: 'id', id: `eq.${memberId}`, is_active: 'eq.true', limit: '1' }))[0];
      if (!member) return undefined;
      const bindings = await db.rows('external_account_bindings', { select: 'platform_user_id', member_id: `eq.${memberId}`,
        platform: 'eq.slack', platform_team_id: `eq.${teamId}`, is_verified: 'eq.true', verified_by: 'in.(email,admin)', limit: '2' });
      return bindings.length === 1 && /^U[A-Z0-9]+$/.test(bindings[0].platform_user_id) ? bindings[0].platform_user_id : undefined;
    },
    thread: async (taskId, teamId, channelId) => (await db.rows('slack_thread_mappings', { select: 'slack_thread_ts',
      task_id: `eq.${taskId}`, slack_team_id: `eq.${teamId}`, slack_channel_id: `eq.${channelId}`, order: 'created_at.desc,slack_thread_ts.desc', limit: '1' }))[0]?.slack_thread_ts,
    currentTask: async taskId => (await db.rows('tasks', { select: 'id,assignee_id,reviewer_id,status_id,due_date,completed_at,statuses(is_done)', id: `eq.${taskId}`, limit: '1' }))[0],
    queueWeekly: () => db.request('/rest/v1/rpc/livo_slack_queue_weekly', 'POST', {}),
    weeklyTasks: (memberId, weekStart) => db.request('/rest/v1/rpc/livo_slack_weekly_tasks', 'POST', { p_member: memberId, p_week: weekStart }),
    canSend: (job, owner) => db.request('/rest/v1/rpc/livo_slack_delivery_lease_valid', 'POST', { p_id: job.id, p_owner: owner }),
  };
}
export async function drainDeliveries(env: Environment, store = deliveryStore(env), fetcher: typeof fetch = fetch) {
  if ((await store.config())?.enabled !== true) return { enabled: false, processed: 0 };
  await store.queueWeekly();
  const owner = crypto.randomUUID(), until = Date.now() + 35000;
  const counts: Row = { enabled: true, processed: 0, sent: 0, pending: 0, failed: 0, review: 0, skipped: 0 };
  for (let i = 0; i < 10 && Date.now() < until; i++) {
    const job: Job | undefined = await store.claim(owner);
    if (!job) break;
    const status = await deliverJob(job, owner, store, env.get('APP_BASE_URL') || '', fetcher);
    counts.processed++; counts[status]++;
  }
  return counts;
}
