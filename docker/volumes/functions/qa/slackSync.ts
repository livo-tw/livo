import { Database, slackClient, type Environment } from '../slack-interact/backend.ts';
import { qaSlackCard } from './slack.ts';
import type { QaIssue } from './domain.ts';
import { parseQaWorkflow } from './workflow.ts';

export const qaSlackLink = (env: Environment, issue: QaIssue) => `${(env.get('APP_BASE_URL') || '').replace(/\/$/, '')}/?qa=${encodeURIComponent(issue.id)}`;
/** Re-read after writing and repair stale completions with bounded retries.
 * Slack has no compare-and-swap API; concurrent writers converge on the newest
 * aggregate instead of treating the caller's snapshot as the current version. */
export async function syncQaSlackIssue(env: Environment, issue: QaIssue): Promise<void> {
  const db = new Database(env), flags = await db.setting('feature_toggles');
  if (flags?.qa !== true || flags?.slackActions !== true) return;
  const load = async () => (await db.rows('qa_issues', { id: `eq.${issue.id}`, workspace_id: 'eq.default', select: 'data', limit: '1' }))[0]?.data as QaIssue | undefined;
  if (!(await load())) return;
  const links = await db.rows('qa_slack_links', { issue_id: `eq.${issue.id}`, workspace_id: 'eq.default', select: '*', limit: '100' });
  if (!links.length) return;
  const slack = slackClient(env, db), auth = await slack('auth.test', {});
  await Promise.all(links.filter(link => link.team_id === auth.team_id && link.card_ts).map(async link => {
    for (let attempt = 0; attempt < 3; attempt++) {
      const current = await load();
      if (!current) return;
      const workflow = parseQaWorkflow(await db.setting('qa_workflow'));
      await slack('chat.update', { channel: link.channel_id, ts: link.card_ts, text: `Bug · ${current.title}`, blocks: qaSlackCard(current, qaSlackLink(env, current), workflow) });
      const latest = await load();
      if (!latest || latest.version === current.version) return;
    }
    throw new Error('QA Slack card changed during refresh; retry required');
  }));
}
