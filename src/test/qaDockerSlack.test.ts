// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createQaIssue } from '../lib/qa/domain';
import { syncQaSlackIssue } from '../../docker/volumes/functions/qa/slackSync';
import fs from 'node:fs';
import path from 'node:path';

const mocks = vi.hoisted(() => ({ rows: vi.fn(), setting: vi.fn(), slack: vi.fn() }));
vi.mock('../../docker/volumes/functions/slack-interact/backend.ts', () => ({
  Database: class { rows = mocks.rows; setting = mocks.setting; }, slackClient: () => mocks.slack,
}));
const issue = createQaIssue({ projectId: 'p1', title: 'Initial', actual: 'Failure', observedEnvironment: 'Stage' }, 'qa1', {
  actor: { id: 'm1', role: 'member' }, workspaceId: 'default', now: '2026-10-02T00:00:00Z', newId: () => 'id',
  memberIds: new Set(['m1']), projectIds: new Set(['p1']), taskIds: new Set(),
});
const env = { get: () => 'https://app.test' };
beforeEach(() => {
  vi.clearAllMocks();
  mocks.setting.mockResolvedValue({ qa: true, slackActions: true });
  mocks.slack.mockImplementation(async method => method === 'auth.test' ? { team_id: 'T1' } : { ok: true });
});
describe('Docker QA Slack card ordering', () => {
  it('repairs a stale write when a newer issue version commits while chat.update is in flight', async () => {
    const versions = [1, 1, 2, 2, 2];
    mocks.rows.mockImplementation(async table => table === 'qa_slack_links' ? [{ team_id: 'T1', channel_id: 'C1', card_ts: '1.1' }]
      : [{ data: { ...issue, version: versions.shift() || 2, title: versions.length >= 3 ? 'Old title' : 'New title' } }]);
    await syncQaSlackIssue(env, issue);
    const updates = mocks.slack.mock.calls.filter(call => call[0] === 'chat.update');
    expect(updates).toHaveLength(2);
    expect(updates[1][1].text).toBe('Bug · New title');
  });
  it('bounds continuously changing cards to three writes and reports retry needed', async () => {
    let version = 0;
    mocks.rows.mockImplementation(async table => table === 'qa_slack_links' ? [{ team_id: 'T1', channel_id: 'C1', card_ts: '1.1' }]
      : [{ data: { ...issue, version: ++version } }]);
    await expect(syncQaSlackIssue(env, issue)).rejects.toThrow('retry required');
    expect(mocks.slack.mock.calls.filter(call => call[0] === 'chat.update')).toHaveLength(3);
  });
  it('does not send when QA or Slack is disabled', async () => {
    mocks.setting.mockResolvedValue({ qa: false, slackActions: true });
    await syncQaSlackIssue(env, issue);
    expect(mocks.rows).not.toHaveBeenCalled(); expect(mocks.slack).not.toHaveBeenCalled();
  });
  it('does not send a private issue to a stored link for another Slack team', async () => {
    mocks.rows.mockImplementation(async table => table === 'qa_slack_links' ? [{ team_id: 'T2', channel_id: 'C2', card_ts: '1.2' }] : [{ data: issue }]);
    await syncQaSlackIssue(env, issue);
    expect(mocks.slack.mock.calls.some(call => call[0] === 'chat.update')).toBe(false);
  });
  it('renders the company status label on refreshed Slack cards', async () => {
    mocks.setting.mockImplementation(async key => key === 'feature_toggles' ? { qa: true, slackActions: true }
      : { version: 1, order: ['new', 'triaged', 'in_progress', 'verification', 'closed'],
        labels: { new: '待判斷', triaged: '', in_progress: '', verification: '', closed: '' } });
    mocks.rows.mockImplementation(async table => table === 'qa_slack_links' ? [{ team_id: 'T1', channel_id: 'C1', card_ts: '1.1' }] : [{ data: issue }]);
    await syncQaSlackIssue(env, issue);
    const update = mocks.slack.mock.calls.find(call => call[0] === 'chat.update');
    expect(JSON.stringify(update?.[1].blocks)).toContain('待判斷');
    expect(issue.state).toBe('new');
  });
});

describe('Docker QA durable inbox migration contract', () => {
  const sql = fs.readFileSync(path.resolve(__dirname, '../../supabase/migrations/20261002_qa_workflow.sql'), 'utf8');
  it('leases a bounded pending batch and keeps retry payloads outside backups', () => {
    expect(sql).toContain('LIMIT 20 FOR UPDATE SKIP LOCKED');
    expect(sql).toContain("lease_until=now()+interval '2 minutes'");
    expect(sql).toContain("created_at<now()-interval '30 days'");
    expect(sql).toContain("state='done',payload='{}'::jsonb");
    const backup = fs.readFileSync(path.resolve(__dirname, '../../docker/volumes/functions/scheduled-backup/index.ts'), 'utf8');
    expect(backup).not.toContain("'qa_slack_inbox'");
    expect(backup).not.toContain("'qa_slack_receipts'");
  });
});
