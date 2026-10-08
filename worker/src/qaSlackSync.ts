import { appBaseUrl, type Env } from './env';
import { resolveSlackToken } from './functions/slack';
import { qaSlackCard } from './qa/slack';
import type { QaIssue } from './qa/domain';
import { parseQaWorkflow } from './qa/workflow';
import { parseQaDisplaySettings } from './qa/displaySettings';
import { slackErrorCode } from './slackNotifyCore';

export const qaSlackLink = (env: Env, issue: QaIssue) => `${appBaseUrl(env).replace(/\/$/, '')}/demo/?qa=${encodeURIComponent(issue.id)}`;
export async function getQaSlackWorkflow(env: Env, ws: string) {
  const row=await env.DB.prepare("SELECT value FROM system_settings WHERE workspace_id=? AND key='qa_workflow'").bind(ws).first<{value:string}>();
  return parseQaWorkflow(row?.value);
}
export async function getQaSlackDisplaySettings(env: Env, ws: string) {
  const row=await env.DB.prepare("SELECT value FROM system_settings WHERE workspace_id=? AND key='qa_display_settings'").bind(ws).first<{value:string}>();
  return parseQaDisplaySettings(row?.value);
}
export async function qaSlackEnabled(env: Env, ws: string): Promise<boolean> {
  const row = await env.DB.prepare("SELECT value FROM system_settings WHERE workspace_id=? AND key='feature_toggles'").bind(ws).first<{value:string}>();
  try { const flags = JSON.parse(row?.value || '{}'); return flags.qa === true && flags.slackActions === true; } catch { return false; }
}
export function qaSlackClient(env: Env, ws: string) {
  let token: Promise<string | undefined>;
  return async (method: string, body: Record<string, unknown>): Promise<Record<string, any>> => {
    token ??= resolveSlackToken(env, ws);
    if (!(await token)) throw new Error('qa_slack_not_configured');
    const read = ['users.info', 'chat.getPermalink'].includes(method);
    const query = new URLSearchParams(Object.entries(body).map(([k, v]) => [k, String(v)]));
    const response = await fetch(`https://slack.com/api/${method}${read ? '?' + query : ''}`, { method: read ? 'GET' : 'POST',
      headers: { Authorization: `Bearer ${await token}`, 'Content-Type': 'application/json; charset=utf-8' },
      ...(read ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(10000) });
    const result = await response.json().catch(() => ({})) as Record<string, any>;
    if (!response.ok || !result.ok) {
      // Same server log line as the Docker slack-interact client: the method and
      // Slack's error code, never the token or message content.
      console.error(`slack_api_error method=${method.replace(/[^\w.]/g, '').slice(0, 60)} error=${slackErrorCode(result.error)}`);
      throw new Error('qa_slack_unavailable');
    }
    return result;
  };
}
export async function syncQaSlackIssue(env: Env, ws: string, issue: QaIssue): Promise<void> {
  if (!await qaSlackEnabled(env, ws)) return;
  const links = await env.DB.prepare('SELECT team_id,channel_id,card_ts FROM qa_slack_links WHERE workspace_id=? AND issue_id=? LIMIT 100').bind(ws, issue.id).all<{team_id:string;channel_id:string;card_ts:string}>();
  if (!links.results.length) return;
  const slack = qaSlackClient(env, ws), auth = await slack('auth.test', {});
  const cards=links.results.filter(link => link.team_id === auth.team_id && link.card_ts);
  // A slower revision can finish after a newer chat.update. Re-read after delivery
  // and repair that stale write; bounded so a very busy issue cannot hold a Worker forever.
  for(let attempt=0;attempt<3;attempt++){
    if(!await qaSlackEnabled(env,ws))return;
    const row=await env.DB.prepare('SELECT data FROM qa_issues WHERE workspace_id=? AND id=?').bind(ws,issue.id).first<{data:string}>();
    if(!row)return;const current=JSON.parse(row.data) as QaIssue;
    const workflow=await getQaSlackWorkflow(env,ws), display=await getQaSlackDisplaySettings(env,ws);
    await Promise.all(cards.map(link=>slack('chat.update',{channel:link.channel_id,ts:link.card_ts,text:`Bug · ${current.title}`,blocks:qaSlackCard(current,qaSlackLink(env,current),workflow,display)})));
    const latest=await env.DB.prepare('SELECT version FROM qa_issues WHERE workspace_id=? AND id=?').bind(ws,issue.id).first<{version:number}>();
    if(!latest||latest.version===current.version)return;
  }
  console.error('qa_slack_card_changed_during_sync');
}
