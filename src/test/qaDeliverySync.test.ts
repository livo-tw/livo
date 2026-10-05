// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import { syncQaSlackIssue } from '../../docker/volumes/functions/qa/slackSync';
import { type QaIssue } from '../lib/qa/domain';
import { type Row } from '../../docker/volumes/functions/slack-deliver/core';
const issue = { id: 'issue', projectId: 'project', title: 'Example Bug', state: 'triaged', version: 2, targets: [], runs: [],
  assigneeId: 'member', qaOwnerId: 'qa', priority: 2, severity: 'high', fixCycle: 1, dueDate: '2026-10-10' } as QaIssue;
const config = { enabled: true, teamId: 'TEXAMPLE', qaRoutes: [{ projectId: 'project', channelId: 'CBUG' }] };
const values: Record<string, string> = { SUPABASE_URL: 'https://db.example.com', SUPABASE_SERVICE_ROLE_KEY: 'example-service', SUPABASE_ANON_KEY: 'example-anon', APP_BASE_URL: 'https://example.com', SLACK_BOT_TOKEN: 'example-token' };
function setup(routed = true) {
  const updates: Row[] = [];
  vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    if (url.hostname === 'slack.com') {
      if (url.pathname.endsWith('/auth.test')) return Response.json({ ok: true, team_id: 'TEXAMPLE' });
      updates.push(JSON.parse(String(init?.body))); return Response.json({ ok: true });
    }
    const table = url.pathname.split('/').at(-1);
    if (table === 'system_settings') {
      const key = url.searchParams.get('key');
      return Response.json([{ value: key === 'eq.feature_toggles' ? { qa: true, slackActions: true } : key === 'eq.slack_delivery' ? { ...config, qaRoutes: routed ? config.qaRoutes : [] } : undefined }]);
    }
    if (table === 'slack_config') return Response.json([{ bot_token: 'example-token' }]);
    if (table === 'qa_issues') return Response.json([{ data: issue }]);
    if (table === 'projects') return Response.json([{ id: 'project', name: 'Example project', is_archived: false }]);
    if (table === 'members') return Response.json([{ id: 'member', name: 'Example member' }, { id: 'qa', name: 'Example QA' }]);
    if (table === 'qa_project_coordination') return Response.json([]);
    if (table === 'qa_slack_links') return Response.json([{ id: 'delivery-qa:example', issue_id: 'issue', team_id: 'TEXAMPLE', channel_id: 'CBUG', thread_ts: '1791158400.000001', card_ts: '1791158400.000001' }]);
    if (table === 'slack_delivery_outbox') return Response.json([{ id: 1, team_id: 'TEXAMPLE', task_id: 'qa:issue', target_type: 'channel', target_id: 'CBUG', attempts: 1,
      payload: { issueId: 'issue', eventType: 'created', actorId: 'member' } }]);
    throw new Error('unexpected request');
  }));
  return updates;
}
afterEach(() => vi.unstubAllGlobals());
describe('refreshing automatically delivered QA cards', () => {
  it('retains project, responsibility, priority and deadline fields after a Bug update', async () => {
    const updates = setup(); await syncQaSlackIssue({ get: key => values[key] }, issue);
    expect(updates).toHaveLength(1);
    expect(updates[0].text).toContain('Example project'); expect(updates[0].text).toContain('Example member');
    expect(updates[0].text).toContain('P2'); expect(updates[0].text).toContain('2026-10-10');
  });
  it('does not refresh a delivery card after its subscribed channel is removed', async () => {
    const updates = setup(false); await syncQaSlackIssue({ get: key => values[key] }, issue); expect(updates).toHaveLength(0);
  });
});
