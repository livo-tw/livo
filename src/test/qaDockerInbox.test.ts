// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { createQaSlackActions } from '../../docker/volumes/functions/qa/slackAdapter';
import type { Actions } from '../../docker/volumes/functions/slack-interact/handler';

const mocks = vi.hoisted(() => ({ request: vi.fn(), rows: vi.fn(), setting: vi.fn(), session: vi.fn() }));
vi.mock('../../docker/volumes/functions/slack-interact/backend.ts', () => ({
  Database: class { constructor(_env: unknown, jwt?: string) { mocks.session(jwt); } request = mocks.request; rows = mocks.rows; setting = mocks.setting; },
}));
vi.mock('../../docker/volumes/functions/qa/service.ts', () => ({ createQaService: () => ({ handle: vi.fn() }) }));
vi.mock('../../docker/volumes/functions/qa/slackSync.ts', () => ({ syncQaSlackIssue: vi.fn(), qaSlackLink: () => 'https://app.test/?qa=one' }));
const env = { get: () => '' };
let slack: ReturnType<typeof vi.fn>;
beforeEach(() => {
  vi.clearAllMocks();
  slack = vi.fn(async () => ({ team_id: 'T-allowed' }));
  mocks.setting.mockResolvedValue({ qa: true, slackActions: true });
  mocks.rows.mockResolvedValue([{ issue_id: 'qa1' }]);
  mocks.request.mockImplementation(async (endpoint: string, _method: string, body: { p_id?: string }) =>
    endpoint.endsWith('livo_qa_slack_enqueue') ? body.p_id : endpoint.endsWith('livo_qa_slack_pending') ? [{ id: 'leased-id', payload: { event_id: 'event-1' } }] : null);
});
const adapter = () => createQaSlackActions(env, { slack, reply: vi.fn(), background: vi.fn() } as unknown as Actions);
describe('Docker QA Slack durable inbox adapter', () => {
  it('filters project search at the server before applying the 100-option limit', async () => {
    mocks.rows.mockImplementation(async (table: string) => table === 'product_lines' ? [{id:'l',name:'Product line',icon:'🐟'}] : [{id:'project-101',name:'Zebra',line_id:'l'}]);
    const actor = {id:'m',role:'member' as const,team:'T-allowed',slack_user:'U1',jwt:'member-session'};
    expect(await adapter().projects(actor,'Zebra')).toEqual([{line:{id:'l',name:'Product line',icon:'🐟'},projects:[{id:'project-101',name:'Zebra',lineId:'l'}]}]);
    expect(mocks.rows).toHaveBeenCalledWith('projects',expect.objectContaining({select:'id,name,line_id',name:'ilike.%Zebra%',is_archived:'eq.false',limit:'100'}));
    expect(mocks.rows).toHaveBeenCalledWith('product_lines',expect.objectContaining({order:'sort_order,id'}));
    expect(mocks.session).toHaveBeenLastCalledWith('member-session');
  });
  it('rejects wrong Slack team before persisting the payload', async () => {
    await expect(adapter().enqueueEvent({ event_id: 'event-1', team_id: 'T-other' })).rejects.toThrow('workspace mismatch');
    expect(mocks.request).not.toHaveBeenCalled();
  });
  it('rejects an event without a verified team', async () => {
    await expect(adapter().enqueueEvent({ event_id: 'event-1' })).rejects.toThrow('workspace mismatch');
    expect(mocks.request).not.toHaveBeenCalled();
  });
  it('retries the same event with the same durable ID and caches auth.test for this request', async () => {
    const qa = adapter(), payload = { event_id: 'event-1', team_id: 'T-allowed', event: { channel: 'C1', thread_ts: '1.1', text: 'QA reply' } };
    expect(await qa.enqueueEvent(payload)).toBe(await qa.enqueueEvent(payload));
    expect(slack).toHaveBeenCalledTimes(1);
    expect(mocks.request.mock.calls.map(call => call[2].p_payload)).toEqual([payload, payload]);
  });
  it('does not retain an ordinary unlinked Slack thread', async () => {
    mocks.rows.mockResolvedValueOnce([]);
    expect(await adapter().enqueueEvent({ event_id: 'ordinary-1', team_id: 'T-allowed', event: { channel: 'C1', thread_ts: '9.9', text: 'Private ordinary conversation' } })).toBe('');
    expect(mocks.rows).toHaveBeenCalledWith('qa_slack_links', { select: 'issue_id', workspace_id: 'eq.default',
      team_id: 'eq.T-allowed', channel_id: 'eq.C1', thread_ts: 'eq.9.9', limit: '1' });
    expect(mocks.request).not.toHaveBeenCalled();
  });
  it('does not retain a message without a thread', async () => {
    expect(await adapter().enqueueEvent({ event_id: 'ordinary-2', team_id: 'T-allowed', event: { channel: 'C1', text: 'Ordinary message' } })).toBe('');
    expect(mocks.rows).not.toHaveBeenCalled(); expect(mocks.request).not.toHaveBeenCalled();
  });
  it('obtains server-leased pending items and completes by the durable ID', async () => {
    const qa = adapter();
    expect(await qa.pendingEvents()).toEqual([{ id: 'leased-id', payload: { event_id: 'event-1' } }]);
    await qa.completeEvent('leased-id');
    expect(mocks.request).toHaveBeenLastCalledWith('/rest/v1/rpc/livo_qa_slack_complete', 'POST', { p_id: 'leased-id' });
  });
});

describe('Docker QA inbox/release persistence contract', () => {
  const migration = fs.readFileSync(path.resolve(__dirname, '../../supabase/migrations/20261002_qa_workflow.sql'), 'utf8');
  it('deduplicates primary IDs and retains bounded operational retry state', () => {
    const inbox = migration.slice(migration.indexOf('CREATE OR REPLACE FUNCTION public.livo_qa_slack_enqueue'));
    expect(inbox).toContain('ON CONFLICT(id) DO NOTHING');
    expect(inbox.match(/DELETE FROM public\.qa_slack_inbox WHERE workspace_id='default' AND created_at<now\(\)-interval '30 days'/g)).toHaveLength(2);
    expect(inbox).toContain('LIMIT 20 FOR UPDATE SKIP LOCKED');
    expect(inbox).toContain('LEAST(3600,30*power(2,LEAST(q.attempts,7)))');
    expect(inbox).toContain('FROM PUBLIC,anon,authenticated');
  });
  it('packages the optional Slack manifest, guide, and required QA runtime', () => {
    const release = fs.readFileSync(path.resolve(__dirname, '../../scripts/build-release.mjs'), 'utf8');
    expect(release).toContain("path.join(TEMPLATE_DIR, 'slack-qa-manifest.json')");
    expect(release).toContain("path.join(APP_ROOT, 'QA-WORKFLOW.md')");
    expect(release).toContain('`volumes/functions/qa/${file}`');
    expect(release).toContain("'restore.ts', 'slack.ts', 'slackAdapter.ts', 'slackSync.ts'");
    expect(release).toContain("'domain.ts', 'workflow.ts', 'service.ts'");
  });
});
